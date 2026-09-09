//! Read the git branch of a session's working directory.
//!
//! Two panes in the same repository are the case the phone's session list
//! cannot otherwise resolve: project, kind and slot are identical for both, and
//! the branch is what separates them.
//!
//! This never spawns `git`. It reads `HEAD` directly, which is enough for the
//! branch name and costs one open on a cache miss. A branch is display
//! metadata only — nothing about session existence, naming or supervision
//! depends on it, so every failure resolves to `None` rather than an error.

use std::path::{Path, PathBuf};

/// How far up the tree to look for a repository before giving up. A session cwd
/// is a working directory, not an arbitrary deep path, so this is generous.
const MAX_DEPTH: usize = 40;

/// Length of the abbreviated commit shown for a detached HEAD.
const SHORT_SHA: usize = 7;

/// Locate the `HEAD` file governing `cwd`, following a linked worktree's
/// `.git` file to the real git directory. Returns `None` outside a repository.
pub fn head_path(cwd: &Path) -> Option<PathBuf> {
    let mut dir = Some(cwd);
    for _ in 0..MAX_DEPTH {
        let current = dir?;
        let dot_git = current.join(".git");
        // A normal checkout: `.git` is the git directory itself.
        if dot_git.is_dir() {
            return Some(dot_git.join("HEAD"));
        }
        // A linked worktree (or a submodule): `.git` is a file pointing at the
        // real git directory, which holds this worktree's own HEAD.
        if dot_git.is_file() {
            let contents = std::fs::read_to_string(&dot_git).ok()?;
            let target = contents.strip_prefix("gitdir:")?.trim();
            if target.is_empty() {
                return None;
            }
            let target = Path::new(target);
            let resolved = if target.is_absolute() {
                target.to_path_buf()
            } else {
                current.join(target)
            };
            return Some(resolved.join("HEAD"));
        }
        dir = current.parent();
    }
    None
}

/// Interpret the contents of a `HEAD` file.
///
/// `ref: refs/heads/<name>` is a branch. A bare object id is a detached HEAD,
/// reported as an abbreviated sha so the row still shows something stable.
/// Anything else (an unborn ref, a packed oddity, junk) is `None` — a wrong
/// branch label is worse than no label.
pub fn parse_head(contents: &str) -> Option<String> {
    let head = contents.trim();
    if let Some(reference) = head.strip_prefix("ref:") {
        let reference = reference.trim();
        let name = reference.strip_prefix("refs/heads/")?;
        // Guard against `ref: refs/heads/` with nothing after it.
        return (!name.is_empty()).then(|| name.to_string());
    }
    let detached = head.len() == 40 && head.chars().all(|c| c.is_ascii_hexdigit());
    detached.then(|| head[..SHORT_SHA].to_string())
}

/// The branch (or short detached sha) for a working directory, or `None` when
/// it is not in a repository or `HEAD` cannot be understood.
pub fn branch_of(cwd: &Path) -> Option<String> {
    let head = head_path(cwd)?;
    parse_head(&std::fs::read_to_string(head).ok()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(root: &Path, head: &str) {
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".git").join("HEAD"), head).unwrap();
    }

    #[test]
    fn a_checkout_reports_its_branch() {
        let dir = tempfile::tempdir().unwrap();
        repo(dir.path(), "ref: refs/heads/main\n");
        assert_eq!(branch_of(dir.path()), Some("main".to_string()));
    }

    #[test]
    fn a_branch_name_keeps_its_slashes() {
        // The names this feature exists to tell apart look like this.
        let dir = tempfile::tempdir().unwrap();
        repo(dir.path(), "ref: refs/heads/feat/pocket-mobile-ux\n");
        assert_eq!(branch_of(dir.path()), Some("feat/pocket-mobile-ux".to_string()));
    }

    #[test]
    fn a_subdirectory_finds_the_repository_above_it() {
        let dir = tempfile::tempdir().unwrap();
        repo(dir.path(), "ref: refs/heads/main\n");
        let deep = dir.path().join("crates/amber/src");
        std::fs::create_dir_all(&deep).unwrap();
        assert_eq!(branch_of(&deep), Some("main".to_string()));
    }

    #[test]
    fn a_linked_worktree_reports_its_own_branch() {
        // The worktree's `.git` is a FILE naming the real git dir; its HEAD is
        // NOT the parent repository's HEAD. Amber panes live in worktrees, so
        // getting this wrong would label every worktree with the main branch.
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("repo");
        let gitdir = main.join(".git/worktrees/wt");
        std::fs::create_dir_all(&gitdir).unwrap();
        std::fs::write(main.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(gitdir.join("HEAD"), "ref: refs/heads/side\n").unwrap();

        let wt = dir.path().join("wt");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", gitdir.display())).unwrap();

        assert_eq!(branch_of(&wt), Some("side".to_string()));
    }

    #[test]
    fn a_relative_gitdir_resolves_against_the_worktree() {
        let dir = tempfile::tempdir().unwrap();
        let gitdir = dir.path().join("real");
        std::fs::create_dir_all(&gitdir).unwrap();
        std::fs::write(gitdir.join("HEAD"), "ref: refs/heads/rel\n").unwrap();
        let wt = dir.path().join("wt");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join(".git"), "gitdir: ../real\n").unwrap();
        assert_eq!(branch_of(&wt), Some("rel".to_string()));
    }

    #[test]
    fn a_detached_head_reports_a_short_sha() {
        let dir = tempfile::tempdir().unwrap();
        repo(dir.path(), "3ff2d2d0e1c4a5b697f8d2c1a0b9e8d7c6f5a4b3\n");
        assert_eq!(branch_of(dir.path()), Some("3ff2d2d".to_string()));
    }

    #[test]
    fn a_directory_outside_any_repository_has_no_branch() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(branch_of(dir.path()), None);
    }

    #[test]
    fn unreadable_head_contents_are_no_branch_rather_than_a_guess() {
        for junk in ["", "\n", "ref:", "ref: refs/heads/", "ref: refs/tags/v1", "not-a-sha", "abc123"] {
            assert_eq!(parse_head(junk), None, "{junk:?} must not produce a branch");
        }
    }

    #[test]
    fn an_empty_gitdir_pointer_is_not_a_repository() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".git"), "gitdir:\n").unwrap();
        assert_eq!(branch_of(dir.path()), None);
    }
}
