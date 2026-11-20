//! TTOken Code Desktop shell on Tauri 2.
//!
//! The shell replaces only the Electron parent process. It starts the existing Desktop Host on the bundled Node
//! runtime, serves the existing Web client at the `ttoken-app` origin, forwards the client's HTTP requests to the
//! Host with the startup credential, and relays the client's WebSockets after checking one-time tickets.
//! See `ttoken/docs/PRD-TAURI.md`.

mod host;
mod payload;
mod protocol;
mod socket;
mod timeline;
mod token;

use host::{HostHandle, HostLaunch};
use payload::Payload;
use socket::{Relay, Tickets};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::http::{Response, StatusCode, header};
use tauri::webview::PageLoadEvent;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use timeline::Timeline;

/// Label of the main window; the only window whose page may call the shell commands.
const MAIN_WINDOW: &str = "main";
/// Channel module the Host preloads; see `host/shell-channel.mjs`.
const CHANNEL_MODULE: &str = include_str!("../host/shell-channel.mjs");
/// Page bridge source; see `bridge.js`.
const BRIDGE: &str = include_str!("bridge.js");
/// Environment variable naming the timeline file; measurement scripts set it per run.
const TIMELINE_ENV: &str = "TTOKEN_DESKTOP_TIMELINE";
/// Environment variable that makes the page report when its composer appears and accepts input (`1`); smoke tests
/// set it. Measurement runs leave it unset so both shells are observed the same way.
const MARK_COMPOSER_ENV: &str = "TTOKEN_DESKTOP_MARK_COMPOSER";
/// Page events `desktop_mark` accepts.
const PAGE_EVENTS: [&str; 2] = ["composer-shown", "composer-ready"];
/// Environment variable with a loopback port for WebView2's DevTools protocol; the measurement scripts drive the
/// page through it, as they drive the Electron build through `--remote-debugging-port`.
#[cfg(windows)]
const DEBUG_PORT_ENV: &str = "TTOKEN_DESKTOP_DEBUG_PORT";
/// WebView2 arguments wry uses when none are given; extra arguments replace them, so they are repeated.
#[cfg(windows)]
const WRY_BROWSER_ARGUMENTS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

/// Shell state shared by the protocol handler, the commands, and the exit sequence.
struct Shell {
    /// The running Harness, or why it could not start.
    harness: Result<Harness, String>,
    http: reqwest::Client,
    timeline: Arc<Timeline>,
    /// The exit sequence has started.
    stopping: AtomicBool,
    /// The Host has stopped; the next exit request may proceed.
    stopped: AtomicBool,
}

struct Harness {
    payload: Payload,
    host: Arc<HostHandle>,
    tickets: Arc<Tickets>,
    socket_port: u16,
}

/// Start the shell and block until it exits.
///
/// # Panics
///
/// Panics when Tauri cannot create its event loop.
pub fn run() {
    let timeline = Arc::new(Timeline::start());
    timeline.mark("process-start", &std::process::id().to_string());
    let payload_root = payload_argument();
    let setup_timeline = Arc::clone(&timeline);
    let app = tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol(protocol::SCHEME, |context, request, responder| {
            let shell = context
                .app_handle()
                .try_state::<Arc<Shell>>()
                .map(|state| Arc::clone(&state));
            tauri::async_runtime::spawn(async move {
                let response = match &shell {
                    Some(shell) => match &shell.harness {
                        Ok(harness) => {
                            protocol::respond(request, &harness.payload.web_dist, &harness.host, &shell.http).await
                        }
                        Err(reason) => startup_error_page(request.uri().path(), reason),
                    },
                    None => plain_status(StatusCode::SERVICE_UNAVAILABLE),
                };
                responder.respond(response);
            });
        })
        .invoke_handler(tauri::generate_handler![
            desktop_boot,
            desktop_boot_failed,
            desktop_ws_ticket,
            desktop_mark
        ])
        .setup(move |app| setup(app, setup_timeline, payload_root))
        .build(tauri::generate_context!())
        .expect("cannot create the application event loop");
    app.run(|handle, event| {
        if let RunEvent::ExitRequested { api, .. } = event {
            let Some(shell) = handle.try_state::<Arc<Shell>>().map(|state| Arc::clone(&state)) else {
                return;
            };
            let Ok(harness) = &shell.harness else { return };
            if shell.stopped.load(Ordering::SeqCst) {
                return;
            }
            api.prevent_exit();
            if shell.stopping.swap(true, Ordering::SeqCst) {
                return;
            }
            let host = Arc::clone(&harness.host);
            let handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                host.stop().await;
                shell.stopped.store(true, Ordering::SeqCst);
                shell.timeline.mark("exit", "");
                handle.exit(0);
            });
        }
    });
}

fn setup(
    app: &mut tauri::App,
    timeline: Arc<Timeline>,
    payload_root: Option<PathBuf>,
) -> Result<(), Box<dyn std::error::Error>> {
    let log_directory = app.path().app_log_dir()?;
    let timeline_path = std::env::var_os(TIMELINE_ENV)
        .filter(|value| !value.is_empty())
        .map_or_else(|| log_directory.join("timeline.jsonl"), PathBuf::from);
    if let Err(error) = timeline.open(&timeline_path) {
        eprintln!("ttoken-shell: cannot write {}: {error}", timeline_path.display());
    }
    let harness = start_harness(app, &timeline, payload_root, &log_directory);
    if let Err(reason) = &harness {
        timeline.mark("startup-failed", reason);
    }
    let http = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    app.manage(Arc::new(Shell {
        harness,
        http,
        timeline: Arc::clone(&timeline),
        stopping: AtomicBool::new(false),
        stopped: AtomicBool::new(false),
    }));

    let mark_composer = std::env::var_os(MARK_COMPOSER_ENV).is_some_and(|value| value == "1");
    let bridge = BRIDGE
        .replace("__TTOKEN_APP_ORIGIN__", &serde_json::to_string(protocol::ORIGIN)?)
        .replace("__TTOKEN_MARK_COMPOSER__", if mark_composer { "true" } else { "false" });
    let page_timeline = Arc::clone(&timeline);
    let window = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::CustomProtocol(protocol::app_url()))
        .title("TTOken Code")
        .inner_size(1280.0, 820.0)
        .min_inner_size(520.0, 600.0)
        .background_color(tauri::window::Color(0xf4, 0xef, 0xe4, 0xff))
        .initialization_script(bridge)
        .on_navigation(protocol::is_app_url)
        .on_page_load(move |_, page| {
            let event = match page.event() {
                PageLoadEvent::Started => "page-load-started",
                PageLoadEvent::Finished => "page-load-finished",
            };
            page_timeline.mark(event, page.url().as_str());
        });
    #[cfg(windows)]
    let window = match std::env::var(DEBUG_PORT_ENV)
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
    {
        Some(port) => {
            window.additional_browser_args(&format!("{WRY_BROWSER_ARGUMENTS} --remote-debugging-port={port}"))
        }
        None => window,
    };
    window.build()?;
    timeline.mark("window-created", "");
    Ok(())
}

fn start_harness(
    app: &tauri::App,
    timeline: &Arc<Timeline>,
    payload_root: Option<PathBuf>,
    log_directory: &std::path::Path,
) -> Result<Harness, String> {
    let payload = payload::locate(payload_root)?;
    timeline.mark("payload", &payload.root.display().to_string());
    let channel_module = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join("host")
        .join("shell-channel.mjs");
    write_if_changed(&channel_module, CHANNEL_MODULE)
        .map_err(|error| format!("cannot write {}: {error}", channel_module.display()))?;
    let profile = harness_home(app)?.join("profiles").join("desktop");
    let host = Arc::new(HostHandle::spawn(
        HostLaunch {
            node: payload.node.clone(),
            channel_module,
            entry: payload.host_entry.clone(),
            project: payload.project.clone(),
            profile,
            primary_runtime: payload.primary_runtime.clone(),
            pnpm: payload.pnpm.clone(),
            node_bin: payload.node_bin.clone(),
            client_version: payload.host_version.clone(),
            log: log_directory.join("host.log"),
        },
        Arc::clone(timeline),
    ));
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())?;
    listener.set_nonblocking(true).map_err(|error| error.to_string())?;
    let socket_port = listener.local_addr().map_err(|error| error.to_string())?.port();
    let tickets = Arc::new(Tickets::default());
    let relay = Arc::new(Relay::new(
        Arc::clone(&host),
        Arc::clone(&tickets),
        protocol::ORIGIN,
        Arc::clone(timeline),
    ));
    let relay_timeline = Arc::clone(timeline);
    tauri::async_runtime::spawn(async move {
        match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => socket::serve(listener, relay).await,
            Err(error) => relay_timeline.mark("socket-unavailable", &error.to_string()),
        }
    });
    Ok(Harness {
        payload,
        host,
        tickets,
        socket_port,
    })
}

/// The Harness home, honoring `DSH_HOME` as the Host does; the default is `~/.ttoken-code`.
fn harness_home(app: &tauri::App) -> Result<PathBuf, String> {
    if let Some(configured) = std::env::var_os("DSH_HOME").filter(|value| !value.to_string_lossy().trim().is_empty()) {
        return Ok(PathBuf::from(configured));
    }
    Ok(app
        .path()
        .home_dir()
        .map_err(|error| format!("cannot find the home directory: {error}"))?
        .join(".ttoken-code"))
}

fn write_if_changed(path: &std::path::Path, contents: &str) -> std::io::Result<()> {
    if std::fs::read_to_string(path).is_ok_and(|current| current == contents) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, contents)
}

fn payload_argument() -> Option<PathBuf> {
    let mut arguments = std::env::args_os().skip(1);
    while let Some(argument) = arguments.next() {
        if argument == "--payload" {
            return arguments.next().map(PathBuf::from);
        }
        if let Some(value) = argument.to_str().and_then(|text| text.strip_prefix("--payload=")) {
            return Some(PathBuf::from(value));
        }
    }
    None
}

fn plain_status(code: StatusCode) -> Response<Vec<u8>> {
    let mut response = Response::new(Vec::new());
    *response.status_mut() = code;
    response
}

/// A plain page explaining why the Harness did not start; the Web client cannot load without a payload.
fn startup_error_page(path: &str, reason: &str) -> Response<Vec<u8>> {
    if path != "/" && path != "/index.html" {
        return plain_status(StatusCode::SERVICE_UNAVAILABLE);
    }
    let escaped = reason.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    let page = format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>TTOken Code</title></head>\
         <body style=\"font-family:system-ui,sans-serif;background:#f4efe4;color:#16130d;padding:48px\">\
         <h1 style=\"font-size:20px\">TTOken Code could not start</h1><pre style=\"white-space:pre-wrap\">{escaped}</pre>\
         </body></html>"
    );
    let mut response = Response::new(page.into_bytes());
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("text/html; charset=utf-8"),
    );
    response
}

fn require_main_document(webview: &tauri::Webview) -> Result<(), String> {
    let in_main_document = webview.label() == MAIN_WINDOW && webview.url().is_ok_and(|url| protocol::is_app_url(&url));
    if in_main_document {
        Ok(())
    } else {
        Err("rejected a shell command from outside the main window".to_owned())
    }
}

fn harness(shell: &Shell) -> Result<&Harness, String> {
    shell.harness.as_ref().map_err(Clone::clone)
}

/// Boot facts for the Web entry; the same reply as the Electron shell's `dsh-desktop:boot`.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BootReply {
    injections: serde_json::Value,
    /// Base of the client's WebSocket URLs: the ticket relay, not the Host.
    stream_base_url: String,
}

#[tauri::command]
async fn desktop_boot(webview: tauri::Webview, shell: tauri::State<'_, Arc<Shell>>) -> Result<BootReply, String> {
    require_main_document(&webview)?;
    let harness = harness(&shell)?;
    shell.timeline.mark("boot-requested", "");
    let ready = harness.host.ready().await?;
    shell.timeline.mark("boot-answered", "");
    Ok(BootReply {
        injections: ready.injections.clone(),
        stream_base_url: format!("http://127.0.0.1:{}", harness.socket_port),
    })
}

#[tauri::command]
fn desktop_boot_failed(
    webview: tauri::Webview,
    shell: tauri::State<'_, Arc<Shell>>,
    message: String,
) -> Result<(), String> {
    require_main_document(&webview)?;
    shell.timeline.mark("boot-failed", &message);
    Ok(())
}

#[tauri::command]
fn desktop_ws_ticket(webview: tauri::Webview, shell: tauri::State<'_, Arc<Shell>>) -> Result<String, String> {
    require_main_document(&webview)?;
    Ok(harness(&shell)?.tickets.issue())
}

#[tauri::command]
fn desktop_mark(webview: tauri::Webview, shell: tauri::State<'_, Arc<Shell>>, event: String) -> Result<(), String> {
    require_main_document(&webview)?;
    let event = PAGE_EVENTS
        .into_iter()
        .find(|known| *known == event)
        .ok_or_else(|| format!("unknown page event {event:?}"))?;
    shell.timeline.mark(event, "");
    Ok(())
}
