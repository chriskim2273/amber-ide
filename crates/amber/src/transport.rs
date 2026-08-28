//! Platform-local byte-stream transport.
//!
//! Unix keeps the daemon's existing Unix-domain socket semantics. Windows uses
//! raw named-pipe handles so shutdown can directly disconnect and close a
//! wedged peer. `GenericNamespaced` remains the mandatory name-validation and
//! mapping contract for the `\\\\.\\pipe\\` namespace, while the listener gets
//! a current-user SID-only DACL and first-pipe-instance ownership guard.

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
    use interprocess::local_socket::{GenericNamespaced, ToNsName as _};
    use std::{
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
        sync::{Arc, Mutex},
        thread,
        time::Duration,
    };
    use widestring::U16CString;
    use windows_sys::Win32::{
        Foundation::{
            GetLastError, LocalFree, ERROR_NO_DATA, ERROR_PIPE_CONNECTED, ERROR_PIPE_NOT_CONNECTED,
            GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE,
        },
        Security::{
            Authorization::{
                ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
                SDDL_REVISION_1,
            },
            GetTokenInformation, TokenUser, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
        },
        Storage::FileSystem::{
            CreateFileW, ReadFile, WriteFile, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_FIRST_PIPE_INSTANCE,
            OPEN_EXISTING, PIPE_ACCESS_DUPLEX,
        },
        System::{
            Pipes::{
                ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_NOWAIT,
                PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
                PIPE_UNLIMITED_INSTANCES,
            },
            Threading::{GetCurrentProcess, OpenProcessToken},
        },
    };

    /// A local named-pipe byte stream owned directly by Amber. Do not use the
    /// interprocess stream wrapper here: its drop path can linger/flush dirty
    /// pipes, while a wedged peer must be forcibly disconnected promptly.
    pub struct LocalStream(Arc<Pipe>);

    /// The read half of a [`LocalStream`].
    pub struct LocalReader(Arc<Pipe>);

    /// The write half of a [`LocalStream`].
    pub struct LocalWriter(Arc<Pipe>);

    /// A listener for local named-pipe streams.
    pub struct LocalListener {
        config: PipeConfig,
        pending: Mutex<Option<OwnedHandle>>,
    }

    struct Pipe {
        handle: Mutex<Option<OwnedHandle>>,
        role: PipeRole,
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum PipeRole {
        Server,
        Client,
    }

    #[derive(Clone)]
    struct PipeConfig {
        path: U16CString,
        sddl: U16CString,
    }

    impl LocalListener {
        pub fn accept(&self) -> io::Result<LocalStream> {
            let next = self.config.create_instance(false)?;
            let handle =
                self.pending.lock().unwrap().take().ok_or_else(|| {
                    io::Error::new(io::ErrorKind::BrokenPipe, "listener is closed")
                })?;
            if let Err(error) = connect_instance(handle.as_raw_handle()) {
                // Do not strand the listener after a failed/stale accept. The
                // replacement is a fresh listening instance; drop the failed
                // one rather than handing a stale connection to the next call.
                *self.pending.lock().unwrap() = Some(next);
                return Err(error);
            }
            *self.pending.lock().unwrap() = Some(next);
            Ok(LocalStream(Arc::new(Pipe {
                handle: Mutex::new(Some(handle)),
                role: PipeRole::Server,
            })))
        }
    }

    pub fn bind(path: &Path) -> io::Result<LocalListener> {
        let config = PipeConfig {
            path: pipe_path(path)?,
            sddl: current_user_sddl()?,
        };
        let first = config.create_instance(true)?;
        Ok(LocalListener {
            config,
            pending: Mutex::new(Some(first)),
        })
    }

    pub fn connect(path: &Path) -> io::Result<LocalStream> {
        let path = pipe_path(path)?;
        let handle = unsafe {
            CreateFileW(
                path.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        Ok(LocalStream(Arc::new(Pipe {
            handle: Mutex::new(Some(unsafe { OwnedHandle::from_raw_handle(handle) })),
            role: PipeRole::Client,
        })))
    }

    impl LocalStream {
        pub fn into_split(self) -> io::Result<(LocalReader, LocalWriter)> {
            Ok((LocalReader(Arc::clone(&self.0)), LocalWriter(self.0)))
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

    impl LocalWriter {
        /// A server force-disconnects its peer; a client simply closes its own
        /// handle. Both paths bypass the interprocess linger/flush drop path.
        pub fn shutdown(&mut self) -> io::Result<()> {
            self.0.shutdown()?;
            Ok(())
        }
    }

    impl Pipe {
        fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
            self.with_retry(|handle| unsafe {
                let mut read = 0_u32;
                if ReadFile(
                    handle,
                    buf.as_mut_ptr(),
                    buf.len().try_into().unwrap_or(u32::MAX),
                    &mut read,
                    std::ptr::null_mut(),
                ) == 0
                {
                    return Err(io::Error::last_os_error());
                }
                Ok(read as usize)
            })
        }

        fn write(&self, buf: &[u8]) -> io::Result<usize> {
            retry_nonblocking_write(!buf.is_empty(), || {
                self.with_retry(|handle| unsafe {
                    let mut written = 0_u32;
                    if WriteFile(
                        handle,
                        buf.as_ptr(),
                        buf.len().try_into().unwrap_or(u32::MAX),
                        &mut written,
                        std::ptr::null_mut(),
                    ) == 0
                    {
                        return Err(io::Error::last_os_error());
                    }
                    Ok(written as usize)
                })
            })
        }

        fn flush(&self) -> io::Result<()> {
            Ok(())
        }

        fn with_retry<T>(
            &self,
            mut operation: impl FnMut(windows_sys::Win32::Foundation::HANDLE) -> io::Result<T>,
        ) -> io::Result<T> {
            loop {
                let result = {
                    let handle = self.handle.lock().unwrap();
                    let handle = handle.as_ref().ok_or_else(|| {
                        io::Error::new(io::ErrorKind::BrokenPipe, "local writer is shut down")
                    })?;
                    operation(handle.as_raw_handle())
                };
                match result {
                    Err(error) if error.raw_os_error() == Some(ERROR_NO_DATA as i32) => {
                        thread::sleep(Duration::from_millis(1));
                    }
                    result => return result,
                }
            }
        }

        fn shutdown(&self) -> io::Result<()> {
            let handle = self.handle.lock().unwrap().take();
            if let Some(handle) = handle {
                if self.role == PipeRole::Server {
                    let raw = handle.as_raw_handle();
                    let disconnected = unsafe { DisconnectNamedPipe(raw) } != 0;
                    if !disconnected && unsafe { GetLastError() } != ERROR_PIPE_NOT_CONNECTED {
                        return Err(io::Error::last_os_error());
                    }
                }
                drop(handle); // OwnedHandle => direct CloseHandle; no linger/flush.
            }
            Ok(())
        }
    }

    fn pipe_path(path: &Path) -> io::Result<U16CString> {
        let endpoint = path
            .to_str()
            .ok_or_else(|| io::Error::other("non-UTF8 pipe name"))?
            .strip_prefix(r"\\.\pipe\")
            .unwrap_or_else(|| path.to_str().expect("path was checked above"));
        // Keep the protocol's GenericNamespaced validation/mapping contract;
        // raw CreateNamedPipeW receives its documented concrete Windows path.
        endpoint
            .to_ns_name::<GenericNamespaced>()
            .map_err(io::Error::other)?;
        U16CString::from_str(format!(r"\\.\pipe\{endpoint}"))
            .map_err(|_| io::Error::other("pipe name contained NUL"))
    }

    impl PipeConfig {
        fn create_instance(&self, first: bool) -> io::Result<OwnedHandle> {
            let mut descriptor = std::ptr::null_mut();
            if unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    self.sddl.as_ptr(),
                    SDDL_REVISION_1,
                    &mut descriptor,
                    std::ptr::null_mut(),
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            let attributes = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor,
                bInheritHandle: 0,
            };
            let mode =
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS;
            let open = PIPE_ACCESS_DUPLEX
                | if first {
                    FILE_FLAG_FIRST_PIPE_INSTANCE
                } else {
                    0
                };
            let handle = unsafe {
                CreateNamedPipeW(
                    self.path.as_ptr(),
                    open,
                    mode,
                    PIPE_UNLIMITED_INSTANCES,
                    64 * 1024,
                    64 * 1024,
                    0,
                    &attributes,
                )
            };
            let create_error = (handle == INVALID_HANDLE_VALUE).then(io::Error::last_os_error);
            unsafe { LocalFree(descriptor) };
            if let Some(error) = create_error {
                return Err(error);
            }
            Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
        }
    }

    fn connect_instance(handle: windows_sys::Win32::Foundation::HANDLE) -> io::Result<()> {
        loop {
            if unsafe { ConnectNamedPipe(handle, std::ptr::null_mut()) } != 0 {
                // In PIPE_NOWAIT mode this resets a disconnected instance to
                // listening; it is not an accepted client connection.
                continue;
            }
            match unsafe { GetLastError() } {
                ERROR_PIPE_CONNECTED => return Ok(()),
                ERROR_NO_DATA => {
                    // A client closed before accept. Microsoft requires the
                    // server to disconnect before reconnecting this instance.
                    if unsafe { DisconnectNamedPipe(handle) } == 0
                        && unsafe { GetLastError() } != ERROR_PIPE_NOT_CONNECTED
                    {
                        return Err(io::Error::last_os_error());
                    }
                }
                error if error == windows_sys::Win32::Foundation::ERROR_PIPE_LISTENING => {
                    thread::sleep(Duration::from_millis(1));
                }
                _ => return Err(io::Error::last_os_error()),
            }
        }
    }

    /// Build a DACL granting access only to the current process token's user
    /// SID. Node requires generic read/write for duplex pipe clients; generic
    /// write also grants `FILE_CREATE_PIPE_INSTANCE`, so this intentionally
    /// preserves same-user trust rather than claiming same-user isolation.
    fn current_user_sddl() -> io::Result<U16CString> {
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
            let mut sid_ptr = std::ptr::null_mut();
            if ConvertSidToStringSidW(user.User.Sid, &mut sid_ptr) == 0 {
                return Err(io::Error::last_os_error());
            }
            let sid_len = (0..)
                .find(|&i| *sid_ptr.add(i) == 0)
                .expect("SID is NUL terminated");
            let sid = String::from_utf16(std::slice::from_raw_parts(sid_ptr, sid_len));
            LocalFree(sid_ptr.cast());
            let sid = sid.map_err(|_| io::Error::other("Windows returned a non-Unicode SID"))?;
            U16CString::from_str(format!("D:P(A;;GRGW;;;{sid})"))
                .map_err(|_| io::Error::other("current user SID contained NUL"))
        })();
        unsafe { windows_sys::Win32::Foundation::CloseHandle(token) };
        result
    }
}

/// Retry the only successful-but-no-progress result possible for a nonblocking
/// byte-mode named-pipe write. `WriteFile` may report `TRUE, 0` when no buffer
/// space is available; a positive short write is intentionally returned so
/// `Write::write_all` preserves the remaining bytes. Sleeping prevents a busy
/// spin; higher-level client-write deadlines remain Task 3 policy.
#[cfg(any(windows, test))]
fn retry_nonblocking_write(
    nonempty: bool,
    mut write_once: impl FnMut() -> io::Result<usize>,
) -> io::Result<usize> {
    loop {
        match write_once()? {
            0 if nonempty => std::thread::sleep(std::time::Duration::from_millis(1)),
            written => return Ok(written),
        }
    }
}

pub use imp::{bind, connect, LocalListener, LocalReader, LocalStream, LocalWriter};

#[cfg(unix)]
pub use imp::test_pair;

#[cfg(test)]
#[test]
fn nonblocking_write_retries_zero_progress_without_losing_partial_progress() {
    let mut results = [Ok(0), Ok(3)].into_iter();
    assert!(matches!(
        retry_nonblocking_write(true, || results.next().expect("retry called")),
        Ok(3)
    ));

    let mut partial = [Ok(2)].into_iter();
    assert!(
        matches!(
            retry_nonblocking_write(true, || partial.next().expect("one write")),
            Ok(2)
        ),
        "a short successful write is returned for Write::write_all to continue"
    );
}
