//! Platform-specific paths and naming rules shared by daemon clients.

use std::ffi::OsString;
use std::io::{self, Write};
#[cfg(any(unix, windows))] use std::io::Read;
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
        write_user_private_windows(path, bytes)?;
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
        match open_existing_user_private(path) {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => Ok(false),
            Err(error) => Err(error.into()),
        }
    }
}

/// Atomically establish or load a current-user-private file on Windows.
///
/// The candidate is written only through a new, exclusively-held handle whose
/// no-reparse object and DACL have already been verified. A concurrent creator
/// that loses `CREATE_NEW` retries the established winner and returns its
/// bytes; it never truncates or rewrites the winner.
#[cfg(windows)]
pub fn load_or_create_user_private(
    path: &Path,
    candidate: &[u8],
    regenerate: bool,
) -> anyhow::Result<Vec<u8>> {
    if regenerate {
        match open_existing_user_private(path) {
            Ok(mut file) => {
                write_private_handle(&mut file, candidate)?;
                return Ok(candidate.to_vec());
            }
            Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error.into()),
            Err(_) => {}
        }
    }

    for _ in 0..50 {
        match open_existing_user_private(path) {
            Ok(mut file) => {
                let mut existing = Vec::new();
                file.read_to_end(&mut existing)?;
                if !existing.is_empty() {
                    return Ok(existing);
                }
                // A winner may have created the object but not reached its
                // first write yet. It holds the handle exclusively, so never
                // initialize this observed empty file from a losing caller.
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                match create_user_private_file(path) {
                    Ok(mut file) => {
                        write_private_handle(&mut file, candidate)?;
                        return Ok(candidate.to_vec());
                    }
                    Err(error) if is_creation_race(&error) => {}
                    Err(error) => return Err(error.into()),
                }
            }
            Err(error) if is_creation_race(&error) => {}
            Err(error) => return Err(error.into()),
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    anyhow::bail!(
        "timed out waiting for the private token creator at {}",
        path.display()
    )
}

/// Read a Windows private file through a verified no-reparse handle.
#[cfg(windows)]
pub fn read_user_private(path: &Path) -> anyhow::Result<Option<Vec<u8>>> {
    match open_existing_user_private(path) {
        Ok(mut file) => {
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)?;
            Ok(Some(bytes))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
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
        let file = std::fs::File::from_raw_handle(handle);
        verify_user_private_handle(&file)?;
        Ok(file)
    }
}

#[cfg(windows)]
fn open_existing_user_private(path: &Path) -> io::Result<std::fs::File> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_OPEN_REPARSE_POINT, OPEN_EXISTING,
    };

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        let handle = CreateFileW(
            wide.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        );
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let file = std::fs::File::from_raw_handle(handle);
        verify_user_private_handle(&file)?;
        Ok(file)
    }
}

#[cfg(windows)]
fn write_user_private_windows(path: &Path, bytes: &[u8]) -> io::Result<()> {
    match open_existing_user_private(path) {
        Ok(mut file) => write_private_handle(&mut file, bytes),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let mut file = create_user_private_file(path)?;
            write_private_handle(&mut file, bytes)
        }
        Err(error) => Err(error),
    }
}

#[cfg(windows)]
fn write_private_handle(file: &mut std::fs::File, bytes: &[u8]) -> io::Result<()> {
    // This is intentionally after `verify_user_private_handle`: no candidate
    // byte reaches an object before the exact opened handle is verified.
    verify_user_private_handle(file)?;
    file.set_len(0)?;
    file.write_all(bytes)?;
    file.sync_all()
}

#[cfg(windows)]
fn is_creation_race(error: &io::Error) -> bool {
    use windows_sys::Win32::Foundation::{ERROR_FILE_EXISTS, ERROR_SHARING_VIOLATION};

    matches!(
        error.raw_os_error(),
        Some(code) if code == ERROR_FILE_EXISTS as i32 || code == ERROR_SHARING_VIOLATION as i32
    )
}

#[cfg(windows)]
fn verify_user_private_handle(file: &std::fs::File) -> io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT,
    };

    unsafe {
        let handle = file.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE;
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        if GetFileInformationByHandle(handle, &mut info) == 0 {
            return Err(io::Error::last_os_error());
        }
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "refusing a reparse-point token file",
            ));
        }
        if !handle_is_user_private(handle)? {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "token file is not private to the current user",
            ));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn handle_is_user_private(handle: windows_sys::Win32::Foundation::HANDLE) -> io::Result<bool> {
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::{
        DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
    };
    use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};

    let mut descriptor = std::ptr::null_mut::<c_void>();
    unsafe {
        let status = GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut descriptor,
        );
        if status != 0 {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        let result = security_descriptor_is_user_private(descriptor, &current_user_sid()?);
        let _ = LocalFree(descriptor);
        result
    }
}

#[cfg(windows)]
fn security_descriptor_is_user_private(
    descriptor: *mut std::ffi::c_void,
    current_sid: &[u8],
) -> io::Result<bool> {
    use std::ffi::c_void;
    use windows_sys::Win32::Security::{
        EqualSid, GetAce, GetSecurityDescriptorControl, GetSecurityDescriptorDacl,
        GetSecurityDescriptorOwner, ACCESS_ALLOWED_ACE, ACL, SE_DACL_PROTECTED,
    };
    use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;

    unsafe {
        let mut owner = std::ptr::null_mut();
        let mut owner_defaulted = 0;
        let mut dacl = std::ptr::null_mut::<ACL>();
        let mut dacl_present = 0;
        let mut dacl_defaulted = 0;
        let mut control = 0;
        let mut revision = 0;
        if GetSecurityDescriptorOwner(descriptor, &mut owner, &mut owner_defaulted) == 0
            || GetSecurityDescriptorDacl(descriptor, &mut dacl_present, &mut dacl, &mut dacl_defaulted) == 0
            || GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) == 0 {
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
        if ace.Header.AceType != 0 || ace.Header.AceFlags != 0 || ace.Mask != FILE_ALL_ACCESS {
            return Ok(false);
        }
        let sid = current_sid.as_ptr() as *mut c_void;
        let ace_sid = std::ptr::addr_of!(ace.SidStart).cast_mut().cast::<c_void>();
        Ok(EqualSid(owner, sid) != 0 && EqualSid(ace_sid, sid) != 0)
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

pub fn user_home() -> Option<PathBuf> {
    user_home_from(std::env::var_os("HOME"), std::env::var_os("USERPROFILE"))
}

fn user_home_from(home: Option<OsString>, user_profile: Option<OsString>) -> Option<PathBuf> {
    home.filter(|path| !path.is_empty())
        .or_else(|| user_profile.filter(|path| !path.is_empty()))
        .map(PathBuf::from)
}

pub(crate) fn replace_file(from: &Path, to: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        std::fs::rename(from, to)
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };

        let from: Vec<u16> = from
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let to: Vec<u16> = to
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        if unsafe {
            MoveFileExW(
                from.as_ptr(),
                to.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
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

#[cfg(all(test, windows))]
mod windows_private_file_tests {
    use super::*;
    use std::mem::size_of;
    use windows_sys::Win32::Security::{
        AddAccessAllowedAce, CreateWellKnownSid, InitializeAcl, InitializeSecurityDescriptor,
        SetSecurityDescriptorControl, SetSecurityDescriptorDacl, SetSecurityDescriptorOwner,
        ACCESS_ALLOWED_ACE, ACL, ACL_REVISION, SECURITY_DESCRIPTOR, SE_DACL_PROTECTED, WinWorldSid,
    };
    use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;

    struct Descriptor {
        _acl: Vec<u32>,
        descriptor: SECURITY_DESCRIPTOR,
    }

    fn world_sid() -> Vec<u8> {
        unsafe {
            let mut len = 0;
            let _ = CreateWellKnownSid(WinWorldSid, std::ptr::null_mut(), std::ptr::null_mut(), &mut len);
            assert!(len > 0);
            let mut sid = vec![0u8; len as usize];
            assert_ne!(
                CreateWellKnownSid(
                    WinWorldSid,
                    std::ptr::null_mut(),
                    sid.as_mut_ptr().cast(),
                    &mut len,
                ),
                0
            );
            sid
        }
    }

    fn descriptor(owner: *mut std::ffi::c_void, ace_sids: &[*mut std::ffi::c_void], dacl: bool) -> Descriptor {
        let mut descriptor = SECURITY_DESCRIPTOR::default();
        let acl_bytes = size_of::<ACL>()
            + ace_sids.len() * (size_of::<ACCESS_ALLOWED_ACE>() - size_of::<u32>())
            + ace_sids
                .iter()
                .map(|sid| unsafe { windows_sys::Win32::Security::GetLengthSid(*sid) as usize })
                .sum::<usize>();
        let mut acl = vec![0u32; acl_bytes.div_ceil(size_of::<u32>())];
        unsafe {
            let descriptor_ptr = (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast();
            assert_ne!(InitializeSecurityDescriptor(descriptor_ptr, 1), 0);
            assert_ne!(SetSecurityDescriptorOwner(descriptor_ptr, owner, 0), 0);
            if dacl {
                let dacl = acl.as_mut_ptr().cast::<ACL>();
                assert_ne!(InitializeAcl(dacl, acl_bytes as u32, ACL_REVISION), 0);
                for sid in ace_sids {
                    assert_ne!(AddAccessAllowedAce(dacl, ACL_REVISION, FILE_ALL_ACCESS, *sid), 0);
                }
                assert_ne!(SetSecurityDescriptorDacl(descriptor_ptr, 1, dacl, 0), 0);
                assert_ne!(
                    SetSecurityDescriptorControl(descriptor_ptr, SE_DACL_PROTECTED, SE_DACL_PROTECTED),
                    0
                );
            } else {
                assert_ne!(SetSecurityDescriptorDacl(descriptor_ptr, 0, std::ptr::null(), 0), 0);
            }
        }
        Descriptor { _acl: acl, descriptor }
    }

    #[test]
    fn private_descriptor_rejects_owner_mismatch_and_extra_aces() {
        let user = current_user_sid().unwrap();
        let user_ptr = user.as_ptr() as *mut std::ffi::c_void;
        let world = world_sid();
        let world_ptr = world.as_ptr() as *mut std::ffi::c_void;

        let wrong_owner = descriptor(world_ptr, &[user_ptr], true);
        assert!(!security_descriptor_is_user_private(
            (&wrong_owner.descriptor as *const SECURITY_DESCRIPTOR).cast_mut().cast(),
            &user,
        )
        .unwrap());

        let extra_ace = descriptor(user_ptr, &[user_ptr, world_ptr], true);
        assert!(!security_descriptor_is_user_private(
            (&extra_ace.descriptor as *const SECURITY_DESCRIPTOR).cast_mut().cast(),
            &user,
        )
        .unwrap());
    }

    #[test]
    fn private_descriptor_rejects_absent_and_null_dacls() {
        let user = current_user_sid().unwrap();
        let user_ptr = user.as_ptr() as *mut std::ffi::c_void;
        let absent = descriptor(user_ptr, &[], false);
        assert!(!security_descriptor_is_user_private(
            (&absent.descriptor as *const SECURITY_DESCRIPTOR).cast_mut().cast(),
            &user,
        )
        .unwrap());

        let mut null_dacl = SECURITY_DESCRIPTOR::default();
        unsafe {
            let ptr = (&mut null_dacl as *mut SECURITY_DESCRIPTOR).cast();
            assert_ne!(InitializeSecurityDescriptor(ptr, 1), 0);
            assert_ne!(SetSecurityDescriptorOwner(ptr, user_ptr, 0), 0);
            assert_ne!(SetSecurityDescriptorDacl(ptr, 1, std::ptr::null(), 0), 0);
        }
        assert!(!security_descriptor_is_user_private(
            (&null_dacl as *const SECURITY_DESCRIPTOR).cast_mut().cast(),
            &user,
        )
        .unwrap());
    }

    #[test]
    fn private_open_rejects_a_reparse_point() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        std::fs::write(&target, b"not-a-token").unwrap();
        let link = dir.path().join("web-token");
        match std::os::windows::fs::symlink_file(&target, &link) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => return,
            Err(error) => panic!("could not create test reparse point: {error}"),
        }
        assert!(open_existing_user_private(&link).is_err());
    }
}

#[cfg(test)]
mod tests {
    use super::{resolve_paths, socket_name_for_root, user_home_from, validate_session_name};
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

    #[cfg(windows)]
    #[test]
    fn windows_replace_file_overwrites_an_existing_destination() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("new");
        let to = dir.path().join("current");
        std::fs::write(&from, b"new").unwrap();
        std::fs::write(&to, b"old").unwrap();

        super::replace_file(&from, &to).unwrap();

        assert!(!from.exists());
        assert_eq!(std::fs::read(to).unwrap(), b"new");
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

    #[test]
    fn user_home_falls_back_to_windows_profile() {
        assert_eq!(
            user_home_from(Some("/home/alice".into()), Some(r"C:\Users\alice".into())),
            Some(PathBuf::from("/home/alice")),
        );
        assert_eq!(
            user_home_from(None, Some(r"C:\Users\alice".into())),
            Some(PathBuf::from(r"C:\Users\alice")),
        );
        assert_eq!(user_home_from(Some("".into()), Some("".into())), None);
    }
}
