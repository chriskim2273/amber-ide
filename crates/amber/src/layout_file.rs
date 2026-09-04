//! Bounded, race-aware reads for the Electron-owned layout sidecar.
//!
//! The desktop and web processes both ingest `ui-layout.json`. This is the
//! shared file boundary: no caller may turn a path into an unbounded String,
//! follow a symlink, or accept a file that grows while it is being read.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::path::Path;

/// Sidecar file name inside the state root, written by the Electron app.
pub const LAYOUT_FILE: &str = "ui-layout.json";
/// Maximum encoded sidecar size. This is also the TypeScript contract.
pub const LAYOUT_FILE_MAX_BYTES: u64 = 8 * 1024 * 1024;
/// Maximum number of workspaces in a sidecar.
pub const LAYOUT_MAX_WORKSPACES: usize = 256;
/// Maximum number of tabs in one workspace.
pub const LAYOUT_MAX_TABS_PER_WORKSPACE: usize = 1024;
/// Maximum entries in maps that are not otherwise narrower.
pub const LAYOUT_MAX_MAP_ENTRIES: usize = 4096;
/// Maximum split nesting depth.
pub const LAYOUT_MAX_TREE_DEPTH: usize = 64;
/// Maximum split-tree nodes per sidecar.
pub const LAYOUT_MAX_TREE_NODES: usize = 4096;
/// Maximum encoded length of one user-controlled layout string.
pub const LAYOUT_MAX_STRING_BYTES: usize = 16 * 1024;

/// Stable classes for a sidecar read failure. Callers intentionally degrade to
/// their documented fallback rather than exposing filesystem diagnostics.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadError {
    Symlink,
    NotRegular,
    TooLarge,
    Changed,
    InvalidUtf8,
    Io(String),
}

impl ReadError {
    /// Stable API error used by layout CAS. Mosaic does not expose it, but
    /// keeping the mapping here prevents Node/Rust callers from inventing
    /// different limit names for the same boundary.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Symlink => "LAYOUT_SYMLINK",
            Self::NotRegular => "LAYOUT_NOT_REGULAR",
            Self::TooLarge => "LAYOUT_FILE_LIMIT",
            Self::Changed => "LAYOUT_FILE_CHANGED",
            Self::InvalidUtf8 => "LAYOUT_INVALID_UTF8",
            Self::Io(_) => "LAYOUT_READ_FAILED",
        }
    }
}

fn io_error(error: io::Error) -> ReadError {
    if error.kind() == io::ErrorKind::NotFound {
        ReadError::Io("not found".into())
    } else {
        ReadError::Io(error.to_string())
    }
}

fn initial_metadata(path: &Path) -> Result<Option<fs::Metadata>, ReadError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            let kind = metadata.file_type();
            if kind.is_symlink() {
                return Err(ReadError::Symlink);
            }
            if !kind.is_file() {
                return Err(ReadError::NotRegular);
            }
            if metadata.len() > LAYOUT_FILE_MAX_BYTES {
                return Err(ReadError::TooLarge);
            }
            Ok(Some(metadata))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io_error(error)),
    }
}

fn same_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        left.dev() == right.dev() && left.ino() == right.ino()
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // The stable Windows metadata API exposes creation/write times but not
        // the by-handle file index. Atomic replacement changes creation time
        // on normal filesystems; the descriptor itself remains safe to read
        // even when an unusual filesystem reports less identity data.
        left.creation_time() == right.creation_time()
            && left.last_write_time() == right.last_write_time()
            && left.file_size() == right.file_size()
    }
    #[cfg(not(any(unix, windows)))]
    {
        left.len() == right.len() && left.modified().ok() == right.modified().ok()
    }
}

fn open_regular(path: &Path) -> Result<Option<File>, ReadError> {
    let Some(_path_metadata) = initial_metadata(path)? else {
        return Ok(None);
    };

    let mut options = OpenOptions::new();
    options.read(true);
    // The first symlink_metadata check handles ordinary cases and this flag
    // closes the check -> open swap on Unix. Once open, all further checks use
    // the descriptor, never a path that an attacker can redirect.
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        // FILE_FLAG_OPEN_REPARSE_POINT prevents following a reparse point at
        // open. A reparse handle is not readable as a regular file and is
        // rejected by the descriptor metadata check below.
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000);
    }

    let file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        #[cfg(unix)]
        Err(error) if error.raw_os_error() == Some(libc::ELOOP) => {
            return Err(ReadError::Symlink)
        }
        Err(error) => return Err(io_error(error)),
    };

    // A path replacement after the first check must not turn an accepted
    // symlink into an accepted regular descriptor on platforms without
    // O_NOFOLLOW. On Unix this is also a cheap second explicit check for
    // callers/tests that swap the path while opening.
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() {
            return Err(ReadError::Symlink);
        }
    }

    let metadata = file.metadata().map_err(io_error)?;
    if !metadata.is_file() {
        return Err(ReadError::NotRegular);
    }
    if metadata.len() > LAYOUT_FILE_MAX_BYTES {
        return Err(ReadError::TooLarge);
    }
    Ok(Some(file))
}

/// Read one regular sidecar file with a hard encoded-byte bound.
///
/// `Ok(None)` means the file is absent. The descriptor is bounded with
/// `take(MAX+1)`, and its final length is compared with the length observed
/// immediately after opening. A writer that grows or replaces the file during
/// the read therefore cannot make us return a partial layout as valid text.
pub fn read_bounded_regular_file(path: &Path) -> Result<Option<String>, ReadError> {
    let Some(mut file) = open_regular(path)? else {
        return Ok(None);
    };
    let before = file.metadata().map_err(io_error)?;
    let capacity = before
        .len()
        .min(LAYOUT_FILE_MAX_BYTES)
        .saturating_add(1) as usize;
    let mut bytes = Vec::with_capacity(capacity.max(1));
    let mut limited = (&mut file).take(LAYOUT_FILE_MAX_BYTES.saturating_add(1));
    limited.read_to_end(&mut bytes).map_err(io_error)?;

    let after = file.metadata().map_err(io_error)?;
    if after.len() > LAYOUT_FILE_MAX_BYTES || bytes.len() as u64 > LAYOUT_FILE_MAX_BYTES {
        return Err(ReadError::TooLarge);
    }
    if after.len() != before.len() {
        return Err(ReadError::Changed);
    }
    let path_after = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Err(ReadError::Changed),
        Err(error) => return Err(io_error(error)),
    };
    if path_after.file_type().is_symlink() {
        return Err(ReadError::Symlink);
    }
    if !path_after.file_type().is_file() || !same_file(&path_after, &after) {
        return Err(ReadError::Changed);
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| ReadError::InvalidUtf8)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn accepts_exactly_eight_mib_and_rejects_one_more() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(LAYOUT_FILE);
        fs::write(&path, vec![b'x'; LAYOUT_FILE_MAX_BYTES as usize]).unwrap();
        assert_eq!(
            read_bounded_regular_file(&path).unwrap().unwrap().len(),
            LAYOUT_FILE_MAX_BYTES as usize
        );
        fs::write(&path, vec![b'y'; LAYOUT_FILE_MAX_BYTES as usize + 1]).unwrap();
        assert_eq!(read_bounded_regular_file(&path), Err(ReadError::TooLarge));
    }

    #[test]
    fn rejects_nonregular_and_symlink_paths() {
        let dir = tempfile::tempdir().unwrap();
        let directory = dir.path().join("directory");
        fs::create_dir(&directory).unwrap();
        assert_eq!(read_bounded_regular_file(&directory), Err(ReadError::NotRegular));
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let target = dir.path().join("target");
            let link = dir.path().join(LAYOUT_FILE);
            fs::write(&target, b"target").unwrap();
            symlink(&target, &link).unwrap();
            assert_eq!(read_bounded_regular_file(&link), Err(ReadError::Symlink));
        }
    }

    #[test]
    fn rejects_a_file_that_grows_past_the_boundary_before_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(LAYOUT_FILE);
        fs::write(&path, vec![b'x'; LAYOUT_FILE_MAX_BYTES as usize]).unwrap();
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"growth").unwrap();
        drop(file);
        assert_eq!(read_bounded_regular_file(&path), Err(ReadError::TooLarge));
    }
}
