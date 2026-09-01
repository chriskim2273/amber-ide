//! The swappable half of the server.
//!
//! Slots are edited while the router is running, so the registry cannot be
//! built once at startup. `Live` holds the current `AppState` behind a lock:
//! a request takes a clone of the `Arc` and finishes against that snapshot,
//! so an edit never yanks the registry out from under an in-flight stream —
//! it only decides what the *next* request sees.

use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use router_core::config::ServerConfig;

use crate::slots::Slot;
use crate::state::AppState;
use crate::store;

#[derive(Clone)]
pub struct Live {
    current: Arc<RwLock<Arc<AppState>>>,
    /// State root. `None` in tests and anywhere the admin surface is off.
    root: Option<PathBuf>,
    server: ServerConfig,
}

impl Live {
    pub fn detached(state: AppState) -> Live {
        Live {
            current: Arc::new(RwLock::new(Arc::new(state))),
            root: None,
            server: store::default_server(),
        }
    }

    /// Build from the slots on disk. The server section is ours, not the
    /// file's: the bind address and the bearer token come from the service
    /// arguments and the 0600 token file, never from editable config.
    pub fn from_store(root: &Path, server: ServerConfig) -> anyhow::Result<Live> {
        let slots = store::load(root)?;
        let state = AppState::new(crate::slots::to_config(server.clone(), &slots));
        Ok(Live {
            current: Arc::new(RwLock::new(Arc::new(state))),
            root: Some(root.to_path_buf()),
            server,
        })
    }

    pub fn current(&self) -> Arc<AppState> {
        Arc::clone(&self.current.read().expect("live state lock poisoned"))
    }

    pub fn root(&self) -> Option<&Path> {
        self.root.as_deref()
    }

    pub fn slots(&self) -> anyhow::Result<Vec<Slot>> {
        match &self.root {
            Some(root) => store::load(root),
            None => Ok(Vec::new()),
        }
    }

    /// Persist a new slot list and route the next request through it.
    pub fn replace_slots(&self, slots: &[Slot]) -> anyhow::Result<()> {
        let root = self
            .root
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("this router has no editable config"))?;
        store::save(root, slots)?;
        self.reload()
    }

    /// Re-read the slot file. In-flight requests keep the old registry.
    pub fn reload(&self) -> anyhow::Result<()> {
        let slots = self.slots()?;
        let next = AppState::new(crate::slots::to_config(self.server.clone(), &slots));
        *self.current.write().expect("live state lock poisoned") = Arc::new(next);
        Ok(())
    }
}

/// Blank keys mean "leave this one alone".
///
/// The GUI is only ever shown masked keys, so a save round-trips a slot whose
/// `api_key` is empty. Treating that as a real edit would wipe every key the
/// first time somebody renamed a slot.
pub fn merge_keys(incoming: &mut [Slot], stored: &[Slot]) {
    for slot in incoming.iter_mut() {
        if !slot.api_key.is_empty() {
            continue;
        }
        if let Some(prev) = stored.iter().find(|s| s.name == slot.name) {
            slot.api_key = prev.api_key.clone();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slot(name: &str, key: &str) -> Slot {
        Slot {
            name: name.into(),
            base_url: format!("https://{name}.example/v1"),
            api_key: key.into(),
            model: "m".into(),
            enabled: true,
        }
    }

    #[test]
    fn a_blank_key_keeps_the_stored_one() {
        let stored = vec![slot("a", "sk-a"), slot("b", "sk-b")];
        let mut incoming = vec![slot("a", ""), slot("b", "sk-new")];
        merge_keys(&mut incoming, &stored);
        assert_eq!(incoming[0].api_key, "sk-a", "untouched slot keeps its key");
        assert_eq!(incoming[1].api_key, "sk-new", "an entered key wins");
    }

    #[test]
    fn a_blank_key_on_a_new_slot_stays_blank() {
        let mut incoming = vec![slot("fresh", "")];
        merge_keys(&mut incoming, &[slot("a", "sk-a")]);
        assert!(incoming[0].api_key.is_empty(), "never inherit another slot's key");
    }

    #[test]
    fn reload_changes_what_the_next_request_sees() {
        let dir = tempfile::tempdir().unwrap();
        store::save(dir.path(), &[slot("a", "sk-a")]).unwrap();
        let live = Live::from_store(dir.path(), store::default_server()).unwrap();
        assert_eq!(live.current().registry.alias_names(), ["a", "auto"]);

        // A request already in flight holds its own snapshot.
        let in_flight = live.current();
        live.replace_slots(&[slot("b", "sk-b")]).unwrap();

        assert_eq!(live.current().registry.alias_names(), ["auto", "b"]);
        assert_eq!(in_flight.registry.alias_names(), ["a", "auto"], "snapshot is stable");
    }

    #[test]
    fn a_detached_router_refuses_edits_instead_of_writing_somewhere() {
        let cfg = crate::slots::to_config(store::default_server(), &[slot("a", "sk-a")]);
        let live = Live::detached(AppState::new(cfg));
        assert!(live.root().is_none());
        assert!(live.replace_slots(&[slot("b", "sk-b")]).is_err());
    }
}
