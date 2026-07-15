//! Platform-abstracted process introspection: live cwd + ad-hoc-claude
//! detection. OS primitives are cfg-split (Linux `/proc`, macOS `libc`);
//! the ancestor-walk logic is shared and pure. Every primitive degrades to
//! None/empty on failure — it never panics (matches the daemon's contract).

/// One process as seen by the OS process table.
pub struct ProcEntry {
    pub pid: u32,
    pub ppid: u32,
    /// argv0 / exec basename, e.g. "claude".
    pub comm: String,
}

/// Is any process named `claude` a descendant of `root` within `table`?
/// Builds a pid->ppid map and walks each claude's ancestor chain (bounded 64
/// deep, stopping at pid <= 1). Pure over `table` — no syscalls.
pub fn claude_descends_from_table(table: &[ProcEntry], root: u32) -> bool {
    use std::collections::HashMap;
    let mut ppid_of: HashMap<u32, u32> = HashMap::with_capacity(table.len());
    let mut claude_pids: Vec<u32> = Vec::new();
    for entry in table {
        ppid_of.insert(entry.pid, entry.ppid);
        if entry.comm == "claude" {
            claude_pids.push(entry.pid);
        }
    }
    for &cp in &claude_pids {
        let mut cur = cp;
        for _ in 0..64 {
            match ppid_of.get(&cur) {
                Some(&pp) if pp == root => return true,
                Some(&pp) if pp > 1 => cur = pp,
                _ => break,
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(pid: u32, ppid: u32, comm: &str) -> ProcEntry {
        ProcEntry { pid, ppid, comm: comm.to_string() }
    }

    #[test]
    fn direct_child_claude_is_detected() {
        let t = vec![e(100, 1, "bash"), e(101, 100, "claude")];
        assert!(claude_descends_from_table(&t, 100));
    }

    #[test]
    fn deep_chain_within_limit_is_detected() {
        let t = vec![
            e(100, 1, "bash"),
            e(200, 100, "sh"),
            e(300, 200, "npx"),
            e(400, 300, "claude"),
        ];
        assert!(claude_descends_from_table(&t, 100));
    }

    #[test]
    fn claude_not_under_root_is_ignored() {
        let t = vec![e(100, 1, "bash"), e(101, 1, "claude")];
        assert!(!claude_descends_from_table(&t, 100));
    }

    #[test]
    fn no_claude_returns_false() {
        let t = vec![e(100, 1, "bash"), e(101, 100, "vim")];
        assert!(!claude_descends_from_table(&t, 100));
    }

    #[test]
    fn ppid_cycle_does_not_loop_forever() {
        // Malformed table with a 2-cycle not reaching root: must terminate.
        let t = vec![e(10, 11, "claude"), e(11, 10, "x")];
        assert!(!claude_descends_from_table(&t, 999));
    }

    #[test]
    fn chain_longer_than_64_is_not_falsely_matched() {
        // claude 70 hops above root; walk caps at 64, so root is never reached.
        let mut t = vec![e(1_000_000, 1, "claude")];
        let mut child = 1_000_000u32;
        for i in 0..70 {
            let parent = child;
            child = 2_000_000 + i;
            t.push(e(child, parent, "sh"));
        }
        let root = child; // bottom of the chain
        assert!(!claude_descends_from_table(&t, root));
    }
}
