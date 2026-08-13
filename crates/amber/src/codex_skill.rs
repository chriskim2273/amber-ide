use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

pub const OWNERSHIP_MARKER: &str = "<!-- amber-owned-skill -->";

#[derive(Debug, PartialEq, Eq)]
pub enum InstallOutcome {
    Installed,
    Updated,
    Conflict,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RemoveOutcome {
    Removed,
    Missing,
    Conflict,
}

pub fn skill_file(home: &Path) -> PathBuf {
    home.join(".agents/skills/claude-handoff/SKILL.md")
}

const SKILL: &str = include_str!("../../../infra/codex/skills/claude-handoff/SKILL.md");

fn metadata(path: &Path) -> anyhow::Result<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn is_owned_file(path: &Path) -> anyhow::Result<bool> {
    let Some(meta) = metadata(path)? else {
        return Ok(false);
    };
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Ok(false);
    }
    Ok(fs::read(path)?
        .split(|byte| *byte == b'\n')
        .any(|line| line.strip_suffix(b"\r").unwrap_or(line) == OWNERSHIP_MARKER.as_bytes()))
}

pub fn install(home: &Path) -> anyhow::Result<InstallOutcome> {
    let file = skill_file(home);
    let dir = file.parent().expect("skill path has a parent");
    match metadata(dir)? {
        None => {}
        Some(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
            return Ok(InstallOutcome::Conflict);
        }
        Some(_) => {}
    }
    let existed = match metadata(&file)? {
        None => false,
        Some(meta)
            if meta.file_type().is_symlink() || !meta.is_file() || !is_owned_file(&file)? =>
        {
            return Ok(InstallOutcome::Conflict);
        }
        Some(_) => true,
    };
    fs::create_dir_all(dir)?;
    let temporary = dir.join(".SKILL.md.amber-tmp");
    if metadata(&temporary)?.is_some() {
        return Ok(InstallOutcome::Conflict);
    }
    let mut temporary_file = match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
    {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            return Ok(InstallOutcome::Conflict)
        }
        Err(error) => return Err(error.into()),
    };
    temporary_file.write_all(SKILL.as_bytes())?;
    drop(temporary_file);
    fs::rename(temporary, file)?;
    Ok(if existed {
        InstallOutcome::Updated
    } else {
        InstallOutcome::Installed
    })
}

pub fn remove(home: &Path) -> anyhow::Result<RemoveOutcome> {
    let file = skill_file(home);
    let dir = file.parent().expect("skill path has a parent");
    let Some(meta) = metadata(dir)? else {
        return Ok(RemoveOutcome::Missing);
    };
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Ok(RemoveOutcome::Conflict);
    }
    match metadata(&file)? {
        None => return Ok(RemoveOutcome::Missing),
        Some(meta)
            if meta.file_type().is_symlink() || !meta.is_file() || !is_owned_file(&file)? =>
        {
            return Ok(RemoveOutcome::Conflict);
        }
        Some(_) => {}
    }
    fs::remove_file(&file)?;
    let _ = fs::remove_dir(dir); // Keep the directory when another user file remains.
    Ok(RemoveOutcome::Removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn installs_updates_and_removes_only_the_amber_skill() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(install(home.path()).unwrap(), InstallOutcome::Installed);
        let file = skill_file(home.path());
        assert!(fs::read_to_string(&file)
            .unwrap()
            .contains(OWNERSHIP_MARKER));
        assert_eq!(install(home.path()).unwrap(), InstallOutcome::Updated);
        assert_eq!(remove(home.path()).unwrap(), RemoveOutcome::Removed);
        assert!(!file.exists());
        assert_eq!(remove(home.path()).unwrap(), RemoveOutcome::Missing);
    }

    #[test]
    fn unrelated_skill_is_never_overwritten_or_removed() {
        let home = tempfile::tempdir().unwrap();
        let file = skill_file(home.path());
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "user-owned\n").unwrap();
        assert_eq!(install(home.path()).unwrap(), InstallOutcome::Conflict);
        assert_eq!(remove(home.path()).unwrap(), RemoveOutcome::Conflict);
        assert_eq!(fs::read_to_string(file).unwrap(), "user-owned\n");
    }

    #[test]
    fn existing_temporary_file_is_preserved() {
        let home = tempfile::tempdir().unwrap();
        let file = skill_file(home.path());
        let temporary = file.parent().unwrap().join(".SKILL.md.amber-tmp");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&temporary, "user-owned temporary\n").unwrap();

        assert_eq!(install(home.path()).unwrap(), InstallOutcome::Conflict);
        assert_eq!(
            fs::read_to_string(temporary).unwrap(),
            "user-owned temporary\n"
        );
        assert!(!file.exists());
    }

    #[cfg(unix)]
    #[test]
    fn existing_temporary_symlink_is_preserved() {
        use std::os::unix::fs::symlink;

        let home = tempfile::tempdir().unwrap();
        let file = skill_file(home.path());
        let temporary = file.parent().unwrap().join(".SKILL.md.amber-tmp");
        let outside = home.path().join("user-owned");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&outside, "user-owned target\n").unwrap();
        symlink(&outside, &temporary).unwrap();

        assert_eq!(install(home.path()).unwrap(), InstallOutcome::Conflict);
        assert_eq!(fs::read_to_string(&outside).unwrap(), "user-owned target\n");
        assert!(fs::symlink_metadata(temporary)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(!file.exists());
    }

    #[test]
    fn invalid_utf8_skill_is_an_unchanged_conflict() {
        let home = tempfile::tempdir().unwrap();
        let file = skill_file(home.path());
        let bytes = b"user-owned\xff\n";
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, bytes).unwrap();

        assert_eq!(install(home.path()).unwrap(), InstallOutcome::Conflict);
        assert_eq!(remove(home.path()).unwrap(), RemoveOutcome::Conflict);
        assert_eq!(fs::read(file).unwrap(), bytes);
    }
}
