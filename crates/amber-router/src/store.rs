//! On-disk home of the router's slots and its inbound token.
//!
//! Both files live in the amber state root and are 0600. The slot file holds
//! real provider keys, so it is written through the same private-file helpers
//! the web token uses — never a plain `fs::write`, and never anywhere the
//! layout sidecar goes (that one is mirrored across machines over ssh).

use std::path::{Path, PathBuf};

use amber::web;
use router_core::config::{Config, ServerConfig};

use crate::slots::{self, Slot};

pub const CONFIG_FILE: &str = "router.toml";
pub const TOKEN_FILE: &str = "router-token";

pub fn config_path(root: &Path) -> PathBuf {
    root.join(CONFIG_FILE)
}

pub fn token_path(root: &Path) -> PathBuf {
    root.join(TOKEN_FILE)
}

/// Server defaults, without reciting every field.
pub fn default_server() -> ServerConfig {
    toml::from_str("").expect("server defaults must parse")
}

/// Read the stored slots. A missing file is an empty list, not an error — a
/// first run must land on an empty dialog, not a red banner.
pub fn load(root: &Path) -> anyhow::Result<Vec<Slot>> {
    let path = config_path(root);
    let Some(text) = web::read_secret(root, CONFIG_FILE) else {
        return Ok(Vec::new());
    };
    let _ = &path;
    let cfg: Config = toml::from_str(&text)?;
    Ok(slots::from_config(&cfg))
}

/// A stable id for a slot the UI has just invented.
pub fn new_slot_id() -> anyhow::Result<String> {
    let mut raw = [0u8; 9];
    amber::platform::random_bytes(&mut raw)?;
    Ok(amber::web::base64url(&raw))
}

/// Validate, then replace the slot file at 0600 — via a private temp file and
/// a rename, never in place.
///
/// `write_user_private` truncates and rewrites, so a crash mid-write would
/// leave a partial TOML holding every provider key the user configured: the
/// file would no longer parse and the credentials would have to be retyped.
/// This is the one file in the router whose loss actually costs the user
/// something, so it gets the tmp+rename discipline every other amber state
/// file already has.
pub fn save(root: &Path, list: &[Slot]) -> anyhow::Result<()> {
    slots::validate(list).map_err(|e| anyhow::anyhow!(e))?;
    let mut list = list.to_vec();
    for slot in list.iter_mut() {
        if slot.id.is_empty() {
            slot.id = new_slot_id()?;
        }
    }
    let text = toml::to_string_pretty(&slots::to_config(default_server(), &list))?;
    std::fs::create_dir_all(root)?;

    let tmp = format!("{CONFIG_FILE}.{}.tmp", std::process::id());
    web::write_secret(root, &tmp, text.as_bytes())?;
    let tmp_path = root.join(&tmp);
    if let Err(e) = std::fs::rename(&tmp_path, config_path(root)) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(e.into());
    }
    Ok(())
}

/// Give every stored slot a stable id, once.
///
/// A `router.toml` written before ids existed has `id = ""` on every provider,
/// and `merge_keys` matches on id — so without this, the first rename of a
/// legacy slot would silently drop its key. Minting ids at load time WITHOUT
/// persisting them would be worse: they would differ per process, so the
/// dialog and the save would disagree.
pub fn ensure_ids(root: &Path) -> anyhow::Result<Vec<Slot>> {
    let list = load(root)?;
    if list.is_empty() || list.iter().all(|s| !s.id.is_empty()) {
        return Ok(list);
    }
    save(root, &list)?; // `save` mints the missing ones
    load(root)
}

/// The bearer token every caller must present. Minted on first use.
pub fn load_or_create_token(root: &Path, regenerate: bool) -> anyhow::Result<String> {
    web::load_or_create_secret(root, TOKEN_FILE, regenerate)
}

/// Read the token without ever creating one — a status query must not mint a
/// credential as a side effect.
pub fn load_token(root: &Path) -> Option<String> {
    web::read_secret(root, TOKEN_FILE)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slot(name: &str) -> Slot {
        Slot {
            id: format!("id-{name}"),
            name: name.into(),
            base_url: format!("https://{name}.example/v1"),
            api_key: format!("sk-{name}-wxyz"),
            model: "m".into(),
            enabled: true,
        }
    }

    #[test]
    fn missing_file_reads_as_an_empty_list() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load(dir.path()).unwrap().is_empty());
    }

    #[test]
    fn slots_survive_a_save_load_round_trip_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let mut list = vec![slot("a"), slot("b"), slot("c")];
        list[1].enabled = false;
        save(dir.path(), &list).unwrap();
        assert_eq!(load(dir.path()).unwrap(), list);

        slots::move_slot(&mut list, 2, 0);
        save(dir.path(), &list).unwrap();
        let names: Vec<String> =
            load(dir.path()).unwrap().into_iter().map(|s| s.name).collect();
        assert_eq!(names, ["c", "a", "b"]);
    }

    #[test]
    fn saving_assigns_a_stable_id_to_a_new_slot() {
        let dir = tempfile::tempdir().unwrap();
        let mut fresh = slot("a");
        fresh.id = String::new();
        save(dir.path(), &[fresh]).unwrap();
        let first = load(dir.path()).unwrap();
        assert!(!first[0].id.is_empty(), "an id must be minted before writing");

        save(dir.path(), &first).unwrap();
        assert_eq!(load(dir.path()).unwrap()[0].id, first[0].id, "and then never change");
    }

    #[test]
    fn a_legacy_config_without_ids_is_migrated_once() {
        let dir = tempfile::tempdir().unwrap();
        // Exactly what an older amber-router wrote: no `id` key at all.
        let legacy = "[server]\n\n[[provider]]\nname = \"a\"\nbase_url = \"https://a.example/v1\"\n\
                      keys = [\"sk-a\"]\n\n[[alias]]\nname = \"auto\"\n\
                      chain = [ { provider = \"a\", model = \"m\" } ]\n\
                      [[alias]]\nname = \"a\"\nchain = [ { provider = \"a\", model = \"m\" } ]\n";
        web::write_secret(dir.path(), CONFIG_FILE, legacy.as_bytes()).unwrap();
        assert!(load(dir.path()).unwrap()[0].id.is_empty());

        let migrated = ensure_ids(dir.path()).unwrap();
        assert!(!migrated[0].id.is_empty(), "the id must be minted");
        assert_eq!(migrated[0].api_key, "sk-a", "and the key must survive it");
        assert_eq!(ensure_ids(dir.path()).unwrap(), migrated, "and then be stable");
    }

    #[test]
    fn saving_leaves_no_temp_file_behind() {
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), &[slot("a")]).unwrap();
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn an_invalid_list_never_reaches_disk() {
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), &[slot("a")]).unwrap();
        let bad = vec![slot("a"), slot("a")];
        assert!(save(dir.path(), &bad).is_err());
        assert_eq!(load(dir.path()).unwrap(), vec![slot("a")], "the good list stands");
    }

    #[cfg(unix)]
    #[test]
    fn secrets_are_written_user_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), &[slot("a")]).unwrap();
        load_or_create_token(dir.path(), false).unwrap();
        for p in [config_path(dir.path()), token_path(dir.path())] {
            let mode = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "{}", p.display());
        }
    }

    #[test]
    fn a_status_read_never_mints_a_token() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load_token(dir.path()).is_none());
        assert!(!token_path(dir.path()).exists());

        let minted = load_or_create_token(dir.path(), false).unwrap();
        assert_eq!(load_token(dir.path()).as_deref(), Some(minted.as_str()));
        assert_eq!(load_or_create_token(dir.path(), false).unwrap(), minted, "stable");

        let rotated = load_or_create_token(dir.path(), true).unwrap();
        assert_ne!(rotated, minted);
    }
}
