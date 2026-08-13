use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use amber_core::proto::ControlMsg;
use amber_core::state::MemoryConfig;

use crate::manager::SessionManager;
use crate::watchers::Watchers;

pub const RECENT_USE_MS: u64 = 120_000;
const SUSPEND_STALL_MS: u64 = 10_000;
const PRESSURE_REFRESH_MS: u64 = 3_000;
const WINDOW: usize = 5;
const MIN_GROWTH_KB: u64 = 100_000;
const NOISE_KB: u64 = 20_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PressureLevel {
    Normal,
    Warning,
    Critical,
}

pub struct Candidate {
    pub name: String,
    pub memory_kb: u64,
    pub last_used_ms: u64,
    pub is_agent: bool,
    pub running: bool,
    pub has_resume_id: bool,
    pub suspended: bool,
}

pub fn pressure_level(previous: PressureLevel, current_kb: u64, budget_kb: u64) -> PressureLevel {
    if budget_kb == 0 {
        return PressureLevel::Normal;
    }
    let percent = current_kb.saturating_mul(100) / budget_kb;
    match previous {
        PressureLevel::Normal if percent >= 80 => PressureLevel::Critical,
        PressureLevel::Normal if percent >= 70 => PressureLevel::Warning,
        PressureLevel::Normal => PressureLevel::Normal,
        PressureLevel::Warning if percent >= 80 => PressureLevel::Critical,
        PressureLevel::Warning if percent < 65 => PressureLevel::Normal,
        PressureLevel::Warning => PressureLevel::Warning,
        PressureLevel::Critical if percent < 65 => PressureLevel::Normal,
        PressureLevel::Critical if percent < 80 => PressureLevel::Warning,
        PressureLevel::Critical => PressureLevel::Critical,
    }
}

pub fn select_candidate(now_ms: u64, candidates: &[Candidate]) -> Option<&Candidate> {
    candidates
        .iter()
        .filter(|candidate| {
            candidate.is_agent
                && candidate.running
                && candidate.has_resume_id
                && !candidate.suspended
                && now_ms.saturating_sub(candidate.last_used_ms) >= RECENT_USE_MS
        })
        .min_by(|left, right| {
            left.last_used_ms
                .cmp(&right.last_used_ms)
                .then_with(|| right.memory_kb.cmp(&left.memory_kb))
                .then_with(|| left.name.cmp(&right.name))
        })
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct StepDecision {
    pub level: PressureLevel,
    pub candidate: Option<String>,
    pub blocked: bool,
}

pub(crate) fn step(
    previous: PressureLevel,
    now_ms: u64,
    current_kb: u64,
    budget_kb: u64,
    pending_since_ms: Option<u64>,
    candidates: &[Candidate],
) -> StepDecision {
    let level = pressure_level(previous, current_kb, budget_kb);
    if level != PressureLevel::Critical {
        return StepDecision {
            level,
            candidate: None,
            blocked: false,
        };
    }
    if let Some(started) = pending_since_ms {
        return StepDecision {
            level,
            candidate: None,
            blocked: now_ms.saturating_sub(started) >= SUSPEND_STALL_MS,
        };
    }
    let candidate = select_candidate(now_ms, candidates).map(|candidate| candidate.name.clone());
    StepDecision {
        level,
        blocked: candidate.is_none(),
        candidate,
    }
}

fn apply_action(
    decision: &mut StepDecision,
    snapshot: impl FnOnce() -> anyhow::Result<()>,
    suspend: impl FnOnce(&str) -> anyhow::Result<()>,
) -> anyhow::Result<()> {
    let Some(name) = decision.candidate.as_deref() else {
        return Ok(());
    };
    let result = snapshot().and_then(|()| suspend(name));
    if result.is_err() {
        decision.blocked = true;
    }
    result
}

fn should_broadcast(
    previous_level: PressureLevel,
    previous_blocked: bool,
    last_broadcast_ms: Option<u64>,
    now_ms: u64,
    decision: &StepDecision,
) -> bool {
    decision.level != previous_level
        || decision.blocked != previous_blocked
        || last_broadcast_ms.is_none_or(|last| now_ms.saturating_sub(last) >= PRESSURE_REFRESH_MS)
}

fn record_rss_stat(
    histories: &mut HashMap<String, VecDeque<u64>>,
    name: String,
    rss_kb: u64,
) -> ControlMsg {
    let history = histories.entry(name.clone()).or_default();
    history.push_back(rss_kb);
    while history.len() > WINDOW {
        history.pop_front();
    }
    let series: Vec<u64> = history.iter().copied().collect();
    ControlMsg::MemoryStat {
        name,
        rss_kb,
        growing: crate::procinfo::is_growing(&series, MIN_GROWTH_KB, NOISE_KB),
    }
}

fn select_pressure_sample(
    cgroup_enabled: bool,
    cgroup_sample: Option<(u64, HashMap<String, u64>)>,
    rss_sample: Option<(u64, HashMap<String, u64>)>,
) -> Option<(u64, HashMap<String, u64>)> {
    if cgroup_enabled {
        cgroup_sample
    } else {
        rss_sample
    }
}

/// Start the daemon's single memory monitor/guardian thread. Cgroup charge is
/// sampled every second when available; the process table is read once every
/// three ticks for the existing per-session RSS telemetry and as the fallback
/// aggregate on unsupported platforms.
pub fn start(
    manager: Arc<SessionManager>,
    watchers: Arc<Watchers>,
    config: MemoryConfig,
    budget_kb: Option<u64>,
) {
    match budget_kb {
        Some(budget) => eprintln!("amber daemon: memory guardian budget {budget} KiB"),
        None => eprintln!(
            "amber daemon: memory guardian has no aggregate budget; automatic parking disabled"
        ),
    }
    thread::spawn(move || {
        let cgroup_enabled = manager.cgroup_memory_enabled();
        let mut level = PressureLevel::Normal;
        let mut blocked = false;
        let mut last_pressure_broadcast_ms: Option<u64> = None;
        let mut samples: HashMap<String, VecDeque<u64>> = HashMap::new();
        let mut tick = 0u64;
        loop {
            thread::sleep(Duration::from_secs(1));
            tick = tick.wrapping_add(1);
            let cgroup_sample = match manager.cgroup_memory_sample() {
                Ok(sample) => sample,
                Err(error) => {
                    eprintln!("amber daemon: cgroup memory sample failed: {error}");
                    None
                }
            };

            let rss_sample = if tick.is_multiple_of(3) {
                let table = crate::procinfo::process_table();
                if table.is_empty() {
                    None
                } else {
                    let pids = manager.live_pids();
                    let live: HashSet<&str> = pids.iter().map(|(name, _)| name.as_str()).collect();
                    samples.retain(|name, _| live.contains(name.as_str()));
                    let mut per_session = HashMap::new();
                    for (name, pid) in pids {
                        let rss_kb = crate::procinfo::subtree_rss_kb(&table, pid);
                        per_session.insert(name.clone(), rss_kb);
                        let event = record_rss_stat(&mut samples, name, rss_kb);
                        watchers.broadcast(&event);
                    }
                    let total = per_session
                        .values()
                        .copied()
                        .fold(0u64, u64::saturating_add);
                    Some((total, per_session))
                }
            } else {
                None
            };

            let Some(budget) = budget_kb else { continue };
            let Some((current_kb, per_session_kb)) =
                select_pressure_sample(cgroup_enabled, cgroup_sample, rss_sample)
            else {
                continue;
            };
            let now_ms = crate::pty::monotonic_ms();
            let pending_since = config
                .enabled
                .then(|| manager.memory_suspend_pending_since())
                .flatten();
            let next_level = pressure_level(level, current_kb, budget);
            let candidates = if config.enabled
                && next_level == PressureLevel::Critical
                && pending_since.is_none()
            {
                manager.memory_candidates(&per_session_kb)
            } else {
                Vec::new()
            };
            let mut decision = step(
                level,
                now_ms,
                current_kb,
                budget,
                pending_since,
                &candidates,
            );
            if config.enabled {
                if let Err(error) = apply_action(
                    &mut decision,
                    || manager.snapshot(),
                    |name| manager.suspend_for_memory(name, now_ms),
                ) {
                    eprintln!("amber daemon: automatic memory suspend failed: {error}");
                }
            } else {
                decision.candidate = None;
                decision.blocked = false;
            }

            if should_broadcast(
                level,
                blocked,
                last_pressure_broadcast_ms,
                now_ms,
                &decision,
            ) {
                watchers.broadcast_pressure(&ControlMsg::MemoryPressure {
                    level: match decision.level {
                        PressureLevel::Normal => "normal",
                        PressureLevel::Warning => "warning",
                        PressureLevel::Critical => "critical",
                    }
                    .to_string(),
                    current_kb,
                    budget_kb: budget,
                    blocked: decision.blocked,
                });
                last_pressure_broadcast_ms = Some(now_ms);
            }
            level = decision.level;
            blocked = decision.blocked;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use amber_core::state::{ClaudeMeta, SessionKind, StateStore};
    use std::cell::RefCell;
    use std::path::PathBuf;
    use std::sync::Arc;
    use tempfile::tempdir;

    fn candidate(
        name: &str,
        memory_kb: u64,
        last_used_ms: u64,
        is_agent: bool,
        running: bool,
        has_resume_id: bool,
        suspended: bool,
    ) -> Candidate {
        Candidate {
            name: name.to_string(),
            memory_kb,
            last_used_ms,
            is_agent,
            running,
            has_resume_id,
            suspended,
        }
    }

    #[test]
    fn pressure_uses_hysteresis() {
        assert_eq!(
            pressure_level(PressureLevel::Normal, 699, 1000),
            PressureLevel::Normal
        );
        assert_eq!(
            pressure_level(PressureLevel::Normal, 700, 1000),
            PressureLevel::Warning
        );
        assert_eq!(
            pressure_level(PressureLevel::Warning, 800, 1000),
            PressureLevel::Critical
        );
        assert_eq!(
            pressure_level(PressureLevel::Critical, 699, 1000),
            PressureLevel::Warning
        );
        assert_eq!(
            pressure_level(PressureLevel::Warning, 649, 1000),
            PressureLevel::Normal
        );
    }

    #[test]
    fn pressure_covers_zero_budget_direct_critical_and_same_level_branches() {
        assert_eq!(
            pressure_level(PressureLevel::Critical, 900, 0),
            PressureLevel::Normal
        );
        assert_eq!(
            pressure_level(PressureLevel::Normal, 900, 1000),
            PressureLevel::Critical
        );
        assert_eq!(
            pressure_level(PressureLevel::Normal, 100, 1000),
            PressureLevel::Normal
        );
        assert_eq!(
            pressure_level(PressureLevel::Warning, 750, 1000),
            PressureLevel::Warning
        );
        assert_eq!(
            pressure_level(PressureLevel::Critical, 900, 1000),
            PressureLevel::Critical
        );
    }

    #[test]
    fn active_cgroup_failure_keeps_rss_for_telemetry_only_while_disabled_uses_rss_pressure() {
        let mut histories = HashMap::new();
        let telemetry = record_rss_stat(&mut histories, "agent".to_string(), 900);
        let rss_sample = (900, HashMap::from([("agent".to_string(), 900)]));

        assert_eq!(
            telemetry,
            ControlMsg::MemoryStat {
                name: "agent".to_string(),
                rss_kb: 900,
                growing: false,
            }
        );

        assert_eq!(
            select_pressure_sample(true, None, Some(rss_sample.clone())),
            None
        );
        assert_eq!(
            select_pressure_sample(false, None, Some(rss_sample.clone())),
            Some(rss_sample)
        );
    }

    #[test]
    fn selects_oldest_safe_candidate_then_largest_then_name() {
        let now = 500_000;
        let candidates = vec![
            candidate("focused", 1, 400_000, true, true, true, false),
            candidate("b", 900, 100_000, true, true, true, false),
            candidate("a", 900, 100_000, true, true, true, false),
            candidate("shell", 2000, 0, false, true, true, false),
        ];
        assert_eq!(
            select_candidate(now, &candidates).map(|c| c.name.as_str()),
            Some("a")
        );
    }

    #[test]
    fn excludes_recent_unrecorded_nonrunning_and_suspended_sessions() {
        let now = 500_000;
        let cases = [
            candidate("recent", 1, now - 1, true, true, true, false),
            candidate("no-id", 1, 0, true, true, false, false),
            candidate("retrying", 1, 0, true, false, true, false),
            candidate("manual", 1, 0, true, true, true, true),
        ];
        assert!(select_candidate(now, &cases).is_none());
    }

    #[test]
    fn below_warning_and_warning_never_select_a_victim() {
        let candidates = [candidate("old", 10, 0, true, true, true, false)];
        let normal = step(PressureLevel::Normal, 500_000, 699, 1000, None, &candidates);
        assert_eq!(normal.level, PressureLevel::Normal);
        assert_eq!(normal.candidate, None);
        assert!(!normal.blocked);

        let warning = step(PressureLevel::Normal, 500_000, 700, 1000, None, &candidates);
        assert_eq!(warning.level, PressureLevel::Warning);
        assert_eq!(warning.candidate, None);
        assert!(!warning.blocked);
    }

    #[test]
    fn critical_parks_exactly_one_oldest_candidate_after_snapshot() {
        let candidates = [
            candidate("newer", 20, 200_000, true, true, true, false),
            candidate("oldest", 10, 100_000, true, true, true, false),
        ];
        let mut decision = step(
            PressureLevel::Warning,
            500_000,
            800,
            1000,
            None,
            &candidates,
        );
        assert_eq!(decision.candidate.as_deref(), Some("oldest"));

        let calls = RefCell::new(Vec::new());
        apply_action(
            &mut decision,
            || {
                calls.borrow_mut().push("snapshot".to_string());
                Ok(())
            },
            |name| {
                calls.borrow_mut().push(format!("suspend:{name}"));
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(&*calls.borrow(), &["snapshot", "suspend:oldest"]);
        assert!(!decision.blocked);
    }

    #[test]
    fn next_step_remeasures_before_selecting_a_second_victim() {
        let candidates = [candidate("old", 10, 0, true, true, true, false)];
        let first = step(
            PressureLevel::Warning,
            500_000,
            800,
            1000,
            None,
            &candidates,
        );
        assert_eq!(first.candidate.as_deref(), Some("old"));

        let second = step(first.level, 500_001, 799, 1000, None, &candidates);
        assert_eq!(second.level, PressureLevel::Warning);
        assert_eq!(second.candidate, None);
    }

    #[test]
    fn pending_cleanup_delays_blocking_for_ten_seconds_and_prevents_a_second_victim() {
        let candidates = [candidate("other", 10, 0, true, true, true, false)];
        let pending = step(
            PressureLevel::Critical,
            10_999,
            900,
            1000,
            Some(1_000),
            &candidates,
        );
        assert_eq!(pending.candidate, None);
        assert!(!pending.blocked);

        let stalled = step(
            PressureLevel::Critical,
            11_000,
            900,
            1000,
            Some(1_000),
            &candidates,
        );
        assert_eq!(stalled.candidate, None);
        assert!(stalled.blocked);
    }

    #[test]
    fn snapshot_failure_marks_pressure_blocked_without_suspending() {
        let candidates = [candidate("old", 10, 0, true, true, true, false)];
        let mut decision = step(PressureLevel::Normal, 500_000, 900, 1000, None, &candidates);
        let suspended = std::cell::Cell::new(0);
        let error = apply_action(
            &mut decision,
            || anyhow::bail!("disk full"),
            |_| {
                suspended.set(suspended.get() + 1);
                Ok(())
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("disk full"));
        assert_eq!(suspended.get(), 0);
        assert!(decision.blocked);
    }

    #[test]
    fn no_candidate_blocks_once_per_episode_and_below_sixty_five_clears_it() {
        let blocked = step(PressureLevel::Normal, 1, 900, 1000, None, &[]);
        assert_eq!(blocked.level, PressureLevel::Critical);
        assert!(blocked.blocked);
        assert!(should_broadcast(
            PressureLevel::Normal,
            false,
            Some(0),
            1,
            &blocked,
        ));

        let unchanged = step(blocked.level, 2, 900, 1000, None, &[]);
        assert!(!should_broadcast(
            blocked.level,
            blocked.blocked,
            Some(1),
            2,
            &unchanged,
        ));

        let clear = step(blocked.level, 2, 649, 1000, None, &[]);
        assert_eq!(clear.level, PressureLevel::Normal);
        assert!(!clear.blocked);
        assert!(should_broadcast(
            blocked.level,
            blocked.blocked,
            Some(1),
            2,
            &clear,
        ));

        let blocked_again = step(clear.level, 3, 900, 1000, None, &[]);
        assert_eq!(blocked_again.level, PressureLevel::Critical);
        assert!(blocked_again.blocked);
        assert!(should_broadcast(
            clear.level,
            clear.blocked,
            Some(2),
            3,
            &blocked_again,
        ));
    }

    #[test]
    fn clearing_pressure_never_calls_snapshot_or_suspend() {
        let candidates = [candidate("old", 10, 0, true, true, true, false)];
        let mut decision = step(
            PressureLevel::Critical,
            500_000,
            649,
            1000,
            None,
            &candidates,
        );
        let calls = std::cell::Cell::new(0);
        apply_action(
            &mut decision,
            || {
                calls.set(calls.get() + 1);
                Ok(())
            },
            |_| {
                calls.set(calls.get() + 1);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(decision.level, PressureLevel::Normal);
        assert_eq!(calls.get(), 0);
    }

    #[test]
    fn focus_after_selection_fails_the_managers_final_eligibility_recheck() {
        let dir = tempdir().unwrap();
        let manager = Arc::new(crate::manager::SessionManager::new(dir.path()).unwrap());
        let name = "race-agent";
        manager
            // Keep a real shell pty alive, then rewrite only the persisted
            // trust-boundary kind. Spawning an agent kind from a unit test
            // launches the test binary as `amber run` and can exit before the
            // race is exercised.
            .create(name, dir.path(), SessionKind::Shell)
            .unwrap();
        let session = manager.session(name).unwrap();
        session.set_run_state(Some("claude".into()));
        let store = StateStore::new(dir.path());
        let mut meta = store.read_session(name).unwrap().unwrap();
        meta.kind = SessionKind::Claude;
        store.write_session(&meta).unwrap();
        store
            .write_claude(
                name,
                &ClaudeMeta {
                    session_id: "resume-id".into(),
                    cwd: PathBuf::from(dir.path()),
                    updated: 1,
                },
            )
            .unwrap();

        let stale = [candidate(name, 10, 0, true, true, true, false)];
        let decision = step(
            PressureLevel::Normal,
            RECENT_USE_MS,
            900,
            1000,
            None,
            &stale,
        );
        assert_eq!(decision.candidate.as_deref(), Some(name));

        assert!(!manager.focus_session(name).unwrap());
        let error = manager
            .suspend_for_memory(name, crate::pty::monotonic_ms())
            .unwrap_err();
        assert!(error.to_string().contains("recent"));
        assert_eq!(session.suspend_origin(), crate::pty::SuspendOrigin::None);
        manager.remove(name).unwrap();
    }
}
