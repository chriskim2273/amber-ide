//! Platform-abstracted process introspection: live cwd + ad-hoc-claude
//! detection. OS primitives are cfg-split (Linux `/proc`, macOS `libc`);
//! the ancestor-walk logic is shared and pure. Every primitive degrades to
//! None/empty on failure — it never panics (matches the daemon's contract).

use std::path::PathBuf;

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

// ---- Linux: /proc ----

#[cfg(target_os = "linux")]
pub fn process_table() -> Vec<ProcEntry> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in entries.flatten() {
        let Some(pid) = e.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else {
            continue;
        };
        let Some(ppid) = read_ppid_linux(pid) else { continue };
        let comm = argv0_basename(pid).unwrap_or_default();
        out.push(ProcEntry { pid, ppid, comm });
    }
    out
}

/// Parse ppid from `/proc/<pid>/stat`: after the last ')', ppid is the second
/// whitespace field (process state is first).
#[cfg(target_os = "linux")]
fn read_ppid_linux(pid: u32) -> Option<u32> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let close = stat.rfind(')')?;
    stat[close + 1..].split_whitespace().nth(1)?.parse::<u32>().ok()
}

#[cfg(target_os = "linux")]
pub fn cwd_of(pid: u32) -> Option<PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/cwd")).ok()
}

#[cfg(target_os = "linux")]
pub fn argv0_basename(pid: u32) -> Option<String> {
    let bytes = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    let s = String::from_utf8_lossy(&bytes);
    let argv0 = s.split('\0').next().unwrap_or("");
    if argv0.is_empty() {
        return None;
    }
    Some(argv0.rsplit('/').next().unwrap_or(argv0).to_string())
}

// ---- macOS: libc proc_* ----

/// Read a NUL-terminated C char array into a String (lossy).
#[cfg(target_os = "macos")]
fn cstr_field(buf: &[libc::c_char]) -> String {
    let bytes: Vec<u8> = buf.iter().take_while(|&&c| c != 0).map(|&c| c as u8).collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Fetch a process's BSD info (ppid + comm) in one `proc_pidinfo` call.
#[cfg(target_os = "macos")]
fn bsdinfo(pid: u32) -> Option<libc::proc_bsdinfo> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let sz = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    let r = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            &mut info as *mut _ as *mut libc::c_void,
            sz,
        )
    };
    if r == sz {
        Some(info)
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
pub fn process_table() -> Vec<ProcEntry> {
    // First call sizes the pid buffer; second fills it.
    let n_bytes = unsafe { libc::proc_listpids(libc::PROC_ALL_PIDS, 0, std::ptr::null_mut(), 0) };
    if n_bytes <= 0 {
        return Vec::new();
    }
    let cap = n_bytes as usize / std::mem::size_of::<libc::c_int>();
    let mut pids = vec![0 as libc::c_int; cap];
    let got = unsafe {
        libc::proc_listpids(
            libc::PROC_ALL_PIDS,
            0,
            pids.as_mut_ptr() as *mut libc::c_void,
            n_bytes,
        )
    };
    if got <= 0 {
        return Vec::new();
    }
    let n = got as usize / std::mem::size_of::<libc::c_int>();
    pids.truncate(n);
    let mut out = Vec::new();
    for &pid in &pids {
        if pid <= 0 {
            continue;
        }
        if let Some(info) = bsdinfo(pid as u32) {
            out.push(ProcEntry {
                pid: pid as u32,
                ppid: info.pbi_ppid,
                comm: cstr_field(&info.pbi_comm),
            });
        }
    }
    out
}

#[cfg(target_os = "macos")]
pub fn cwd_of(pid: u32) -> Option<PathBuf> {
    let mut vpi: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
    let sz = std::mem::size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
    let r = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDVNODEPATHINFO,
            0,
            &mut vpi as *mut _ as *mut libc::c_void,
            sz,
        )
    };
    if r != sz {
        return None;
    }
    let path = cstr_field(&vpi.pvi_cdir.vip_path);
    if path.is_empty() {
        None
    } else {
        Some(PathBuf::from(path))
    }
}

#[cfg(target_os = "macos")]
pub fn argv0_basename(pid: u32) -> Option<String> {
    // pbi_comm is the accounting exec name (~16 chars, NUL-terminated). For our
    // sole use — equality with "claude" — it coincides with argv0's basename.
    let comm = cstr_field(&bsdinfo(pid)?.pbi_comm);
    if comm.is_empty() {
        None
    } else {
        Some(comm)
    }
}

// ---- Other OS: degrade (preserves today's silent no-op) ----

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn process_table() -> Vec<ProcEntry> {
    Vec::new()
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn cwd_of(_pid: u32) -> Option<PathBuf> {
    None
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn argv0_basename(_pid: u32) -> Option<String> {
    None
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
        // claude at 5000, ancestor chain 5000 <- 5001 <- ... <- 5070 (70 steps).
        // Walk must traverse up but caps at 64 iterations before reaching root 5070.
        let mut t = vec![e(5000, 5001, "claude")];
        for i in 1..=69 {
            t.push(e(5000 + i, 5000 + i + 1, "link"));
        }
        let root = 5070;
        assert!(!claude_descends_from_table(&t, root));
    }

    #[test]
    fn chain_within_64_reaches_root() {
        // Positive control: when root is within 64 hops, it is found.
        // claude at 5000, parent chain: 5000 <- 5001 <- 5002 <- 5003 (root).
        let t = vec![
            e(5000, 5001, "claude"),
            e(5001, 5002, "link"),
            e(5002, 5003, "link"),
        ];
        let root = 5003;
        assert!(claude_descends_from_table(&t, root));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn self_argv0_basename_is_the_test_binary() {
        let pid = std::process::id();
        let name = argv0_basename(pid).expect("own argv0 readable");
        assert!(!name.is_empty());
        // The test harness binary is not literally "claude".
        assert_ne!(name, "claude");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn self_cwd_of_matches_current_dir() {
        let pid = std::process::id();
        let got = cwd_of(pid).expect("own cwd readable");
        let want = std::env::current_dir().unwrap();
        assert_eq!(got.canonicalize().unwrap(), want.canonicalize().unwrap());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn process_table_contains_self_with_a_ppid() {
        let me = std::process::id();
        let table = process_table();
        let mine = table.iter().find(|e| e.pid == me).expect("self in table");
        assert!(mine.ppid >= 1);
    }
}
