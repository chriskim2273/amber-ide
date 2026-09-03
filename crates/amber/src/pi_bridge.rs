//! Bounded command registry for the optional Pi semantic sideband.
//!
//! This is transport state, not session truth. The existing Pi process and PTY
//! remain authoritative; a bridge may disappear/reconnect without changing the
//! daemon session. Commands are `try_send`-only so a stuck extension can never
//! block a daemon connection thread.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::Mutex;

use amber_core::proto::PiCommand;

const COMMAND_QUEUE_DEPTH: usize = 16;

struct Entry {
    generation: u64,
    tx: SyncSender<PiCommand>,
}

pub struct Registration {
    pub name: String,
    pub generation: u64,
    pub rx: Receiver<PiCommand>,
}

#[derive(Default)]
pub struct PiBridges {
    entries: Mutex<HashMap<String, Entry>>,
    next_generation: AtomicU64,
}

impl PiBridges {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register or replace the live bridge for `name`. Dropping the replaced
    /// sender disconnects its receiver; that private writer-forwarder exits.
    pub fn register(&self, name: &str) -> Registration {
        // Zero is reserved for "no generation" in diagnostics/tests.
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = sync_channel(COMMAND_QUEUE_DEPTH);
        self.entries
            .lock()
            .unwrap()
            .insert(name.to_string(), Entry { generation, tx });
        Registration { name: name.to_string(), generation, rx }
    }

    /// Remove only the registration this connection created. An old bridge
    /// tearing down after replacement must not erase the replacement.
    pub fn unregister(&self, name: &str, generation: u64) -> bool {
        let mut entries = self.entries.lock().unwrap();
        if entries.get(name).is_some_and(|entry| entry.generation == generation) {
            entries.remove(name);
            true
        } else {
            false
        }
    }

    pub fn remove(&self, name: &str) -> bool {
        self.entries.lock().unwrap().remove(name).is_some()
    }

    pub fn contains(&self, name: &str) -> bool {
        self.entries.lock().unwrap().contains_key(name)
    }

    /// Check that an event came from the currently registered bridge, not a
    /// stale extension connection that was replaced or whose session was
    /// killed. The generation is deliberately part of the connection-local
    /// authorization check; name-only checks would let an old Pi process keep
    /// publishing after a replacement.
    pub fn is_current(&self, name: &str, generation: u64) -> bool {
        self.entries
            .lock()
            .unwrap()
            .get(name)
            .is_some_and(|entry| entry.generation == generation)
    }

    pub fn send(&self, name: &str, command: PiCommand) -> anyhow::Result<()> {
        let mut entries = self.entries.lock().unwrap();
        let Some(entry) = entries.get(name) else {
            anyhow::bail!("Pi graphical bridge is unavailable for session {name}");
        };
        match entry.tx.try_send(command) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => {
                anyhow::bail!("Pi graphical bridge command queue is full for session {name}")
            }
            Err(TrySendError::Disconnected(_)) => {
                entries.remove(name);
                anyhow::bail!("Pi graphical bridge disconnected for session {name}")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registration_replacement_and_generation_safe_cleanup() {
        let bridges = PiBridges::new();
        let first = bridges.register("pi");
        let second = bridges.register("pi");
        assert!(bridges.contains("pi"));
        assert!(!bridges.is_current("pi", first.generation));
        assert!(bridges.is_current("pi", second.generation));
        assert!(first.rx.recv().is_err(), "replacement must close the old receiver");
        assert!(!bridges.unregister("pi", first.generation));
        assert!(bridges.contains("pi"), "stale teardown removed replacement");
        assert!(bridges.unregister("pi", second.generation));
        assert!(!bridges.contains("pi"));
    }

    #[test]
    fn send_is_bounded_and_never_waits_for_the_extension() {
        let bridges = PiBridges::new();
        let registration = bridges.register("pi");
        for _ in 0..COMMAND_QUEUE_DEPTH {
            bridges.send("pi", PiCommand::Snapshot).unwrap();
        }
        assert!(bridges.send("pi", PiCommand::Abort).unwrap_err().to_string().contains("queue is full"));
        drop(registration);
    }

    #[test]
    fn missing_or_disconnected_bridge_is_an_error_and_is_pruned() {
        let bridges = PiBridges::new();
        assert!(bridges.send("missing", PiCommand::Snapshot).is_err());
        let registration = bridges.register("pi");
        drop(registration.rx);
        assert!(bridges.send("pi", PiCommand::Snapshot).is_err());
        assert!(!bridges.contains("pi"));
    }
}
