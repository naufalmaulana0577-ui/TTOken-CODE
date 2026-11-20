//! WebSockets from the page to the Host, authorized by one-time tickets (decision D5).
//!
//! The Electron shell adds the Host cookie to the page's WebSocket handshake with `webRequest`; WebView2 and
//! WKWebView offer no equivalent. Instead the page asks the shell for a ticket before each connection and opens the
//! socket to this relay with `ttoken_ticket=<ticket>` in the query. The relay accepts the handshake only from the
//! application origin with an unused, unexpired ticket, then rewrites it the way the Electron shell does: the
//! Host's own origin, the Host cookie, and `sec-fetch-site: same-origin`. After the handshake it copies bytes in
//! both directions. The Host itself is unchanged.

use crate::host::HostHandle;
use crate::timeline::Timeline;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// Query parameter carrying the ticket.
const TICKET_PARAMETER: &str = "ttoken_ticket";
/// A ticket is issued immediately before its connection opens.
const TICKET_LIFETIME: Duration = Duration::from_secs(30);
/// Longest accepted handshake; browsers send well under 4 KiB.
const MAX_HEAD_BYTES: usize = 16 * 1024;
/// Time a client has to send its handshake.
const HEAD_DEADLINE: Duration = Duration::from_secs(10);
/// Handshake headers the relay replaces.
const REPLACED_HEADERS: [&str; 4] = ["host", "origin", "cookie", "sec-fetch-site"];

/// Issued tickets and their expiry.
#[derive(Default)]
pub struct Tickets {
    issued: Mutex<HashMap<String, Instant>>,
}

impl Tickets {
    /// Issue a ticket for one connection.
    pub fn issue(&self) -> String {
        let ticket = crate::token::random_token();
        let now = Instant::now();
        let mut issued = self.issued.lock().unwrap_or_else(PoisonError::into_inner);
        issued.retain(|_, expiry| *expiry > now);
        issued.insert(ticket.clone(), now + TICKET_LIFETIME);
        ticket
    }

    /// Consume a ticket; true when it was issued, unused, and unexpired.
    pub fn redeem(&self, ticket: &str) -> bool {
        let removed = self
            .issued
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(ticket);
        removed.is_some_and(|expiry| expiry > Instant::now())
    }
}

/// What the relay checks handshakes against, and where it records them.
pub struct Relay {
    host: Arc<HostHandle>,
    tickets: Arc<Tickets>,
    /// Serialized application origin the page's handshakes must carry.
    origin: &'static str,
    timeline: Arc<Timeline>,
    relayed_once: AtomicBool,
}

impl Relay {
    /// Relay for `host`, accepting tickets from `tickets` and handshakes from `origin`.
    pub fn new(host: Arc<HostHandle>, tickets: Arc<Tickets>, origin: &'static str, timeline: Arc<Timeline>) -> Self {
        Self {
            host,
            tickets,
            origin,
            timeline,
            relayed_once: AtomicBool::new(false),
        }
    }
}

/// Accept and relay connections until the listener fails.
pub async fn serve(listener: tokio::net::TcpListener, relay: Arc<Relay>) {
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let relay = Arc::clone(&relay);
                tauri::async_runtime::spawn(async move {
                    let mut client = stream;
                    if let Err(refusal) = forward(&mut client, &relay).await {
                        relay
                            .timeline
                            .mark("socket-refused", refusal.lines().next().unwrap_or_default());
                        // The client may already be gone; there is nobody else to tell.
                        drop(client.write_all(refusal.as_bytes()).await);
                    }
                });
            }
            // Transient accept failures (file descriptor pressure) should not end the relay.
            Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }
}

const BAD_REQUEST: &str = "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
const UNAUTHORIZED: &str = "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
const FORBIDDEN: &str = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
const BAD_GATEWAY: &str = "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
const UNAVAILABLE: &str = "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

async fn forward(client: &mut TcpStream, relay: &Relay) -> Result<(), &'static str> {
    let buffer = tokio::time::timeout(HEAD_DEADLINE, read_head(client))
        .await
        .map_err(|_| BAD_REQUEST)??;
    let mut parsed = [httparse::EMPTY_HEADER; 64];
    let mut request = httparse::Request::new(&mut parsed);
    let head_length = match request.parse(&buffer) {
        Ok(httparse::Status::Complete(length)) => length,
        _ => return Err(BAD_REQUEST),
    };
    let header = |name: &str| {
        request
            .headers
            .iter()
            .find(|header| header.name.eq_ignore_ascii_case(name))
            .map(|header| header.value)
    };
    let upgrade = header("upgrade").is_some_and(|value| value.eq_ignore_ascii_case(b"websocket"));
    if request.method != Some("GET") || !upgrade {
        return Err(BAD_REQUEST);
    }
    if header("origin") != Some(relay.origin.as_bytes()) {
        return Err(FORBIDDEN);
    }
    let (path, ticket) = split_ticket(request.path.ok_or(BAD_REQUEST)?).ok_or(UNAUTHORIZED)?;
    if !relay.tickets.redeem(&ticket) {
        return Err(UNAUTHORIZED);
    }
    let ready = relay.host.current().ok_or(UNAVAILABLE)?;
    let authority = format!(
        "{}:{}",
        ready.url.host_str().ok_or(BAD_GATEWAY)?,
        ready.url.port().ok_or(BAD_GATEWAY)?
    );
    let mut head = format!(
        "GET {path} HTTP/1.1\r\nHost: {authority}\r\nOrigin: http://{authority}\r\nCookie: {}\r\nSec-Fetch-Site: same-origin\r\n",
        ready.cookie
    )
    .into_bytes();
    for header in request.headers.iter() {
        if !REPLACED_HEADERS
            .iter()
            .any(|name| header.name.eq_ignore_ascii_case(name))
        {
            head.extend_from_slice(header.name.as_bytes());
            head.extend_from_slice(b": ");
            head.extend_from_slice(header.value);
            head.extend_from_slice(b"\r\n");
        }
    }
    head.extend_from_slice(b"\r\n");
    head.extend_from_slice(&buffer[head_length..]);
    let mut upstream = TcpStream::connect(authority.as_str()).await.map_err(|_| BAD_GATEWAY)?;
    upstream.write_all(&head).await.map_err(|_| BAD_GATEWAY)?;
    if !relay.relayed_once.swap(true, Ordering::Relaxed) {
        relay.timeline.mark("socket-relayed", &path);
    }
    // Either side closing ends the relay; the WebSocket peers own close codes and errors.
    drop(tokio::io::copy_bidirectional(client, &mut upstream).await);
    Ok(())
}

async fn read_head(client: &mut TcpStream) -> Result<Vec<u8>, &'static str> {
    let mut buffer = Vec::with_capacity(4096);
    let mut chunk = [0_u8; 4096];
    loop {
        let read = client.read(&mut chunk).await.map_err(|_| BAD_REQUEST)?;
        if read == 0 {
            return Err(BAD_REQUEST);
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
            return Ok(buffer);
        }
        if buffer.len() > MAX_HEAD_BYTES {
            return Err(BAD_REQUEST);
        }
    }
}

/// Remove the ticket parameter from a request target, keeping every other byte of it unchanged.
fn split_ticket(target: &str) -> Option<(String, String)> {
    let (path, query) = target.split_once('?')?;
    let mut ticket = None;
    let mut kept = Vec::new();
    for pair in query.split('&') {
        match pair
            .strip_prefix(TICKET_PARAMETER)
            .and_then(|rest| rest.strip_prefix('='))
        {
            Some(value) if ticket.is_none() => ticket = Some(value.to_owned()),
            Some(_) => return None,
            None => kept.push(pair),
        }
    }
    let target = if kept.is_empty() {
        path.to_owned()
    } else {
        format!("{path}?{}", kept.join("&"))
    };
    Some((target, ticket?))
}

#[cfg(test)]
mod tests {
    use super::{Tickets, split_ticket};

    #[test]
    fn tickets_are_single_use() {
        let tickets = Tickets::default();
        let ticket = tickets.issue();
        assert!(!tickets.redeem("unknown"));
        assert!(tickets.redeem(&ticket));
        assert!(!tickets.redeem(&ticket));
    }

    #[test]
    fn splits_the_ticket_from_the_target() {
        assert_eq!(
            split_ticket("/api/ws?ttoken_ticket=abc"),
            Some(("/api/ws".to_owned(), "abc".to_owned()))
        );
        assert_eq!(
            split_ticket("/api/ws?a=1&ttoken_ticket=abc&b=%20"),
            Some(("/api/ws?a=1&b=%20".to_owned(), "abc".to_owned()))
        );
        assert_eq!(split_ticket("/api/ws"), None);
        assert_eq!(split_ticket("/api/ws?a=1"), None);
        assert_eq!(split_ticket("/api/ws?ttoken_ticket=a&ttoken_ticket=b"), None);
    }
}
