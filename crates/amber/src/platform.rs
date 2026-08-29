//! Platform-specific paths and naming rules shared by daemon clients.

use std::ffi::OsString;
use std::io::{self, Write};
#[cfg(unix)] use std::io::Read;
use std::path::{Path, PathBuf};

/// Fill `bytes` from the operating system's cryptographic random source.
pub fn random_bytes(bytes: &mut [u8]) -> io::Result<()> {
    #[cfg(unix)]
    {
        std::fs::File::open("/dev/urandom")?.read_exact(bytes)
    }

    #[cfg(windows)]
    {
        let status = unsafe {
            windows_sys::Win32::Security::Cryptography::BCryptGenRandom(
                std::ptr::null_mut(),
                bytes.as_mut_ptr(),
                bytes.len() as u32,
                windows_sys::Win32::Security::Cryptography::BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        };
        if status == 0 {
            Ok(())
        } else {
            Err(io::Error::other(format!("BCryptGenRandom failed: {status:#x}")))
        }
    }
}

/// Write a file that only the current user can read or modify.
///
/// The caller owns the parent directory. Existing files must already satisfy
/// the privacy contract: silently replacing a broadly-readable token would
/// retain the insecure access control list on Windows.
pub fn write_user_private(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true).mode(0o600);
        let mut file = options.open(path)?;
        file.write_all(bytes)?;
        file.flush()?;
        // `.mode()` only applies when creating the file.
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }

    #[cfg(windows)]
    {
        let mut file = match create_user_private_file(path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                if !is_user_private(path)? {
                    anyhow::bail!(
                        "refusing to replace {}: it is not private to the current user",
                        path.display()
                    );
                }
                std::fs::OpenOptions::new()
                    .write(true)
                    .truncate(true)
                    .open(path)?
            }
            Err(error) => return Err(error.into()),
        };
        file.write_all(bytes)?;
        file.flush()?;
    }

    if !is_user_private(path)? {
        anyhow::bail!(
            "refusing to use {}: current-user-only permissions could not be verified",
            path.display()
        );
    }
    Ok(())
}

/// Whether `path` is private to the current user.
pub fn is_user_private(path: &Path) -> anyhow::Result<bool> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        Ok(std::fs::metadata(path)?.permissions().mode() & 0o777 == 0o600)
    }

    #[cfg(windows)]
    {
        windows_is_user_private(path).map_err(Into::into)
    }
}

#[cfg(windows)]
fn current_user_sid() -> io::Result<Vec<u8>> {
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Security::{GetLengthSid, GetTokenInformation, TOKEN_QUERY, TOKEN_USER, TokenUser};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(io::Error::last_os_error());
        }
        let result = (|| {
            let mut required = 0;
            let _ = GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut required);
            if required == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut token_user = vec![0u8; required as usize];
            if GetTokenInformation(token, TokenUser, token_user.as_mut_ptr().cast::<c_void>(), required, &mut required) == 0 {
                return Err(io::Error::last_os_error());
            }
            let user = std::ptr::read_unaligned(token_user.as_ptr().cast::<TOKEN_USER>());
            let length = GetLengthSid(user.User.Sid);
            if length == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut sid = vec![0u8; length as usize];
            std::ptr::copy_nonoverlapping(user.User.Sid.cast::<u8>(), sid.as_mut_ptr(), sid.len());
            Ok(sid)
        })();
        let _ = CloseHandle(token);
        result
    }
}

#[cfg(windows)]
fn create_user_private_file(path: &Path) -> io::Result<std::fs::File> {
    use std::mem::size_of;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Security::{
        AddAccessAllowedAce, InitializeAcl, InitializeSecurityDescriptor, SetSecurityDescriptorControl,
        SetSecurityDescriptorDacl, SetSecurityDescriptorOwner, ACCESS_ALLOWED_ACE, ACL, ACL_REVISION,
        SECURITY_ATTRIBUTES, SECURITY_DESCRIPTOR, SE_DACL_PROTECTED,
    };
    use windows_sys::Win32::Storage::FileSystem::{CreateFileW, CREATE_NEW, FILE_ALL_ACCESS, FILE_ATTRIBUTE_NORMAL};

    let sid = current_user_sid()?;
    // The ACE ends in a variable-sized SID. This is the documented
    // ACCESS_ALLOWED_ACE allocation formula.
    let acl_bytes = size_of::<ACL>() + size_of::<ACCESS_ALLOWED_ACE>() - size_of::<u32>() + sid.len();
    let mut acl = vec![0u32; acl_bytes.div_ceil(size_of::<u32>())];
    let dacl = acl.as_mut_ptr().cast::<ACL>();
    let sid_ptr = sid.as_ptr() as *mut std::ffi::c_void;
    let mut descriptor = SECURITY_DESCRIPTOR::default();
    let descriptor_ptr = (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast();

    unsafe {
        if InitializeAcl(dacl, acl_bytes as u32, ACL_REVISION) == 0
            || AddAccessAllowedAce(dacl, ACL_REVISION, FILE_ALL_ACCESS, sid_ptr) == 0
            || InitializeSecurityDescriptor(descriptor_ptr, 1) == 0
            || SetSecurityDescriptorOwner(descriptor_ptr, sid_ptr, 0) == 0
            || SetSecurityDescriptorDacl(descriptor_ptr, 1, dacl, 0) == 0
            // Do not inherit a permissive parent DACL.
            || SetSecurityDescriptorControl(descriptor_ptr, SE_DACL_PROTECTED, SE_DACL_PROTECTED) == 0
        {
            return Err(io::Error::last_os_error());
        }
        let attrs = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor_ptr,
            bInheritHandle: 0,
        };
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let handle = CreateFileW(
            wide.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            &attrs,
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        );
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        Ok(std::fs::File::from_raw_handle(handle))
    }
}

#[cfg(windows)]
fn windows_is_user_private(path: &Path) -> io::Result<bool> {
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Security::{
        EqualSid, GetAce, GetFileSecurityW, GetSecurityDescriptorControl, GetSecurityDescriptorDacl,
        GetSecurityDescriptorOwner, ACCESS_ALLOWED_ACE, ACL, DACL_SECURITY_INFORMATION,
        OWNER_SECURITY_INFORMATION, SE_DACL_PROTECTED, SECURITY_DESCRIPTOR,
    };
    use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut required = 0;
    unsafe {
        let _ = GetFileSecurityW(
            wide.as_ptr(),
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            0,
            &mut required,
        );
    }
    if required == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut words = vec![0u32; (required as usize).div_ceil(size_of::<u32>())];
    let descriptor = words.as_mut_ptr().cast::<SECURITY_DESCRIPTOR>();
    let descriptor_ptr = descriptor.cast::<c_void>();
    unsafe {
        if GetFileSecurityW(
            wide.as_ptr(),
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            descriptor_ptr,
            required,
            &mut required,
        ) == 0 {
            return Err(io::Error::last_os_error());
        }

        let mut owner = std::ptr::null_mut();
        let mut owner_defaulted = 0;
        let mut dacl = std::ptr::null_mut::<ACL>();
        let mut dacl_present = 0;
        let mut dacl_defaulted = 0;
        let mut control = 0;
        let mut revision = 0;
        if GetSecurityDescriptorOwner(descriptor_ptr, &mut owner, &mut owner_defaulted) == 0
            || GetSecurityDescriptorDacl(descriptor_ptr, &mut dacl_present, &mut dacl, &mut dacl_defaulted) == 0
            || GetSecurityDescriptorControl(descriptor_ptr, &mut control, &mut revision) == 0 {
            return Err(io::Error::last_os_error());
        }
        if owner.is_null()
            || dacl_present == 0
            || dacl.is_null()
            || control & SE_DACL_PROTECTED == 0
            || (*dacl).AceCount != 1 {
            return Ok(false);
        }

        let mut ace = std::ptr::null_mut::<c_void>();
        if GetAce(dacl, 0, &mut ace) == 0 || ace.is_null() {
            return Err(io::Error::last_os_error());
        }
        let ace = &*ace.cast::<ACCESS_ALLOWED_ACE>();
        // ACCESS_ALLOWED_ACE_TYPE is zero. Reject every other ACE kind,
        // including inherited, deny, callback, and object-specific entries.
        if ace.Header.AceType != 0 || ace.Header.AceFlags != 0 || ace.Mask != FILE_ALL_ACCESS {
            return Ok(false);
        }

        let sid = current_user_sid()?;
        let current_sid = sid.as_ptr() as *mut c_void;
        let ace_sid = std::ptr::addr_of!(ace.SidStart).cast_mut().cast::<c_void>();
        Ok(EqualSid(owner, current_sid) != 0 && EqualSid(ace_sid, current_sid) != 0)
    }
}

/// The directory containing Amber's persistent per-user state.
pub fn state_root() -> anyhow::Result<PathBuf> {
    #[cfg(unix)]
    {
        if let Some(state_home) = std::env::var_os("XDG_STATE_HOME")
            .filter(|state_home| !state_home.is_empty())
        {
            return Ok(PathBuf::from(state_home).join("amber-ide"));
        }
        let home = std::env::var_os("HOME").unwrap_or_else(|| ".".into());
        Ok(PathBuf::from(home).join(".local/state/amber-ide"))
    }

    #[cfg(windows)]
    {
        let local_app_data = std::env::var_os("LOCALAPPDATA")
            .ok_or_else(|| anyhow::anyhow!("LOCALAPPDATA is not set"))?;
        Ok(PathBuf::from(local_app_data).join("amber-ide"))
    }
}

/// Select an explicit state root or the platform default.
pub fn resolve_state_root(explicit: Option<PathBuf>) -> anyhow::Result<PathBuf> {
    explicit.map_or_else(state_root, Ok)
}

/// The deterministic local transport endpoint for this user.
pub fn socket_name() -> anyhow::Result<PathBuf> {
    let root = state_root()?;
    socket_name_for_root(&root)
}

/// The local transport endpoint paired with `root`.
///
/// Unix falls back to `<root>/amberd.sock` when no runtime directory exists;
/// Windows always uses Amber's one per-user named-pipe endpoint.
pub fn socket_name_for_root(root: &Path) -> anyhow::Result<PathBuf> {
    #[cfg(windows)]
    let _ = root;

    #[cfg(unix)]
    {
        if let Some(runtime_dir) = std::env::var_os("XDG_RUNTIME_DIR")
            .filter(|runtime_dir| !runtime_dir.is_empty())
        {
            return Ok(PathBuf::from(runtime_dir)
                .join("amber-ide")
                .join("amberd.sock"));
        }
        Ok(root.join("amberd.sock"))
    }

    #[cfg(windows)]
    {
        Ok(PathBuf::from(r"\\.\pipe\amber-ide"))
    }
}

/// Resolve state and local-transport overrides as one coherent pair.
pub fn resolve_paths(
    root: Option<PathBuf>,
    socket: Option<PathBuf>,
) -> anyhow::Result<(PathBuf, PathBuf)> {
    let root = resolve_state_root(root)?;
    let socket = socket.map_or_else(|| socket_name_for_root(&root), Ok)?;
    Ok((root, socket))
}

/// The interactive shell used when no user preference is available.
pub fn default_shell() -> OsString {
    #[cfg(unix)]
    {
        std::env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into())
    }

    #[cfg(windows)]
    {
        std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into())
    }
}

/// Validate a name before it becomes a persisted session filename.
///
/// The grammar is deliberately portable: state created on Unix must be safe
/// to restore on Windows too.
pub fn validate_session_name(name: &str) -> anyhow::Result<()> {
    if name.is_empty()
        || name.len() > 200
        || name
            .bytes()
            .any(|b| !matches!(b, b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.'))
    {
        anyhow::bail!("invalid session name: {name:?}");
    }
    if name.ends_with(['.', ' ']) || reserved_device_name(name) {
        anyhow::bail!("invalid portable session name: {name:?}");
    }
    Ok(())
}

/// Windows reserves these names even with an extension (for example,
/// `CON.txt`), so compare the first filename component case-insensitively.
fn reserved_device_name(name: &str) -> bool {
    let base = name.split('.').next().unwrap_or(name);
    let base = base.to_ascii_uppercase();
    matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || base
            .strip_prefix("COM")
            .is_some_and(is_single_device_number)
        || base
            .strip_prefix("LPT")
            .is_some_and(is_single_device_number)
}

fn is_single_device_number(number: &str) -> bool {
    matches!(number.as_bytes(), [b'1'..=b'9'])
}

#[cfg(test)]
mod tests {
    use super::{resolve_paths, socket_name_for_root, validate_session_name};
    use std::path::{Path, PathBuf};

    #[test]
    fn explicit_root_and_socket_are_resolved_together() {
        let root = PathBuf::from("chosen-state");
        let socket = PathBuf::from("chosen-endpoint");

        assert_eq!(
            resolve_paths(Some(root.clone()), Some(socket.clone())).unwrap(),
            (root, socket)
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_socket_for_root_matches_the_shared_default_rule() {
        let root = Path::new("selected-state");
        let expected = std::env::var_os("XDG_RUNTIME_DIR")
            .filter(|runtime_dir| !runtime_dir.is_empty())
            .map(PathBuf::from)
            .map(|runtime_dir| runtime_dir.join("amber-ide").join("amberd.sock"))
            .unwrap_or_else(|| root.join("amberd.sock"));

        assert_eq!(socket_name_for_root(root).unwrap(), expected);
    }

    #[cfg(windows)]
    #[test]
    fn windows_socket_for_root_is_the_single_named_pipe() {
        assert_eq!(
            socket_name_for_root(Path::new(r"C:\ignored")).unwrap(),
            PathBuf::from(r"\\.\pipe\amber-ide")
        );
    }

    #[test]
    fn rejects_windows_device_and_trailing_names() {
        for name in [
            "CON", "aux", "COM1", "LPT9", "CON.txt", "a:b", "name.", "name ",
        ] {
            assert!(validate_session_name(name).is_err(), "{name}");
        }
        assert!(validate_session_name("amber-1-1-0-safe").is_ok());
    }
}
