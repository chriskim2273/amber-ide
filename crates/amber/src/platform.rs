//! Platform-specific paths and naming rules shared by daemon clients.

use std::ffi::OsString;
use std::path::PathBuf;

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
        return Ok(PathBuf::from(home).join(".local/state/amber-ide"));
    }

    #[cfg(windows)]
    {
        let local_app_data = std::env::var_os("LOCALAPPDATA")
            .ok_or_else(|| anyhow::anyhow!("LOCALAPPDATA is not set"))?;
        Ok(PathBuf::from(local_app_data).join("amber-ide"))
    }
}

/// The deterministic local transport endpoint for this user.
pub fn socket_name() -> anyhow::Result<PathBuf> {
    #[cfg(unix)]
    {
        if let Some(runtime_dir) = std::env::var_os("XDG_RUNTIME_DIR")
            .filter(|runtime_dir| !runtime_dir.is_empty())
        {
            return Ok(PathBuf::from(runtime_dir)
                .join("amber-ide")
                .join("amberd.sock"));
        }
        return Ok(state_root()?.join("amberd.sock"));
    }

    #[cfg(windows)]
    {
        Ok(PathBuf::from(r"\\.\pipe\amber-ide"))
    }
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
    use super::validate_session_name;

    #[test]
    fn rejects_windows_device_and_trailing_names() {
        for name in ["CON", "aux", "a:b", "name.", "name "] {
            assert!(validate_session_name(name).is_err(), "{name}");
        }
        assert!(validate_session_name("amber-1-1-0-safe").is_ok());
    }
}
