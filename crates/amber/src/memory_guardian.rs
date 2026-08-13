pub const RECENT_USE_MS: u64 = 120_000;

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

#[cfg(test)]
mod tests {
    use super::*;

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
}
