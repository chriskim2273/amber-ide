use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyState {
    Live,
    Cooling { until: Instant },
    Dead,
}

#[derive(Debug, Clone)]
pub struct KeyHealth {
    dead: bool,
    cooling_until: Option<Instant>,
    consecutive_failures: u32,
    pub requests: u64,
    pub errors: u64,
    pub last_error: Option<String>,
}

impl Default for KeyHealth {
    fn default() -> Self {
        Self::new()
    }
}

impl KeyHealth {
    pub fn new() -> Self {
        KeyHealth {
            dead: false,
            cooling_until: None,
            consecutive_failures: 0,
            requests: 0,
            errors: 0,
            last_error: None,
        }
    }

    pub fn state(&self, now: Instant) -> KeyState {
        if self.dead {
            return KeyState::Dead;
        }
        match self.cooling_until {
            Some(until) if until > now => KeyState::Cooling { until },
            _ => KeyState::Live,
        }
    }

    pub fn record_success(&mut self) {
        self.consecutive_failures = 0;
        self.cooling_until = None;
        self.requests += 1;
    }

    pub fn record_error(&mut self, msg: String) {
        self.requests += 1;
        self.errors += 1;
        self.last_error = Some(msg);
    }

    pub fn mark_dead(&mut self) {
        self.dead = true;
    }

    pub fn cool_down(
        &mut self,
        now: Instant,
        retry_after: Option<Duration>,
        default_ms: u64,
        max_ms: u64,
    ) {
        // Don't change state if we're dead
        if self.dead {
            return;
        }

        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        let wait = match retry_after {
            // Honored verbatim: a multi-hour value is daily-quota exhaustion, not a burst.
            Some(d) => d,
            None => {
                let shift = (self.consecutive_failures - 1).min(6);
                let ms = default_ms.saturating_mul(1u64 << shift).min(max_ms);
                Duration::from_millis(ms)
            }
        };
        self.cooling_until = Some(now + wait);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn starts_live() {
        let h = KeyHealth::new();
        assert!(matches!(h.state(Instant::now()), KeyState::Live));
    }

    #[test]
    fn cooldown_without_retry_after_uses_exponential_backoff() {
        let now = Instant::now();
        let mut h = KeyHealth::new();

        h.cool_down(now, None, 1_000, 60_000);
        assert!(matches!(h.state(now), KeyState::Cooling { .. }));
        assert!(matches!(
            h.state(now + Duration::from_millis(1_001)),
            KeyState::Live
        ));

        h.cool_down(now, None, 1_000, 60_000);
        assert!(matches!(
            h.state(now + Duration::from_millis(1_500)),
            KeyState::Cooling { .. }
        ));
        assert!(matches!(
            h.state(now + Duration::from_millis(2_001)),
            KeyState::Live
        ));
    }

    #[test]
    fn backoff_is_clamped_to_max() {
        let now = Instant::now();
        let mut h = KeyHealth::new();
        for _ in 0..10 {
            h.cool_down(now, None, 1_000, 5_000);
        }
        assert!(matches!(
            h.state(now + Duration::from_millis(5_001)),
            KeyState::Live
        ));
    }

    #[test]
    fn explicit_retry_after_is_honored_beyond_max() {
        let now = Instant::now();
        let mut h = KeyHealth::new();
        h.cool_down(now, Some(Duration::from_secs(7_200)), 1_000, 5_000);
        assert!(matches!(
            h.state(now + Duration::from_secs(3_600)),
            KeyState::Cooling { .. }
        ));
        assert!(matches!(
            h.state(now + Duration::from_secs(7_201)),
            KeyState::Live
        ));
    }

    #[test]
    fn success_resets_backoff() {
        let now = Instant::now();
        let mut h = KeyHealth::new();
        h.cool_down(now, None, 1_000, 60_000);
        h.cool_down(now, None, 1_000, 60_000);
        h.record_success();
        h.cool_down(now, None, 1_000, 60_000);
        assert!(matches!(
            h.state(now + Duration::from_millis(1_001)),
            KeyState::Live
        ));
    }

    #[test]
    fn dead_is_permanent() {
        let now = Instant::now();
        let mut h = KeyHealth::new();
        h.mark_dead();
        assert!(matches!(
            h.state(now + Duration::from_secs(86_400)),
            KeyState::Dead
        ));
    }

    #[test]
    fn dead_survives_a_later_cooldown_call() {
        let now = Instant::now();
        let mut h = KeyHealth::new();
        h.mark_dead();
        h.cool_down(now, None, 1_000, 60_000);
        assert!(matches!(h.state(now), KeyState::Dead));
    }
}
