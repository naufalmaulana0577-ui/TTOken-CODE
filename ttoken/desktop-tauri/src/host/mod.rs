//! Supervisor of the Desktop Host: the Node process that runs the Harness for this shell.
//!
//! The message sequence is the one the Electron shell uses over Node IPC: the Host sends `starting` with its run
//! id, the shell answers `desktop-auth` with a fresh secret, and the Host reports `ready` with its loopback URL and
//! the boot injections of the Web document. `shutdown` asks the Host to stop; it answers `shutdown-complete` and
//! exits. Only the transport differs (see [`channel`]).

mod channel;

use crate::timeline::Timeline;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::sync::watch;
use url::Url;

/// Time the Host has to connect to the channel after it starts.
const CONNECT_DEADLINE: Duration = Duration::from_secs(60);
/// Time the Host has to exit after `shutdown`, as in the Electron shell.
const GRACEFUL_DEADLINE: Duration = Duration::from_secs(10);
/// Longest accepted channel line; the boot injections are the largest message.
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
/// Stderr kept for failure messages, as in the Electron shell.
const MAX_DIAGNOSTIC_CHARS: usize = 64 * 1024;
/// `CREATE_NO_WINDOW`: Node is a console program and would otherwise open a console window.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// First-launch profile creation; see `host/prepare-profile.mjs`.
const PREPARE_PROFILE: &str = include_str!("../../host/prepare-profile.mjs");

/// Everything needed to start one Host process.
#[derive(Debug, Clone)]
pub struct HostLaunch {
    /// Node executable from the bundled runtime.
    pub node: PathBuf,
    /// Channel module preloaded with `--import`.
    pub channel_module: PathBuf,
    /// Desktop Host entry module.
    pub entry: PathBuf,
    /// Project directory holding the Harness packages (the Host's runtime directory argument).
    pub project: PathBuf,
    /// Desktop profile directory, also the Host's working directory.
    pub profile: PathBuf,
    /// Bundled dependency payload.
    pub primary_runtime: PathBuf,
    /// pnpm entry for plugin package operations.
    pub pnpm: PathBuf,
    /// Directory of the `node` launchers for package scripts.
    pub node_bin: PathBuf,
    /// Client version reported to the Host.
    pub client_version: String,
    /// File receiving the Host's stdout and stderr.
    pub log: PathBuf,
}

/// Facts the Host reports when its Web application listens.
#[derive(Debug)]
pub struct HostReady {
    /// Loopback URL of the Host's Web server, always `http://127.0.0.1:<port>/`.
    pub url: Url,
    /// Boot injections the Web document applies before it starts.
    pub injections: serde_json::Value,
    /// Cookie header carrying the startup secret; it never reaches the page.
    pub cookie: String,
}

/// Lifecycle of the supervised Host.
#[derive(Debug, Clone)]
pub enum HostState {
    /// Started, not ready yet.
    Starting,
    /// Serving the Web application.
    Ready(Arc<HostReady>),
    /// Failed; the message is shown to the user and written to the timeline.
    Failed(String),
    /// Stopped on request.
    Stopped,
}

/// Owner of one supervised Host.
pub struct HostHandle {
    state: watch::Receiver<HostState>,
    stop: watch::Sender<bool>,
    supervisor: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl HostHandle {
    /// Start the Host in the background.
    pub fn spawn(launch: HostLaunch, timeline: Arc<Timeline>) -> Self {
        let (state_sender, state) = watch::channel(HostState::Starting);
        let (stop, stop_receiver) = watch::channel(false);
        let supervisor = tauri::async_runtime::spawn(async move {
            let last = match supervise(&launch, &state_sender, stop_receiver, &timeline).await {
                Ok(()) => {
                    timeline.mark("host-stopped", "");
                    HostState::Stopped
                }
                Err(message) => {
                    timeline.mark("host-failed", &message);
                    HostState::Failed(message)
                }
            };
            state_sender.send_replace(last);
        });
        Self {
            state,
            stop,
            supervisor: Mutex::new(Some(supervisor)),
        }
    }

    /// The ready Host, if it is ready now.
    pub fn current(&self) -> Option<Arc<HostReady>> {
        match &*self.state.borrow() {
            HostState::Ready(ready) => Some(Arc::clone(ready)),
            _ => None,
        }
    }

    /// Wait until the Host is ready.
    ///
    /// # Errors
    ///
    /// Returns the Host's failure, or a message when it stopped before becoming ready.
    pub async fn ready(&self) -> Result<Arc<HostReady>, String> {
        let mut state = self.state.clone();
        loop {
            let current = state.borrow_and_update().clone();
            match current {
                HostState::Ready(ready) => return Ok(ready),
                HostState::Failed(message) => return Err(message),
                HostState::Stopped => return Err("the Host has stopped".to_owned()),
                HostState::Starting => {}
            }
            state
                .changed()
                .await
                .map_err(|_| "the Host supervisor ended".to_owned())?;
        }
    }

    /// Ask the Host to stop and wait until its process has exited.
    pub async fn stop(&self) {
        self.stop.send_replace(true);
        let supervisor = self.supervisor.lock().unwrap_or_else(PoisonError::into_inner).take();
        if let Some(supervisor) = supervisor {
            // A panicked supervisor already dropped the child, and `kill_on_drop` ended it.
            drop(supervisor.await);
        }
    }
}

type SharedFile = Arc<Mutex<Option<std::fs::File>>>;

async fn supervise(
    launch: &HostLaunch,
    state: &watch::Sender<HostState>,
    mut stop: watch::Receiver<bool>,
    timeline: &Timeline,
) -> Result<(), String> {
    let listener = channel::Listener::bind().map_err(|error| format!("cannot open the Host channel: {error}"))?;
    let channel_module = Url::from_file_path(&launch.channel_module)
        .map_err(|()| format!("{} is not an absolute path", launch.channel_module.display()))?;
    if !launch.profile.join("package.json").is_file() {
        prepare_profile(launch).await?;
        timeline.mark("profile-created", &launch.profile.display().to_string());
    }
    let log: SharedFile = Arc::new(Mutex::new(open_log(&launch.log)));
    let mut command = tokio::process::Command::new(&launch.node);
    command
        .arg("--expose-internals")
        .arg("--import")
        .arg(channel_module.as_str())
        .arg(&launch.entry)
        .arg(&launch.project)
        .arg(&launch.profile)
        .arg(&launch.primary_runtime)
        .arg(&launch.pnpm)
        .arg(&launch.node_bin)
        .current_dir(&launch.profile)
        .env("TTOKEN_SHELL_CHANNEL", listener.address())
        .env("DSH_CLIENT_VERSION", &launch.client_version)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let mut child = command
        .spawn()
        .map_err(|error| format!("cannot start {}: {error}", launch.node.display()))?;
    let pid = child.id().ok_or("the Host exited while starting")?;
    timeline.mark("host-spawned", &pid.to_string());
    let diagnostic = Arc::new(Mutex::new(String::new()));
    if let Some(stdout) = child.stdout.take() {
        tauri::async_runtime::spawn(copy_output(stdout, Arc::clone(&log), None));
    }
    if let Some(stderr) = child.stderr.take() {
        tauri::async_runtime::spawn(copy_output(stderr, Arc::clone(&log), Some(Arc::clone(&diagnostic))));
    }

    let (reader, mut writer) = tokio::select! {
        accepted = listener.accept(pid) => accepted.map_err(|error| format!("Host channel: {error}"))?,
        status = child.wait() => return Err(exit_message("before it connected", status, &diagnostic)),
        () = tokio::time::sleep(CONNECT_DEADLINE) => {
            return Err(format!("the Host did not connect within {} seconds", CONNECT_DEADLINE.as_secs()));
        }
    };
    let secret = crate::token::random_token();
    let mut lines = LineReader::new(reader);
    let mut authenticated = false;
    loop {
        tokio::select! {
            line = lines.next_line() => {
                let Some(line) = line? else {
                    return Err(match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
                        Ok(status) => exit_message("after closing its channel", status, &diagnostic),
                        Err(_) => "the Host closed its channel".to_owned(),
                    });
                };
                let event = parse_event(&line)?;
                match event {
                    HostEvent::Starting(run_id) => {
                        if !authenticated {
                            authenticated = true;
                            timeline.mark("host-starting", &run_id);
                            let message = serde_json::json!({ "type": "desktop-auth", "secret": secret });
                            send(&mut writer, &message).await?;
                        }
                    }
                    HostEvent::Ready { url, injections } => {
                        if !authenticated {
                            return Err("the Host became ready before the authentication handoff".to_owned());
                        }
                        timeline.mark("host-ready", url.as_str());
                        let cookie = format!("dsh-desktop-session={secret}");
                        state.send_replace(HostState::Ready(Arc::new(HostReady { url, injections, cookie })));
                    }
                    HostEvent::Fatal { message, diagnostic: details } => {
                        write_log(&log, details.as_deref().unwrap_or(&message));
                        return Err(format!("the Host failed: {message}"));
                    }
                    HostEvent::ShutdownComplete => {
                        return Err("the Host acknowledged a shutdown nobody requested".to_owned());
                    }
                    HostEvent::Ignored => {}
                }
            }
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() {
                    break;
                }
            }
            status = child.wait() => return Err(exit_message("unexpectedly", status, &diagnostic)),
        }
    }

    // Graceful stop: the Host drains its work, acknowledges, and exits; escalate after the deadline.
    timeline.mark("host-stopping", "");
    let requested = send(&mut writer, &serde_json::json!({ "type": "shutdown" })).await;
    if requested.is_ok() {
        let deadline = tokio::time::sleep(GRACEFUL_DEADLINE);
        tokio::pin!(deadline);
        let mut open = true;
        loop {
            tokio::select! {
                line = lines.next_line(), if open => {
                    match line {
                        Ok(Some(line)) => {
                            if matches!(parse_event(&line), Ok(HostEvent::ShutdownComplete)) {
                                timeline.mark("host-shutdown-complete", "");
                            }
                        }
                        Ok(None) | Err(_) => open = false,
                    }
                }
                status = child.wait() => {
                    timeline.mark("host-exited", &format!("{status:?}"));
                    return Ok(());
                }
                () = &mut deadline => break,
            }
        }
    }
    timeline.mark("host-killed", "");
    child
        .kill()
        .await
        .map_err(|error| format!("cannot stop the Host: {error}"))
}

/// Create the Desktop profile with the payload's own profile code, as the Electron shell does on first launch.
async fn prepare_profile(launch: &HostLaunch) -> Result<(), String> {
    let mut command = tokio::process::Command::new(&launch.node);
    command
        .arg("--input-type=module")
        .arg("--eval")
        .arg(PREPARE_PROFILE)
        .arg(&launch.profile)
        .current_dir(&launch.project)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command
        .output()
        .await
        .map_err(|error| format!("cannot start {}: {error}", launch.node.display()))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "cannot create the Desktop profile in {} ({}): {}",
            launch.profile.display(),
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

/// One validated message from the Host.
#[derive(Debug, PartialEq)]
enum HostEvent {
    Starting(String),
    Ready {
        url: Url,
        injections: serde_json::Value,
    },
    Fatal {
        message: String,
        diagnostic: Option<String>,
    },
    ShutdownComplete,
    /// Valid, but not used by this shell yet: plugin operation records, Platform sessions, and answers to
    /// requests the shell does not send.
    Ignored,
}

fn parse_event(line: &str) -> Result<HostEvent, String> {
    let message: serde_json::Value =
        serde_json::from_str(line).map_err(|_| "the Host sent a line that is not JSON".to_owned())?;
    let field = |name: &str| message.get(name).and_then(serde_json::Value::as_str);
    let kind = field("type").unwrap_or_default();
    let invalid = || format!("the Host sent an invalid {kind:?} event");
    match kind {
        "starting" => field("runId")
            .filter(|run_id| is_uuid(run_id))
            .map(|run_id| HostEvent::Starting(run_id.to_owned()))
            .ok_or_else(invalid),
        "ready" => {
            let url = field("url").and_then(owned_host_url).ok_or_else(invalid)?;
            let injections = message
                .get("injections")
                .filter(|injections| injections.is_array())
                .cloned()
                .ok_or_else(|| "the Host did not provide boot injections".to_owned())?;
            Ok(HostEvent::Ready { url, injections })
        }
        "fatal" => Ok(HostEvent::Fatal {
            message: field("message").ok_or_else(invalid)?.to_owned(),
            diagnostic: field("diagnostic").map(str::to_owned),
        }),
        "shutdown-complete" => Ok(HostEvent::ShutdownComplete),
        "plugin-operation" | "platform-session" | "update-tasks" | "quit-inspection" | "file-drag-resource" => {
            Ok(HostEvent::Ignored)
        }
        _ => Err(invalid()),
    }
}

fn is_uuid(text: &str) -> bool {
    text.len() == 36
        && text.char_indices().all(|(index, character)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                character == '-'
            } else {
                character.is_ascii_hexdigit()
            }
        })
}

/// Accept only the Host's own loopback root URL, as the Electron shell does.
fn owned_host_url(text: &str) -> Option<Url> {
    let url = Url::parse(text).ok()?;
    let owned = url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none();
    owned.then_some(url)
}

async fn send(writer: &mut channel::ChannelWrite, message: &serde_json::Value) -> Result<(), String> {
    let mut line = message.to_string();
    line.push('\n');
    writer
        .write_all(line.as_bytes())
        .await
        .map_err(|error| format!("cannot write to the Host channel: {error}"))?;
    writer
        .flush()
        .await
        .map_err(|error| format!("cannot write to the Host channel: {error}"))
}

/// Newline-delimited reader whose `next_line` keeps partial input when a `select!` drops it.
struct LineReader {
    inner: channel::ChannelRead,
    buffer: Vec<u8>,
}

impl LineReader {
    fn new(inner: channel::ChannelRead) -> Self {
        Self {
            inner,
            buffer: Vec::new(),
        }
    }

    async fn next_line(&mut self) -> Result<Option<String>, String> {
        loop {
            if let Some(end) = self.buffer.iter().position(|byte| *byte == b'\n') {
                let mut line: Vec<u8> = self.buffer.drain(..=end).collect();
                line.pop();
                return String::from_utf8(line)
                    .map(Some)
                    .map_err(|_| "the Host sent a line that is not UTF-8".to_owned());
            }
            if self.buffer.len() > MAX_LINE_BYTES {
                return Err("the Host sent a line longer than 16 MiB".to_owned());
            }
            let mut chunk = [0_u8; 8192];
            let read = self
                .inner
                .read(&mut chunk)
                .await
                .map_err(|error| format!("cannot read the Host channel: {error}"))?;
            if read == 0 {
                return Ok(None);
            }
            self.buffer.extend_from_slice(&chunk[..read]);
        }
    }
}

fn open_log(path: &std::path::Path) -> Option<std::fs::File> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok()?;
    }
    std::fs::OpenOptions::new().create(true).append(true).open(path).ok()
}

fn write_log(log: &SharedFile, text: &str) {
    use std::io::Write;
    if let Some(file) = log.lock().unwrap_or_else(PoisonError::into_inner).as_mut() {
        // A failed write loses diagnostics only.
        drop(file.write_all(text.as_bytes()));
        drop(file.write_all(b"\n"));
    }
}

async fn copy_output(mut stream: impl AsyncRead + Unpin, log: SharedFile, diagnostic: Option<Arc<Mutex<String>>>) {
    use std::io::Write;
    let mut chunk = vec![0_u8; 8192];
    loop {
        let read = match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(read) => read,
        };
        if let Some(file) = log.lock().unwrap_or_else(PoisonError::into_inner).as_mut() {
            drop(file.write_all(&chunk[..read]));
        }
        if let Some(diagnostic) = &diagnostic {
            let mut text = diagnostic.lock().unwrap_or_else(PoisonError::into_inner);
            text.push_str(&String::from_utf8_lossy(&chunk[..read]));
            if text.len() > MAX_DIAGNOSTIC_CHARS {
                let mut cut = text.len() - MAX_DIAGNOSTIC_CHARS;
                while !text.is_char_boundary(cut) {
                    cut += 1;
                }
                text.drain(..cut);
            }
        }
    }
}

fn exit_message(
    phase: &str,
    status: std::io::Result<std::process::ExitStatus>,
    diagnostic: &Arc<Mutex<String>>,
) -> String {
    let status = status.map_or_else(|error| error.to_string(), |status| status.to_string());
    let stderr = diagnostic.lock().unwrap_or_else(PoisonError::into_inner);
    let stderr = stderr.trim();
    if stderr.is_empty() {
        format!("the Host exited {phase} ({status})")
    } else {
        format!("the Host exited {phase} ({status}): {stderr}")
    }
}

#[cfg(test)]
mod tests {
    use super::{HostEvent, owned_host_url, parse_event};

    #[test]
    fn accepts_the_electron_message_set() {
        assert_eq!(
            parse_event(r#"{"type":"starting","runId":"0a4b2a6e-1c8f-4b4e-9e43-5f0d8b6a7c21"}"#),
            Ok(HostEvent::Starting("0a4b2a6e-1c8f-4b4e-9e43-5f0d8b6a7c21".to_owned()))
        );
        assert!(matches!(
            parse_event(r#"{"type":"ready","url":"http://127.0.0.1:4100/","injections":[]}"#),
            Ok(HostEvent::Ready { .. })
        ));
        assert_eq!(
            parse_event(r#"{"type":"plugin-operation","record":{}}"#),
            Ok(HostEvent::Ignored)
        );
        assert_eq!(
            parse_event(r#"{"type":"shutdown-complete"}"#),
            Ok(HostEvent::ShutdownComplete)
        );
    }

    #[test]
    fn rejects_invalid_messages() {
        assert!(parse_event(r#"{"type":"starting","runId":"not-a-uuid"}"#).is_err());
        assert!(parse_event(r#"{"type":"ready","url":"http://127.0.0.1:4100/","injections":{}}"#).is_err());
        assert!(parse_event(r#"{"type":"surprise"}"#).is_err());
        assert!(parse_event("not json").is_err());
    }

    #[test]
    fn owns_only_the_loopback_root_url() {
        assert!(owned_host_url("http://127.0.0.1:4100/").is_some());
        for rejected in [
            "http://localhost:4100/",
            "http://127.0.0.1/",
            "http://127.0.0.1:4100/api",
            "http://user@127.0.0.1:4100/",
            "http://127.0.0.1:4100/?x=1",
            "ftp://127.0.0.1:4100/",
        ] {
            assert!(owned_host_url(rejected).is_none(), "{rejected}");
        }
    }
}
