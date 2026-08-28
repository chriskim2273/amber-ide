//! Platform-local byte-stream transport.
//!
//! Unix keeps the daemon's existing Unix-domain socket semantics. Windows uses
//! `interprocess` named-pipe local sockets: `GenericNamespaced` supplies the
//! mandatory local `\\\\.\\pipe\\` prefix, while the listener gets the current
//! user's SID-only DACL and interprocess' first-pipe-instance ownership guard.

use std::io::{self, Read, Write};
use std::path::Path;

#[cfg(unix)]
mod imp {
    use super::*;
    use std::net::Shutdown;
    use std::os::unix::net::{UnixListener, UnixStream};

    /// A local daemon/client byte stream.
    pub struct LocalStream(pub(crate) UnixStream);

    /// The read half of a [`LocalStream`].
    pub struct LocalReader(UnixStream);

    /// The write half of a [`LocalStream`].
    pub struct LocalWriter(Option<UnixStream>);

    /// A listener for local daemon/client byte streams.
    pub struct LocalListener(UnixListener);

    impl LocalListener {
        pub fn accept(&self) -> io::Result<LocalStream> {
            self.0.accept().map(|(stream, _)| LocalStream(stream))
        }
    }

    pub fn bind(path: &Path) -> io::Result<LocalListener> {
        UnixListener::bind(path).map(LocalListener)
    }

    pub fn connect(path: &Path) -> io::Result<LocalStream> {
        UnixStream::connect(path).map(LocalStream)
    }

    impl LocalStream {
        pub fn into_split(self) -> io::Result<(LocalReader, LocalWriter)> {
            let writer = self.0.try_clone()?;
            Ok((LocalReader(self.0), LocalWriter(Some(writer))))
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
            self.0
                .as_mut()
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::BrokenPipe, "local writer is shut down")
                })?
                .write(buf)
        }

        fn flush(&mut self) -> io::Result<()> {
            self.0
                .as_mut()
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::BrokenPipe, "local writer is shut down")
                })?
                .flush()
        }
    }

    impl LocalWriter {
        /// Close both directions so a peer blocked in a read wakes immediately.
        pub fn shutdown(&mut self) -> io::Result<()> {
            match self.0.take() {
                Some(stream) => stream.shutdown(Shutdown::Both),
                None => Ok(()),
            }
        }
    }

    /// In-process Unix stream pair used only by transport parity tests.
    pub fn test_pair() -> io::Result<(LocalStream, LocalStream)> {
        UnixStream::pair().map(|(client, server)| (LocalStream(client), LocalStream(server)))
    }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use interprocess::local_socket::{
        traits::{Listener as _, Stream as _},
        GenericNamespaced, ListenerOptions, ToNsName as _,
    };
    use interprocess::os::windows::{
        local_socket::ListenerOptionsExt as _, security_descriptor::SecurityDescriptor,
    };
    use std::{
        sync::{Arc, Mutex},
        thread,
        time::Duration,
    };
    use widestring::U16CString;
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{
            Authorization::ConvertSidToStringSidW, GetTokenInformation, TokenUser, TOKEN_QUERY,
            TOKEN_USER,
        },
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };

    /// A local named-pipe byte stream.
    pub struct LocalStream(interprocess::local_socket::Stream);

    /// The read half of a [`LocalStream`].
    pub struct LocalReader(Arc<SplitStream>);

    /// The write half of a [`LocalStream`].
    pub struct LocalWriter(Arc<SplitStream>);

    /// A listener for local named-pipe streams.
    pub struct LocalListener(interprocess::local_socket::Listener);

    /// `interprocess::local_socket::Stream` deliberately does not expose its
    /// raw handle. Keep the one public stream behind a short-held lock and use
    /// nonblocking operations while split. This gives `shutdown` ownership of
    /// the only stream handle, so dropping it wakes a peer even if a reader is
    /// waiting between poll attempts.
    struct SplitStream {
        stream: Mutex<Option<interprocess::local_socket::Stream>>,
    }

    impl LocalListener {
        pub fn accept(&self) -> io::Result<LocalStream> {
            self.0.accept().map(LocalStream)
        }
    }

    pub fn bind(path: &Path) -> io::Result<LocalListener> {
        let name = pipe_name(path)?;
        ListenerOptions::new()
            .name(name)
            .security_descriptor(current_user_dacl()?)
            .create_sync()
            .map(LocalListener)
    }

    pub fn connect(path: &Path) -> io::Result<LocalStream> {
        let name = pipe_name(path)?;
        interprocess::local_socket::Stream::connect(name).map(LocalStream)
    }

    impl LocalStream {
        pub fn into_split(self) -> io::Result<(LocalReader, LocalWriter)> {
            self.0.set_nonblocking(true)?;
            let stream = Arc::new(SplitStream {
                stream: Mutex::new(Some(self.0)),
            });
            Ok((LocalReader(Arc::clone(&stream)), LocalWriter(stream)))
        }
    }

    impl Read for LocalStream {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            (&self.0).read(buf)
        }
    }

    impl Write for LocalStream {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            (&self.0).write(buf)
        }

        fn flush(&mut self) -> io::Result<()> {
            (&self.0).flush()
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

    impl LocalWriter {
        /// Drop the only split-stream handle, releasing a blocked peer.
        ///
        /// The public interprocess local-socket enum intentionally hides its
        /// raw named-pipe handle, so this does not rely on an inaccessible enum
        /// variant or raw Win32 handle operation.
        pub fn shutdown(&mut self) -> io::Result<()> {
            self.0.stream.lock().unwrap().take();
            Ok(())
        }
    }

    impl SplitStream {
        fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
            self.with_retry(|stream| (&*stream).read(buf))
        }

        fn write(&self, buf: &[u8]) -> io::Result<usize> {
            self.with_retry(|stream| (&*stream).write(buf))
        }

        fn flush(&self) -> io::Result<()> {
            self.with_retry(|stream| (&*stream).flush())
        }

        fn with_retry<T>(
            &self,
            operation: impl Fn(&interprocess::local_socket::Stream) -> io::Result<T>,
        ) -> io::Result<T> {
            loop {
                let result = {
                    let stream = self.stream.lock().unwrap();
                    let stream = stream.as_ref().ok_or_else(|| {
                        io::Error::new(io::ErrorKind::BrokenPipe, "local writer is shut down")
                    })?;
                    operation(stream)
                };
                match result {
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(1));
                    }
                    result => return result,
                }
            }
        }
    }

    fn pipe_name(path: &Path) -> io::Result<interprocess::local_socket::Name<'static>> {
        let endpoint = path
            .to_str()
            .ok_or_else(|| io::Error::other("non-UTF8 pipe name"))?
            .strip_prefix(r"\\.\pipe\")
            .unwrap_or_else(|| path.to_str().expect("path was checked above"));
        endpoint
            .to_ns_name::<GenericNamespaced>()
            .map(|name| name.into_owned())
    }

    /// Build a DACL granting access only to the current process token's user
    /// SID. Node requires generic read/write for duplex pipe clients; generic
    /// write also grants `FILE_CREATE_PIPE_INSTANCE`, so this intentionally
    /// preserves same-user trust rather than claiming same-user isolation.
    fn current_user_dacl() -> io::Result<SecurityDescriptor> {
        let mut token = std::ptr::null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let result = (|| unsafe {
            let mut size = 0_u32;
            GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut size);
            if size == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut bytes = vec![0_u8; size as usize];
            if GetTokenInformation(token, TokenUser, bytes.as_mut_ptr().cast(), size, &mut size)
                == 0
            {
                return Err(io::Error::last_os_error());
            }
            // `Vec<u8>` only guarantees byte alignment. Read the fixed header
            // by value; its SID points into `bytes`, which remains alive until
            // after `ConvertSidToStringSidW` has copied it.
            let user = std::ptr::read_unaligned(bytes.as_ptr().cast::<TOKEN_USER>());
            let mut sid = std::ptr::null_mut();
            if ConvertSidToStringSidW(user.User.Sid, &mut sid) == 0 {
                return Err(io::Error::last_os_error());
            }
            let sid_len = (0..)
                .find(|&i| *sid.add(i) == 0)
                .expect("SID is NUL terminated");
            let sid = String::from_utf16(std::slice::from_raw_parts(sid, sid_len))
                .map_err(|_| io::Error::other("Windows returned a non-Unicode SID"))?;
            LocalFree(sid.cast());
            let sddl = U16CString::from_str(format!("D:P(A;;GRGW;;;{sid})"))
                .map_err(|_| io::Error::other("current user SID contained NUL"))?;
            SecurityDescriptor::deserialize(&sddl)
        })();
        unsafe { windows_sys::Win32::Foundation::CloseHandle(token) };
        result
    }
}

pub use imp::{bind, connect, LocalListener, LocalReader, LocalStream, LocalWriter};

#[cfg(unix)]
pub use imp::test_pair;
