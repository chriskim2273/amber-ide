use amber_core::state::PressureConfig;

/// The Linux PSI signals Amber evaluates for sustained resource pressure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostPressureCause {
    Cpu,
    Io,
    Memory,
}

/// A single, simultaneous PSI observation expressed as percentages.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HostPressureSample {
    pub cpu_some_percent: f64,
    pub io_full_percent: f64,
    pub memory_full_percent: f64,
}

/// Pure policy outcome for one PSI observation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostPressureDecision {
    Normal,
    /// PSI could not be read or parsed. The current sustained episode remains
    /// intact, but this observation cannot authorize an automatic action.
    Unavailable,
    Critical {
        causes: Vec<HostPressureCause>,
        can_park: bool,
    },
}

/// Sustained-host-pressure policy state. It deliberately owns no I/O and does
/// not select or suspend sessions; the guardian consumes `can_park` later.
#[derive(Debug, Clone)]
pub struct HostPressureState {
    config: PressureConfig,
    episode_started_ms: Option<u64>,
    cooldown_until_ms: Option<u64>,
}

impl HostPressureState {
    pub fn new(config: PressureConfig) -> Self {
        Self {
            config,
            episode_started_ms: None,
            cooldown_until_ms: None,
        }
    }

    pub fn step(
        &mut self,
        now_ms: u64,
        sample: Option<HostPressureSample>,
    ) -> HostPressureDecision {
        let Some(sample) = sample else {
            return HostPressureDecision::Unavailable;
        };

        let causes = self.causes(sample);
        if causes.is_empty() {
            self.episode_started_ms = None;
            return HostPressureDecision::Normal;
        }

        let started_ms = *self.episode_started_ms.get_or_insert(now_ms);
        let sustained = now_ms.saturating_sub(started_ms)
            >= self.config.sustain_seconds.saturating_mul(1_000);
        let cooldown_complete = self
            .cooldown_until_ms
            .is_none_or(|until_ms| now_ms >= until_ms);
        let can_park = sustained && cooldown_complete;

        HostPressureDecision::Critical { causes, can_park }
    }

    /// Start the cooldown after the guardian has actually parked one session.
    /// A merely eligible but blocked decision must remain eligible so the next
    /// safe candidate can be considered without an arbitrary delay.
    pub fn record_parked(&mut self, now_ms: u64) {
        self.cooldown_until_ms = Some(
            now_ms.saturating_add(self.config.cooldown_seconds.saturating_mul(1_000)),
        );
    }

    fn causes(&self, sample: HostPressureSample) -> Vec<HostPressureCause> {
        let mut causes = Vec::with_capacity(3);
        if sample.cpu_some_percent.is_finite()
            && sample.cpu_some_percent >= self.config.cpu_some_percent
        {
            causes.push(HostPressureCause::Cpu);
        }
        if sample.io_full_percent.is_finite()
            && sample.io_full_percent >= self.config.io_full_percent
        {
            causes.push(HostPressureCause::Io);
        }
        if sample.memory_full_percent.is_finite()
            && sample.memory_full_percent >= self.config.memory_full_percent
        {
            causes.push(HostPressureCause::Memory);
        }
        causes
    }
}

/// Parse `avg10` from one PSI row, rejecting missing, malformed, and non-finite
/// values. The caller decides which PSI row (`some` or `full`) is appropriate.
pub fn parse_psi_avg10(row: &str) -> Option<f64> {
    row.split_whitespace()
        .find_map(|field| field.strip_prefix("avg10="))?
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
}

fn parse_psi_kind(contents: &str, kind: &str) -> Option<f64> {
    contents
        .lines()
        .find(|line| line.split_whitespace().next() == Some(kind))
        .and_then(parse_psi_avg10)
}

/// Unsupported platforms disable PSI polling for the whole guardian run.
/// Linux keeps this enabled after unavailable samples so a transient `/proc`
/// read or parse error is retried on the next tick.
pub const fn polling_supported() -> bool {
    cfg!(target_os = "linux")
}

/// Read the three Linux PSI inputs as one all-or-nothing observation.
///
/// Keeping this adapter small makes parsing and policy transitions testable
/// without `/proc`; a missing or malformed source becomes an unavailable
/// sample rather than a fabricated normal reading.
#[cfg(target_os = "linux")]
pub fn sample_linux() -> Option<HostPressureSample> {
    let cpu = std::fs::read_to_string("/proc/pressure/cpu").ok()?;
    let io = std::fs::read_to_string("/proc/pressure/io").ok()?;
    let memory = std::fs::read_to_string("/proc/pressure/memory").ok()?;
    Some(HostPressureSample {
        cpu_some_percent: parse_psi_kind(&cpu, "some")?,
        io_full_percent: parse_psi_kind(&io, "full")?,
        memory_full_percent: parse_psi_kind(&memory, "full")?,
    })
}

#[cfg(not(target_os = "linux"))]
pub fn sample_linux() -> Option<HostPressureSample> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use amber_core::state::PressureConfig;

    fn sample(cpu_some_percent: f64, io_full_percent: f64, memory_full_percent: f64) -> HostPressureSample {
        HostPressureSample {
            cpu_some_percent,
            io_full_percent,
            memory_full_percent,
        }
    }

    fn critical(decision: HostPressureDecision, causes: Vec<HostPressureCause>, can_park: bool) {
        assert_eq!(
            decision,
            HostPressureDecision::Critical { causes, can_park },
        );
    }

    #[test]
    fn parses_avg10_from_valid_psi_rows() {
        // A parser that selects avg60 or a total value would delay or invent a
        // policy action; only PSI's avg10 window is the configured signal.
        assert_eq!(
            parse_psi_avg10("some avg10=25.50 avg60=12.25 avg300=5.00 total=12"),
            Some(25.5),
        );
        assert_eq!(
            parse_psi_avg10("full avg10=2.00 avg60=1.00 avg300=0.50 total=3"),
            Some(2.0),
        );
    }

    #[test]
    fn host_psi_polling_matches_compile_time_platform_support() {
        assert_eq!(polling_supported(), cfg!(target_os = "linux"));
    }

    #[test]
    fn rejects_psi_rows_without_a_finite_avg10() {
        // A malformed PSI read must be unavailable, never quietly treated as
        // normal and allowed to erase a live pressure episode.
        for row in [
            "some avg60=12.25 avg300=5.00 total=12",
            "some avg10=not-a-number avg60=12.25 total=12",
            "some avg10=NaN avg60=12.25 total=12",
            "some avg10=inf avg60=12.25 total=12",
        ] {
            assert_eq!(parse_psi_avg10(row), None, "row: {row}");
        }
    }

    #[test]
    fn critical_causes_reflect_each_crossed_threshold() {
        // Cause labels feed the client banner; omitting a crossed input would
        // leave operators with a misleading explanation for an action.
        let config = PressureConfig::default();
        let mut state = HostPressureState::new(config);
        critical(
            state.step(0, Some(sample(25.0, 20.0, 2.0))),
            vec![
                HostPressureCause::Cpu,
                HostPressureCause::Io,
                HostPressureCause::Memory,
            ],
            false,
        );
    }

    #[test]
    fn pressure_cannot_park_before_the_sustain_interval() {
        // An off-by-one timestamp could park a user-visible session one
        // millisecond before the promised 120 consecutive seconds.
        let mut state = HostPressureState::new(PressureConfig::default());
        critical(
            state.step(0, Some(sample(25.0, 0.0, 0.0))),
            vec![HostPressureCause::Cpu],
            false,
        );
        critical(
            state.step(119_999, Some(sample(25.0, 0.0, 0.0))),
            vec![HostPressureCause::Cpu],
            false,
        );
    }

    #[test]
    fn pressure_becomes_eligible_at_the_sustain_interval() {
        // The first exactly eligible sample must permit one action rather than
        // requiring an extra polling interval.
        let mut state = HostPressureState::new(PressureConfig::default());
        state.step(0, Some(sample(25.0, 0.0, 0.0)));
        critical(
            state.step(120_000, Some(sample(25.0, 0.0, 0.0))),
            vec![HostPressureCause::Cpu],
            true,
        );
    }

    #[test]
    fn clearing_every_cause_cancels_the_live_episode() {
        // Returning to normal before eligibility must reset the start time;
        // otherwise disjoint pressure bursts accumulate into a false action.
        let mut state = HostPressureState::new(PressureConfig::default());
        state.step(0, Some(sample(25.0, 0.0, 0.0)));
        assert_eq!(
            state.step(119_999, Some(sample(0.0, 0.0, 0.0))),
            HostPressureDecision::Normal,
        );
        critical(
            state.step(120_000, Some(sample(25.0, 0.0, 0.0))),
            vec![HostPressureCause::Cpu],
            false,
        );
    }

    #[test]
    fn unavailable_samples_preserve_but_cannot_trigger_an_episode() {
        // A transient /proc read failure must neither clear sustained pressure
        // nor manufacture a parking action from data it did not observe.
        let mut state = HostPressureState::new(PressureConfig::default());
        state.step(0, Some(sample(25.0, 0.0, 0.0)));
        assert_eq!(state.step(120_000, None), HostPressureDecision::Unavailable);
        critical(
            state.step(120_001, Some(sample(25.0, 0.0, 0.0))),
            vec![HostPressureCause::Cpu],
            true,
        );
    }

    #[test]
    fn cooldown_starts_only_after_a_park_is_recorded() {
        // Eligibility alone may be blocked by the manager. The cooldown starts
        // only after a real park, so a transiently unavailable candidate does
        // not suppress the next valid action for ten seconds.
        let mut state = HostPressureState::new(PressureConfig::default());
        state.step(0, Some(sample(25.0, 0.0, 0.0)));
        critical(
            state.step(120_000, Some(sample(25.0, 0.0, 0.0))),
            vec![HostPressureCause::Cpu],
            true,
        );
        critical(
            state.step(120_001, Some(sample(25.0, 0.0, 0.0))),
            vec![HostPressureCause::Cpu],
            true,
        );
        state.record_parked(120_001);
        critical(
            state.step(130_000, Some(sample(25.0, 0.0, 0.0))),
            vec![HostPressureCause::Cpu],
            false,
        );
        critical(
            state.step(130_001, Some(sample(25.0, 0.0, 0.0))),
            vec![HostPressureCause::Cpu],
            true,
        );
    }
}
