//! The `ttoken-app` origin (decision D4): Web client files from the payload, and authenticated forwarding of every
//! other request to the Host.
//!
//! The origin stays the same across launches while the Host port changes, so the page keeps its local storage.
//! Tauri serves custom protocols at `ttoken-app://localhost` on macOS and Linux, and at
//! `http://ttoken-app.localhost` on Windows.

use crate::host::HostHandle;
use std::path::{Component, Path, PathBuf};
use tauri::http::header::{self, HeaderMap, HeaderName, HeaderValue};
use tauri::http::{Request, Response, StatusCode};
use url::Url;

/// Scheme of the application origin.
pub const SCHEME: &str = "ttoken-app";

/// Serialized application origin, as the page reports it in `Origin` headers.
#[cfg(windows)]
pub const ORIGIN: &str = "http://ttoken-app.localhost";
/// Serialized application origin, as the page reports it in `Origin` headers.
#[cfg(not(windows))]
pub const ORIGIN: &str = "ttoken-app://localhost";

/// Inline script the Web entry waits on before it starts; the same document change the Electron shell makes.
const BOOT_GATE: &str = "<script>globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()</script>";

/// Request headers the shell owns or that describe the connection to the shell rather than to the Host.
const DROPPED_REQUEST_HEADERS: [&str; 13] = [
    "host",
    "origin",
    "cookie",
    "sec-fetch-site",
    "accept-encoding",
    "content-length",
    "connection",
    "keep-alive",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

/// Response headers not relayed to the page: `set-cookie` would put the Host credential in the page's cookie jar,
/// and the rest describe the connection between the shell and the Host.
const WITHHELD_RESPONSE_HEADERS: [&str; 11] = [
    "set-cookie",
    "content-encoding",
    "content-length",
    "transfer-encoding",
    "connection",
    "keep-alive",
    "te",
    "trailer",
    "upgrade",
    "proxy-authenticate",
    "proxy-authorization",
];

/// Root document URL of the application origin.
pub fn app_url() -> Url {
    Url::parse(&format!("{ORIGIN}/")).expect("the application origin is a valid URL")
}

/// Whether `url` belongs to the application origin.
pub fn is_app_url(url: &Url) -> bool {
    let origin = app_url();
    url.scheme() == origin.scheme() && url.host_str() == origin.host_str() && url.port() == origin.port()
}

/// Answer one request to the application origin.
pub async fn respond(
    request: Request<Vec<u8>>,
    web_dist: &Path,
    host: &HostHandle,
    http: &reqwest::Client,
) -> Response<Vec<u8>> {
    let path = request.uri().path();
    let is_document_asset = path == "/"
        || path == "/index.html"
        || path.starts_with("/assets/")
        || path == "/favicon.svg"
        || path == "/manifest.webmanifest";
    if is_document_asset {
        return serve_static(&request, web_dist).await;
    }
    forward(request, host, http).await
}

fn status(code: StatusCode) -> Response<Vec<u8>> {
    let mut response = Response::new(Vec::new());
    *response.status_mut() = code;
    response
}

async fn serve_static(request: &Request<Vec<u8>>, root: &Path) -> Response<Vec<u8>> {
    let method = request.method();
    if method != tauri::http::Method::GET && method != tauri::http::Method::HEAD {
        return status(StatusCode::METHOD_NOT_ALLOWED);
    }
    let Ok(path) = percent_encoding::percent_decode_str(request.uri().path()).decode_utf8() else {
        return status(StatusCode::BAD_REQUEST);
    };
    let is_index = path == "/" || path == "/index.html";
    let Some(file) = contained_path(root, if is_index { "index.html" } else { &path }) else {
        return status(StatusCode::FORBIDDEN);
    };
    let body = match tokio::fs::read(&file).await {
        Ok(body) => body,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return status(StatusCode::NOT_FOUND),
        Err(_) => return status(StatusCode::INTERNAL_SERVER_ERROR),
    };
    let body = if is_index {
        String::from_utf8_lossy(&body)
            .replacen("<head>", &format!("<head>{BOOT_GATE}"), 1)
            .into_bytes()
    } else {
        body
    };
    let mut response = Response::new(if method == tauri::http::Method::HEAD {
        Vec::new()
    } else {
        body
    });
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type(&file)));
    response
}

/// Join a request path under `root`, refusing anything that could leave it.
fn contained_path(root: &Path, request_path: &str) -> Option<PathBuf> {
    let relative = Path::new(request_path.trim_start_matches('/'));
    let mut joined = root.to_path_buf();
    for component in relative.components() {
        match component {
            Component::Normal(part) if !part.to_string_lossy().contains(['\\', ':']) => joined.push(part),
            _ => return None,
        }
    }
    (joined != root).then_some(joined)
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("json" | "webmanifest") => "application/json",
        Some("woff2") => "font/woff2",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        _ => "application/octet-stream",
    }
}

async fn forward(request: Request<Vec<u8>>, host: &HostHandle, http: &reqwest::Client) -> Response<Vec<u8>> {
    if let Some(origin) = request.headers().get(header::ORIGIN)
        && origin.as_bytes() != ORIGIN.as_bytes()
    {
        return status(StatusCode::FORBIDDEN);
    }
    let Some(ready) = host.current() else {
        return status(StatusCode::SERVICE_UNAVAILABLE);
    };
    let (parts, body) = request.into_parts();
    let mut target = ready.url.clone();
    target.set_path(parts.uri.path());
    target.set_query(parts.uri.query());
    let mut headers = parts.headers;
    for name in DROPPED_REQUEST_HEADERS {
        headers.remove(name);
    }
    let Ok(cookie) = HeaderValue::from_str(&ready.cookie) else {
        return status(StatusCode::INTERNAL_SERVER_ERROR);
    };
    headers.insert(header::COOKIE, cookie);
    let sent = http
        .request(parts.method, target.as_str())
        .headers(headers)
        .body(body)
        .send()
        .await;
    let Ok(answer) = sent else {
        return status(StatusCode::BAD_GATEWAY);
    };
    let code = answer.status();
    let mut relayed = HeaderMap::new();
    for (name, value) in answer.headers() {
        if !WITHHELD_RESPONSE_HEADERS.contains(&name.as_str()) {
            relayed.append(name.clone(), value.clone());
        }
    }
    // The Host marks plugin bundles immutable under a revision that changes every launch; caching them would only
    // fill the WebView cache with bundles no later launch can use.
    if parts.uri.path().starts_with("/plugins/") {
        relayed.insert(
            HeaderName::from_static("cache-control"),
            HeaderValue::from_static("no-store"),
        );
    }
    let Ok(bytes) = answer.bytes().await else {
        return status(StatusCode::BAD_GATEWAY);
    };
    let mut response = Response::new(bytes.to_vec());
    *response.status_mut() = code;
    *response.headers_mut() = relayed;
    response
}

#[cfg(test)]
mod tests {
    use super::{app_url, contained_path, is_app_url};
    use std::path::Path;
    use url::Url;

    #[test]
    fn keeps_paths_inside_the_web_client() {
        let root = Path::new("/payload/dist");
        assert_eq!(
            contained_path(root, "/assets/index.js"),
            Some(root.join("assets").join("index.js"))
        );
        for escape in ["/../secret", "/assets/../../secret", "/", "/C:/windows", "/a\\b"] {
            assert_eq!(contained_path(root, escape), None, "{escape}");
        }
    }

    #[test]
    fn recognizes_the_application_origin() {
        assert!(is_app_url(&app_url().join("/assets/x.js").expect("join")));
        assert!(!is_app_url(&Url::parse("https://example.com/").expect("url")));
        assert!(!is_app_url(&Url::parse("http://127.0.0.1:4100/").expect("url")));
    }
}
