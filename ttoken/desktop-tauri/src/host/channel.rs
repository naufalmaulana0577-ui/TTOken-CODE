//! Private local socket between the shell and the Host it starts (decision D3).
//!
//! macOS and Linux use a Unix socket in a new directory only the current user can open. Windows uses a named pipe
//! with a random name, one instance, and no remote clients. The shell accepts exactly one connection, then checks
//! that it comes from the Host process it started before any credential crosses the channel.

use tokio::io::{AsyncRead, AsyncWrite};

/// Reading half of an accepted channel.
pub type ChannelRead = Box<dyn AsyncRead + Send + Unpin>;
/// Writing half of an accepted channel.
pub type ChannelWrite = Box<dyn AsyncWrite + Send + Unpin>;

#[cfg(unix)]
pub use unix::Listener;
#[cfg(windows)]
pub use windows::Listener;

fn wrong_peer(peer: Option<u32>, expected: u32) -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::PermissionDenied,
        format!("the channel connection came from process {peer:?}, not the Host process {expected}"),
    )
}

#[cfg(unix)]
mod unix {
    use super::{ChannelRead, ChannelWrite, wrong_peer};
    use std::os::unix::fs::DirBuilderExt;
    use std::path::PathBuf;

    /// A Unix socket in a private directory; both are removed when the listener is dropped.
    pub struct Listener {
        directory: PathBuf,
        path: PathBuf,
        inner: tokio::net::UnixListener,
    }

    impl Listener {
        /// Create the private directory and bind the socket inside it.
        ///
        /// # Errors
        ///
        /// Returns the error from creating the directory or binding the socket.
        pub fn bind() -> std::io::Result<Self> {
            let base = std::env::var_os("XDG_RUNTIME_DIR")
                .map(PathBuf::from)
                .filter(|directory| directory.is_dir())
                .unwrap_or_else(std::env::temp_dir);
            let directory = base.join(format!("ttoken-code-{}", &crate::token::random_token()[..16]));
            std::fs::DirBuilder::new().mode(0o700).create(&directory)?;
            let path = directory.join("host.sock");
            match tokio::net::UnixListener::bind(&path) {
                Ok(inner) => Ok(Self { directory, path, inner }),
                Err(error) => {
                    // Best effort: the directory is empty because the bind failed.
                    drop(std::fs::remove_dir(&directory));
                    Err(error)
                }
            }
        }

        /// Socket path passed to the Host in `TTOKEN_SHELL_CHANNEL`.
        pub fn address(&self) -> String {
            self.path.to_string_lossy().into_owned()
        }

        /// Accept the first connection and require it to come from `expected_pid`.
        ///
        /// # Errors
        ///
        /// Returns the accept error, or `PermissionDenied` when another process connected first.
        pub async fn accept(self, expected_pid: u32) -> std::io::Result<(ChannelRead, ChannelWrite)> {
            let (stream, _) = self.inner.accept().await?;
            let peer = stream.peer_cred()?.pid().and_then(|pid| u32::try_from(pid).ok());
            if peer != Some(expected_pid) {
                return Err(wrong_peer(peer, expected_pid));
            }
            let (read, write) = stream.into_split();
            Ok((Box::new(read), Box::new(write)))
        }
    }

    impl Drop for Listener {
        fn drop(&mut self) {
            // Best effort: a leftover entry is an empty socket in a private temporary directory.
            drop(std::fs::remove_file(&self.path));
            drop(std::fs::remove_dir(&self.directory));
        }
    }
}

#[cfg(windows)]
mod windows {
    use super::{ChannelRead, ChannelWrite, wrong_peer};
    use std::os::windows::io::AsRawHandle;
    use tokio::net::windows::named_pipe::{NamedPipeServer, PipeMode, ServerOptions};
    use windows_sys::Win32::System::Pipes::GetNamedPipeClientProcessId;

    /// A single-instance named pipe with a random name.
    pub struct Listener {
        name: String,
        server: NamedPipeServer,
    }

    impl Listener {
        /// Create the pipe; creation fails if another process already owns the name.
        ///
        /// # Errors
        ///
        /// Returns the error from creating the pipe.
        pub fn bind() -> std::io::Result<Self> {
            let name = format!(r"\\.\pipe\ttoken-code-{}", crate::token::random_token());
            let server = ServerOptions::new()
                .first_pipe_instance(true)
                .reject_remote_clients(true)
                .max_instances(1)
                .pipe_mode(PipeMode::Byte)
                .create(&name)?;
            Ok(Self { name, server })
        }

        /// Pipe name passed to the Host in `TTOKEN_SHELL_CHANNEL`.
        pub fn address(&self) -> String {
            self.name.clone()
        }

        /// Accept the client and require it to be `expected_pid`.
        ///
        /// # Errors
        ///
        /// Returns the connect error, or `PermissionDenied` when another process connected first.
        pub async fn accept(self, expected_pid: u32) -> std::io::Result<(ChannelRead, ChannelWrite)> {
            self.server.connect().await?;
            let mut peer = 0_u32;
            // SAFETY: the handle belongs to `self.server`, which outlives this call, and `peer` is a valid out pointer.
            let succeeded = unsafe { GetNamedPipeClientProcessId(self.server.as_raw_handle(), &raw mut peer) };
            if succeeded == 0 {
                return Err(std::io::Error::last_os_error());
            }
            if peer != expected_pid {
                return Err(wrong_peer(Some(peer), expected_pid));
            }
            let (read, write) = tokio::io::split(self.server);
            Ok((Box::new(read), Box::new(write)))
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::Listener;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn accepts_only_the_expected_process() {
        let listener = Listener::bind().expect("bind");
        let address = listener.address();
        let client = tokio::spawn(async move {
            let mut stream = tokio::net::UnixStream::connect(address).await.expect("connect");
            stream.write_all(b"ping\n").await.expect("write");
            let mut reply = [0_u8; 5];
            stream.read_exact(&mut reply).await.expect("read");
            reply
        });
        let (mut read, mut write) = listener.accept(std::process::id()).await.expect("accept");
        let mut line = [0_u8; 5];
        read.read_exact(&mut line).await.expect("read");
        assert_eq!(&line, b"ping\n");
        write.write_all(b"pong\n").await.expect("write");
        assert_eq!(&client.await.expect("client"), b"pong\n");

        let other = Listener::bind().expect("bind");
        let other_address = other.address();
        let connector = tokio::spawn(async move { tokio::net::UnixStream::connect(other_address).await });
        let refused = other
            .accept(std::process::id() + 1)
            .await
            .err()
            .expect("another process id must be refused");
        assert_eq!(refused.kind(), std::io::ErrorKind::PermissionDenied);
        drop(connector.await);
    }
}
