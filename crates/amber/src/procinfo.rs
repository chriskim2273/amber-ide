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
    /// Resident set size in KiB (0 if unreadable). Summed per session subtree
    /// by [`subtree_rss_kb`] for the memory monitor.
    pub rss_kb: u64,
}

/// Total RSS (KiB) of `root` plus every descendant in `table`. Pure over the
/// table — no syscalls. A `seen` set bounds it so a malformed ppid cycle can't
/// loop, and self-parented / unknown roots are handled. Returns 0 if `root` is
/// absent. This is the per-session figure the monitor broadcasts: a pane's
/// child pty runs one process which may fork a whole tree (shell → claude → …).
pub fn subtree_rss_kb(table: &[ProcEntry], root: u32) -> u64 {
    use std::collections::{HashMap, HashSet, VecDeque};
    let mut rss_of: HashMap<u32, u64> = HashMap::with_capacity(table.len());
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for e in table {
        rss_of.insert(e.pid, e.rss_kb);
        if e.pid != e.ppid {
            children.entry(e.ppid).or_default().push(e.pid);
        }
    }
    if !rss_of.contains_key(&root) {
        return 0;
    }
    let mut total = 0u64;
    let mut seen: HashSet<u32> = HashSet::new();
    let mut q: VecDeque<u32> = VecDeque::new();
    seen.insert(root);
    q.push_back(root);
    while let Some(pid) = q.pop_front() {
        total = total.saturating_add(*rss_of.get(&pid).unwrap_or(&0));
        if let Some(kids) = children.get(&pid) {
            for &kid in kids {
                if seen.insert(kid) {
                    q.push_back(kid);
                }
            }
        }
    }
    total
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

/// Sustained-growth (leak) detector over `samples` (oldest→newest RSS KiB).
/// True when: enough samples, the newest exceeds the oldest by more than
/// `min_growth_kb`, AND it never dipped by more than `noise_kb` along the way
/// (a leak climbs monotonically; a stable-but-big process stays flat and is NOT
/// flagged — that's the "don't punish a legit claude" rule from the design).
/// Pure — drives only the UI warning badge in Slice 1.
pub fn is_growing(samples: &[u64], min_growth_kb: u64, noise_kb: u64) -> bool {
    if samples.len() < 3 {
        return false;
    }
    let first = samples[0];
    let last = samples[samples.len() - 1];
    if last <= first.saturating_add(min_growth_kb) {
        return false;
    }
    for w in samples.windows(2) {
        if w[0] > w[1].saturating_add(noise_kb) {
            return false; // a material dip breaks the "sustained rise"
        }
    }
    true
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
        let rss_kb = read_rss_kb_linux(pid);
        out.push(ProcEntry { pid, ppid, comm, rss_kb });
    }
    out
}

/// Resident set size (KiB) of `pid`. `/proc/<pid>/smaps_rollup` aggregates the
/// whole address space and reports `Rss:` already in KiB — no page-size math.
/// Falls back to `statm` (resident pages × 4 KiB) if rollup is unavailable
/// (very old kernel / permissions). 0 when nothing is readable (dead/denied).
#[cfg(target_os = "linux")]
fn read_rss_kb_linux(pid: u32) -> u64 {
    if let Ok(s) = std::fs::read_to_string(format!("/proc/{pid}/smaps_rollup")) {
        for line in s.lines() {
            if let Some(rest) = line.strip_prefix("Rss:") {
                if let Some(kb) = rest.split_whitespace().next().and_then(|n| n.parse::<u64>().ok()) {
                    return kb;
                }
            }
        }
    }
    // Fallback: statm field 2 (resident pages) × 4 KiB (assumes 4 KiB pages).
    std::fs::read_to_string(format!("/proc/{pid}/statm"))
        .ok()
        .and_then(|s| s.split_whitespace().nth(1).and_then(|f| f.parse::<u64>().ok()))
        .map(|pages| pages.saturating_mul(4))
        .unwrap_or(0)
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

/// `PROC_ALL_PIDS` from Darwin's `<sys/proc_info.h>` — not exposed by `libc`.
#[cfg(target_os = "macos")]
const PROC_ALL_PIDS: u32 = 1;

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
    let n_bytes = unsafe { libc::proc_listpids(PROC_ALL_PIDS, 0, std::ptr::null_mut(), 0) };
    if n_bytes <= 0 {
        return Vec::new();
    }
    let cap = n_bytes as usize / std::mem::size_of::<libc::c_int>();
    let mut pids = vec![0 as libc::c_int; cap];
    let got = unsafe {
        libc::proc_listpids(
            PROC_ALL_PIDS,
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
                rss_kb: read_rss_kb_macos(pid as u32),
            });
        }
    }
    out
}

/// Resident set size (KiB) of `pid` via `proc_pidinfo(PROC_PIDTASKINFO)`'s
/// `pti_resident_size` (bytes). 0 on failure (dead/denied).
#[cfg(target_os = "macos")]
fn read_rss_kb_macos(pid: u32) -> u64 {
    let mut ti: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
    let sz = std::mem::size_of::<libc::proc_taskinfo>() as libc::c_int;
    let r = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTASKINFO,
            0,
            &mut ti as *mut _ as *mut libc::c_void,
            sz,
        )
    };
    if r == sz {
        ti.pti_resident_size / 1024
    } else {
        0
    }
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
    // `vip_path` is `[[c_char; 32]; 32]` in this libc (a 1024-byte stand-in for
    // `[c_char; MAXPATHLEN]`, worked around for old-rustc array-impl limits) —
    // flatten it to the flat slice `cstr_field` expects.
    let vip = &vpi.pvi_cdir.vip_path;
    let flat = unsafe { std::slice::from_raw_parts(vip.as_ptr() as *const libc::c_char, 32 * 32) };
    let path = cstr_field(flat);
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
        ProcEntry { pid, ppid, comm: comm.to_string(), rss_kb: 0 }
    }

    /// Like `e` but with an RSS (KiB) — for subtree_rss_kb tests.
    fn er(pid: u32, ppid: u32, rss_kb: u64) -> ProcEntry {
        ProcEntry { pid, ppid, comm: String::new(), rss_kb }
    }

    #[test]
    fn subtree_rss_sums_root_and_all_descendants() {
        // root 100 (10) -> 200 (20) -> 300 (30); plus sibling 201 (5) under 100.
        let t = vec![er(100, 1, 10), er(200, 100, 20), er(300, 200, 30), er(201, 100, 5)];
        assert_eq!(subtree_rss_kb(&t, 100), 65); // 10+20+30+5
        assert_eq!(subtree_rss_kb(&t, 200), 50); // 20+30 (subtree from 200)
        assert_eq!(subtree_rss_kb(&t, 300), 30); // leaf
    }

    #[test]
    fn subtree_rss_absent_root_is_zero() {
        let t = vec![er(100, 1, 10)];
        assert_eq!(subtree_rss_kb(&t, 999), 0);
    }

    #[test]
    fn subtree_rss_ignores_unrelated_trees() {
        let t = vec![er(100, 1, 10), er(500, 1, 999)]; // 500 not under 100
        assert_eq!(subtree_rss_kb(&t, 100), 10);
    }

    #[test]
    fn subtree_rss_cycle_terminates() {
        // Malformed 2-cycle 10<->11 not reaching root; must not loop.
        let t = vec![er(10, 11, 1), er(11, 10, 2)];
        assert_eq!(subtree_rss_kb(&t, 10), 3); // both counted once, no infinite loop
    }

    #[test]
    fn subtree_rss_self_parented_root_counts_once() {
        // A self-parented pid (pid == ppid) must not be treated as its own child.
        let t = vec![er(7, 7, 42)];
        assert_eq!(subtree_rss_kb(&t, 7), 42);
    }

    #[test]
    fn is_growing_flags_sustained_rise() {
        // Climbs 100 -> 400 (KiB), delta 300 > min 100, no dips.
        assert!(is_growing(&[100, 200, 300, 400], 100, 50));
    }

    #[test]
    fn is_growing_ignores_stable_high() {
        // Big but FLAT (jitters ~6 MiB) — a healthy claude, not a leak. With a
        // realistic 50 MiB min-growth threshold the net rise (2 MiB) is ignored.
        assert!(!is_growing(&[900_000, 905_000, 899_000, 902_000], 50_000, 50_000));
    }

    #[test]
    fn is_growing_needs_enough_samples() {
        assert!(!is_growing(&[10, 9999], 1, 0)); // < 3 samples
        assert!(!is_growing(&[], 1, 0));
    }

    #[test]
    fn is_growing_rejects_a_material_dip() {
        // Net rise 100->400 but dips 300->150 mid-window beyond noise → not sustained.
        assert!(!is_growing(&[100, 300, 150, 400], 100, 20));
    }

    #[test]
    fn is_growing_requires_min_delta() {
        // Rises monotonically but only by 30 < min 100 → not flagged.
        assert!(!is_growing(&[100, 110, 120, 130], 100, 10));
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
    fn claude_directly_under_pid_1_root_is_detected() {
        // Root is pid 1 (e.g. init/launchd adopted the pane's shell). The
        // `pp == root` guard must fire before the `pp > 1` stop condition.
        let t = vec![e(1, 0, "init"), e(50, 1, "claude")];
        assert!(claude_descends_from_table(&t, 1));
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
