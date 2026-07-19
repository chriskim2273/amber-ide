//! Cross-platform local-socket transport for the daemon <-> client channel.
//!
//! One thin abstraction (`LocalListener` / `LocalStream` split into
//! `LocalReader` + `LocalWriter`) over two backends, selected by `#[cfg]`:
//!
//! - **Unix** (`std::os::unix::net`): unchanged from the original daemon —
//!   same stale-socket steal-guard, same `SO_SNDTIMEO` laggard eviction. The
//!   hardened Linux/macOS path is preserved verbatim, not rewritten.
//! - **Windows** (`interprocess` named pipes): the socket "path" is a
//!   `\\.\pipe\...` name. Named pipes have no `SO_SNDTIMEO`, so
//!   `set_write_timeout` is a no-op there; the daemon's bounded per-subscriber
//!   queues + handle close on eviction are the laggard defense (spec §D1).
//!
//! The wire protocol (`amber_core::proto`, length-prefixed frames) rides this
//! unchanged — only the listener/stream *type* differs across platforms
//! (core rule #4: raw bytes, one emulator).

use std::io;
use std::path::Path;
use std::time::Duration;

pub use imp::{LocalListener, LocalReader, LocalStream, LocalWriter};

/// Connect to the daemon at `path` (a unix socket path, or a `\\.\pipe\...`
/// name on Windows).
pub fn connect(path: &Path) -> io::Result<LocalStream> {
    imp::connect(path)
}

/// Bind the daemon's listener at `path`, handling a leftover from a previous
/// run safely (never stealing a *live* daemon's endpoint).
pub fn bind(path: &Path) -> anyhow::Result<LocalListener> {
    imp::bind(path)
}

#[cfg(unix)]
mod imp {
    use super::*;
    use std::io::{Read, Write};
    use std::net::Shutdown;
    use std::os::unix::net::{UnixListener, UnixStream};

    /// Owns the accept endpoint.
    #[derive(Debug)]
    pub struct LocalListener(UnixListener);
    /// A freshly accepted / connected duplex stream, before splitting.
    pub struct LocalStream(UnixStream);
    /// Read half.
    pub struct LocalReader(UnixStream);
    /// Write half (shared, mutex-guarded by callers).
    pub struct LocalWriter(UnixStream);

    pub fn connect(path: &Path) -> io::Result<LocalStream> {
        Ok(LocalStream(UnixStream::connect(path)?))
    }

    /// Bind with the stale-socket steal-guard (spec / daemon.rs original):
    /// - nothing there -> bind;
    /// - a live socket (a daemon answers connect) -> error, never unlink it;
    /// - a stale socket file (connect refused) -> remove it and bind.
    pub fn bind(path: &Path) -> anyhow::Result<LocalListener> {
        if path.exists() {
            match UnixStream::connect(path) {
                Ok(_) => {
                    anyhow::bail!("another daemon is already listening on {}", path.display())
                }
                Err(_) => std::fs::remove_file(path)?,
            }
        }
        Ok(LocalListener(UnixListener::bind(path)?))
    }

    impl LocalListener {
        pub fn incoming(&self) -> impl Iterator<Item = io::Result<LocalStream>> + '_ {
            self.0.incoming().map(|r| r.map(LocalStream))
        }
    }

    impl LocalStream {
        /// Split into an owned read half and an owned write half (the write
        /// half is wrapped in `Arc<Mutex<_>>` by callers as the shared writer).
        pub fn into_split(self) -> io::Result<(LocalReader, LocalWriter)> {
            let w = self.0.try_clone()?;
            Ok((LocalReader(self.0), LocalWriter(w)))
        }

        /// A second independent write handle (used by test harnesses).
        pub fn try_clone_writer(&self) -> io::Result<LocalWriter> {
            Ok(LocalWriter(self.0.try_clone()?))
        }
    }

    impl LocalWriter {
        pub fn set_write_timeout(&self, d: Option<Duration>) -> io::Result<()> {
            self.0.set_write_timeout(d)
        }

        /// Sever the stream in both directions — used to evict a wedged client
        /// so later writes fail fast instead of blocking.
        pub fn shutdown(&self) -> io::Result<()> {
            self.0.shutdown(Shutdown::Both)
        }

        /// Test/interop helper (Unix only): wrap a raw unix stream as a writer,
        /// so unit tests can build a `LocalWriter` from a `UnixStream::pair()`.
        #[doc(hidden)]
        pub fn from_unix_stream(s: UnixStream) -> Self {
            LocalWriter(s)
        }
    }

    impl Read for LocalStream {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.0.read(buf)
        }
    }
    impl Write for LocalStream {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.write(buf)
        }
        fn flush(&mut self) -> io::Result<()> {
            self.0.flush()
        }
    }
    impl Read for LocalReader {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.0.read(buf)
        }
    }
    impl Write for LocalWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.write(buf)
        }
        fn flush(&mut self) -> io::Result<()> {
            self.0.flush()
        }
    }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use interprocess::local_socket::traits::{Listener as _, Stream as _};
    use interprocess::local_socket::{
        GenericFilePath, ListenerOptions, RecvHalf, SendHalf, Stream, ToFsName,
    };
    use std::io::{Read, Write};

    /// Owns the named-pipe listener.
    pub struct LocalListener(interprocess::local_socket::Listener);

    impl std::fmt::Debug for LocalListener {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("LocalListener(named-pipe)")
        }
    }
    /// A freshly accepted / connected duplex pipe stream, before splitting.
    pub struct LocalStream(Stream);
    /// Read half.
    pub struct LocalReader(RecvHalf);
    /// Write half (shared, mutex-guarded by callers).
    pub struct LocalWriter(SendHalf);

    fn name_of(path: &Path) -> io::Result<interprocess::local_socket::Name<'static>> {
        // The Windows "socket path" is already a `\\.\pipe\...` string
        // (main::default_socket). `GenericFilePath` accepts that form and
        // matches what the Electron client passes to Node `net`.
        let s = path
            .to_str()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "non-UTF8 pipe path"))?
            .to_owned();
        s.to_fs_name::<GenericFilePath>()
    }

    pub fn connect(path: &Path) -> io::Result<LocalStream> {
        Ok(LocalStream(Stream::connect(name_of(path)?)?))
    }

    /// Bind the named pipe. `FILE_FLAG_FIRST_PIPE_INSTANCE` is not exposed by
    /// interprocess's high-level options, so a live daemon is detected by the
    /// create failing (name in use). Unlike a unix socket there is no stale
    /// filesystem file to clean up — a crashed daemon's pipe instances are
    /// reclaimed by the kernel, so create simply succeeds on restart.
    pub fn bind(path: &Path) -> anyhow::Result<LocalListener> {
        let listener = ListenerOptions::new()
            .name(name_of(path)?)
            .create_sync()
            .map_err(|e| anyhow::anyhow!("cannot bind pipe {}: {e}", path.display()))?;
        Ok(LocalListener(listener))
    }

    impl LocalListener {
        pub fn incoming(&self) -> impl Iterator<Item = io::Result<LocalStream>> + '_ {
            std::iter::from_fn(move || Some(self.0.accept().map(LocalStream)))
        }
    }

    impl LocalStream {
        pub fn into_split(self) -> io::Result<(LocalReader, LocalWriter)> {
            let (r, w) = self.0.split();
            Ok((LocalReader(r), LocalWriter(w)))
        }

        pub fn try_clone_writer(&self) -> io::Result<LocalWriter> {
            // interprocess streams are not cloneable; test harnesses that need
            // a second writer are Unix-only. Surface a clear error rather than
            // silently mis-share a pipe handle.
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "try_clone_writer is not supported on Windows named pipes",
            ))
        }
    }

    impl LocalWriter {
        /// Named pipes have no `SO_SNDTIMEO`; eviction is via bounded-queue
        /// drop + handle close (spec §D1). No-op so the shared write path is
        /// identical across platforms.
        pub fn set_write_timeout(&self, _d: Option<Duration>) -> io::Result<()> {
            Ok(())
        }

        /// Best-effort sever. interprocess exposes no explicit shutdown; the
        /// send half closing on drop (when the forwarder exits and the last
        /// `Arc` is released) is the real close. Flush what we can.
        pub fn shutdown(&self) -> io::Result<()> {
            Ok(())
        }
    }

    impl Read for LocalStream {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.0.read(buf)
        }
    }
    impl Write for LocalStream {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.write(buf)
        }
        fn flush(&mut self) -> io::Result<()> {
            self.0.flush()
        }
    }
    impl Read for LocalReader {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.0.read(buf)
        }
    }
    impl Write for LocalWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.write(buf)
        }
        fn flush(&mut self) -> io::Result<()> {
            self.0.flush()
        }
    }
}
