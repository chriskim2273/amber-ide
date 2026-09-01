use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};

use router_core::health::{KeyHealth, KeyState};
use router_core::registry::{Endpoint, Registry};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcquireError {
    AllDead,
    Timeout,
}

pub struct Lease {
    pub endpoint: Endpoint,
    permit: Option<OwnedSemaphorePermit>,
    in_flight: Arc<AtomicUsize>,
    notify: Arc<Notify>,
}

impl std::fmt::Debug for Lease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Lease")
            .field("endpoint", &self.endpoint)
            .finish()
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        // Ordering is load-bearing: the permit must be released before we notify,
        // or a woken waiter can observe the permit as still taken and fall through
        // to the 50ms poll. Decrement in_flight before notifying too, so a waiter
        // that re-scans on wake sees consistent state. Do not reorder.
        self.permit.take();
        self.in_flight.fetch_sub(1, Ordering::SeqCst);
        self.notify.notify_waiters();
    }
}

#[derive(Debug, Clone)]
pub struct KeySnapshot {
    pub label: String,
    pub state: &'static str,
    pub cooling_secs_remaining: Option<u64>,
    pub in_flight: usize,
    pub requests: u64,
    pub errors: u64,
    pub last_error: Option<String>,
}

struct KeyRuntime {
    provider_idx: usize,
    key_idx: usize,
    semaphore: Arc<Semaphore>,
    in_flight: Arc<AtomicUsize>,
    health: Mutex<KeyHealth>,
}

pub struct Selector {
    registry: Arc<Registry>,
    keys: Vec<KeyRuntime>,
    notify: Arc<Notify>,
}

impl Selector {
    pub fn new(registry: Arc<Registry>) -> Selector {
        let mut keys = Vec::with_capacity(registry.key_count());
        for provider_idx in 0..registry.provider_count() {
            let provider = registry.provider(provider_idx);
            for key_idx in 0..provider.keys.len() {
                assert_eq!(keys.len(), registry.flat_key_index(provider_idx, key_idx));
                keys.push(KeyRuntime {
                    provider_idx,
                    key_idx,
                    semaphore: Arc::new(Semaphore::new(provider.max_inflight_per_key)),
                    in_flight: Arc::new(AtomicUsize::new(0)),
                    health: Mutex::new(KeyHealth::new()),
                });
            }
        }
        assert_eq!(keys.len(), registry.key_count());
        Selector {
            registry,
            keys,
            notify: Arc::new(Notify::new()),
        }
    }

    fn slot(&self, e: &Endpoint) -> &KeyRuntime {
        &self.keys[self.registry.flat_key_index(e.provider_idx, e.key_idx)]
    }

    pub async fn acquire(
        &self,
        chain: &[Endpoint],
        deadline: Instant,
    ) -> Result<Lease, AcquireError> {
        loop {
            let now = Instant::now();
            if now >= deadline {
                return Err(AcquireError::Timeout);
            }

            // Register for wakeups BEFORE scanning, so a release that lands mid-scan
            // is not lost. `enable()` performs the registration without awaiting.
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            let mut any_live = false;
            let mut earliest_cooling: Option<Instant> = None;
            let mut found: Option<(Endpoint, OwnedSemaphorePermit, Arc<AtomicUsize>)> = None;

            for endpoint in chain {
                let slot = self.slot(endpoint);
                let state = {
                    let guard = slot.health.lock().unwrap();
                    guard.state(now)
                };
                match state {
                    KeyState::Dead => continue,
                    KeyState::Cooling { until } => {
                        earliest_cooling = Some(match earliest_cooling {
                            Some(cur) if cur <= until => cur,
                            _ => until,
                        });
                    }
                    KeyState::Live => {
                        any_live = true;
                        if let Ok(permit) = slot.semaphore.clone().try_acquire_owned() {
                            found = Some((endpoint.clone(), permit, slot.in_flight.clone()));
                            break;
                        }
                    }
                }
            }

            if let Some((endpoint, permit, in_flight)) = found {
                in_flight.fetch_add(1, Ordering::SeqCst);
                return Ok(Lease {
                    endpoint,
                    permit: Some(permit),
                    in_flight,
                    notify: self.notify.clone(),
                });
            }

            if !any_live && earliest_cooling.is_none() {
                return Err(AcquireError::AllDead);
            }

            let wake_at = if any_live {
                now + Duration::from_millis(50)
            } else {
                earliest_cooling.unwrap_or(deadline)
            }
            .min(deadline);

            let sleep = tokio::time::sleep_until(tokio::time::Instant::from_std(wake_at));
            tokio::select! {
                _ = sleep => {}
                _ = notified => {}
            }
        }
    }

    pub fn report_success(&self, e: &Endpoint) {
        self.slot(e).health.lock().unwrap().record_success();
        self.notify.notify_waiters();
    }

    pub fn report_cooldown(&self, e: &Endpoint, retry_after: Option<Duration>, msg: String) {
        let provider = self.registry.provider(e.provider_idx);
        let slot = self.slot(e);
        let mut h = slot.health.lock().unwrap();
        h.record_error(msg);
        h.cool_down(
            Instant::now(),
            retry_after,
            provider.default_cooldown_ms,
            provider.max_cooldown_ms,
        );
        drop(h);
        self.notify.notify_waiters();
    }

    pub fn report_dead(&self, e: &Endpoint, msg: String) {
        let slot = self.slot(e);
        let mut h = slot.health.lock().unwrap();
        h.record_error(msg);
        h.mark_dead();
        drop(h);
        self.notify.notify_waiters();
    }

    pub fn snapshot(&self) -> Vec<KeySnapshot> {
        let now = Instant::now();
        self.keys
            .iter()
            .map(|k| {
                let h = k.health.lock().unwrap();
                let (state, cooling_secs_remaining) = match h.state(now) {
                    KeyState::Live => ("live", None),
                    KeyState::Dead => ("dead", None),
                    KeyState::Cooling { until } => (
                        "cooling",
                        Some(until.saturating_duration_since(now).as_secs()),
                    ),
                };
                let label = self.registry.key_label(&Endpoint {
                    provider_idx: k.provider_idx,
                    key_idx: k.key_idx,
                    model_id: std::sync::Arc::from(""),
                });
                KeySnapshot {
                    label,
                    state,
                    cooling_secs_remaining,
                    in_flight: k.in_flight.load(Ordering::SeqCst),
                    requests: h.requests,
                    errors: h.errors,
                    last_error: h.last_error.clone(),
                }
            })
            .collect()
    }
}
