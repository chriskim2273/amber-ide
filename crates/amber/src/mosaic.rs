//! Reads the desktop app's `ui-layout.json` sidecar and turns it into
//! render-ready mosaic JSON for `amber web`. Read-only: this module never
//! writes the sidecar (the Electron app is its sole writer).

use std::collections::HashMap;
use std::path::Path;

use serde::Deserialize;

/// Sidecar file name inside the state root, written by the Electron app.
pub const LAYOUT_FILE: &str = "ui-layout.json";

/// A node of the app's binary split tree. Mirrors `app/src/renderer/layout.ts`.
///
/// The sidecar writes an INTERNALLY tagged enum — `{"kind":"leaf","paneId":…}`,
/// tag alongside payload — so `tag = "kind"`, `rename_all = "lowercase"`
/// (serde would otherwise look for `"Leaf"`/`"Split"`) and the explicit
/// `paneId` rename are all load-bearing.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Node {
    Leaf {
        #[serde(rename = "paneId")]
        pane_id: String,
    },
    Split {
        dir: String,
        ratio: f32,
        a: Box<Node>,
        b: Box<Node>,
    },
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct FrozenEntry {
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct TabLayout {
    #[serde(default)]
    pub tree: Option<Node>,
    #[serde(default)]
    pub label: Option<String>,
}

fn default_active_tab() -> u32 {
    1
}

fn default_active_workspace() -> u32 {
    1
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct WsLayout {
    #[serde(default = "default_active_tab", rename = "activeTab")]
    pub active_tab: u32,
    #[serde(default)]
    pub tabs: HashMap<String, TabLayout>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default, rename = "tabOrder")]
    pub tab_order: Option<Vec<u32>>,
}

/// The subset of the sidecar the mosaic needs.
///
/// `browsers`, `editors`, `fontSize` and `recentFiles` are deliberately NOT
/// deserialized — the mosaic renders no app-local panes, and `recentFiles` is a
/// list of arbitrary host paths with no business crossing the web boundary.
///
/// `version` must be 1 (the current LAYOUT_VERSION). If present and not 1, the
/// sidecar is treated as incompatible and returns an empty layout (same as the
/// TS parser). If version is missing, it's treated as 0 (pre-versioning), which
/// also returns empty — matching `layoutFile.ts:165` behavior.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct LayoutFile {
    #[serde(default)]
    pub version: u32,
    #[serde(default = "default_active_workspace", rename = "activeWorkspace")]
    pub active_workspace: u32,
    #[serde(default)]
    pub workspaces: HashMap<String, WsLayout>,
    #[serde(default)]
    pub frozen: HashMap<String, FrozenEntry>,
}

/// Read `<root>/ui-layout.json`. A missing, unreadable or malformed sidecar is
/// NOT an error: it degrades to empty, which renders as the equal-splits
/// fallback the desktop app itself uses. Core rule #3 — grouping must be
/// reconstructable from session names alone.
///
/// Version validation: if the sidecar's version is present and not 1, it is
/// treated as incompatible and returns empty (matching `layoutFile.ts:165`).
/// If version is missing, it defaults to 0, which is also treated as invalid.
pub fn load(root: &Path) -> LayoutFile {
    match std::fs::read_to_string(root.join(LAYOUT_FILE))
        .ok()
        .and_then(|s| serde_json::from_str::<LayoutFile>(&s).ok())
    {
        Some(layout) if layout.version == 1 => layout,
        _ => LayoutFile::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A sidecar with the exact shape `app/src/shared/layoutFile.ts` writes:
    /// an internally-tagged split tree, string-keyed ws/tab maps, and the
    /// app-local `browsers`/`editors`/`recentFiles` keys this module ignores.
    const SIDECAR: &str = r#"{
      "version": 1,
      "activeWorkspace": 1,
      "fontSize": 14,
      "workspaces": {
        "1": {
          "activeTab": 2,
          "label": "main",
          "tabOrder": [2, 1],
          "tabs": {
            "1": { "tree": { "kind": "leaf", "paneId": "amber-1-1-0-aa" } },
            "2": {
              "label": "api",
              "tree": {
                "kind": "split", "dir": "h", "ratio": 0.6,
                "a": { "kind": "leaf", "paneId": "amber-1-2-0-bb" },
                "b": {
                  "kind": "split", "dir": "v", "ratio": 0.5,
                  "a": { "kind": "leaf", "paneId": "amber-1-2-1-cc" },
                  "b": { "kind": "leaf", "paneId": "editor-1-2-2-dd" }
                }
              }
            }
          }
        }
      },
      "frozen": { "amber-1-1-0-aa": { "note": "parked" } },
      "editors": { "editor-1-2-2-dd": { "ws": 1, "tab": 2, "ord": 2, "path": null } },
      "recentFiles": ["/home/me/secret.txt"]
    }"#;

    #[test]
    fn parses_the_real_sidecar_shape_including_nested_boxed_splits() {
        let f: LayoutFile = serde_json::from_str(SIDECAR).unwrap();
        assert_eq!(f.active_workspace, 1);
        let ws = f.workspaces.get("1").expect("ws 1");
        assert_eq!(ws.active_tab, 2);
        assert_eq!(ws.label.as_deref(), Some("main"));
        assert_eq!(ws.tab_order.as_deref(), Some(&[2u32, 1][..]));

        // Tab 1: a bare leaf.
        let t1 = ws.tabs.get("1").expect("tab 1");
        match t1.tree.as_ref().expect("tree") {
            Node::Leaf { pane_id } => assert_eq!(pane_id, "amber-1-1-0-aa"),
            other => panic!("expected leaf, got {other:?}"),
        }

        // Tab 2: nested `Box<Node>` recursion through an internally-tagged
        // enum — the part worth proving rather than assuming.
        let t2 = ws.tabs.get("2").expect("tab 2");
        assert_eq!(t2.label.as_deref(), Some("api"));
        match t2.tree.as_ref().expect("tree") {
            Node::Split { dir, ratio, a, b } => {
                assert_eq!(dir, "h");
                assert!((ratio - 0.6).abs() < 1e-6, "ratio {ratio}");
                assert!(matches!(**a, Node::Leaf { .. }));
                assert!(matches!(**b, Node::Split { .. }));
            }
            other => panic!("expected split, got {other:?}"),
        }

        assert!(f.frozen.contains_key("amber-1-1-0-aa"));
    }

    #[test]
    fn a_missing_or_malformed_sidecar_degrades_to_empty_rather_than_erroring() {
        let dir = tempfile::tempdir().unwrap();
        // Missing entirely.
        assert!(load(dir.path()).workspaces.is_empty());
        // Present but not JSON.
        std::fs::write(dir.path().join("ui-layout.json"), b"{ this is not json").unwrap();
        assert!(load(dir.path()).workspaces.is_empty());
        // Present, valid JSON, wrong shape.
        std::fs::write(dir.path().join("ui-layout.json"), b"[1,2,3]").unwrap();
        assert!(load(dir.path()).workspaces.is_empty());
    }

    #[test]
    fn load_reads_the_sidecar_from_the_state_root() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("ui-layout.json"), SIDECAR).unwrap();
        let f = load(dir.path());
        assert_eq!(f.workspaces.len(), 1);
        assert_eq!(f.active_workspace, 1);
    }

    #[test]
    fn parses_this_machines_real_sidecar_if_present() {
        let Some(home) = std::env::var_os("HOME") else {
            eprintln!("skipped: no sidecar at $HOME/.local/state/amber-ide/ui-layout.json (HOME not set)");
            return;
        };
        let p = std::path::Path::new(&home).join(".local/state/amber-ide/ui-layout.json");
        let Ok(raw) = std::fs::read_to_string(&p) else {
            eprintln!("skipped: no sidecar at {}", p.display());
            return;
        };
        let f: LayoutFile = serde_json::from_str(&raw)
            .unwrap_or_else(|e| panic!("real sidecar {} failed to parse: {e}", p.display()));
        eprintln!("parsed real sidecar at {}: {} workspaces", p.display(), f.workspaces.len());
        assert!(!f.workspaces.is_empty(), "real sidecar has no workspaces");
    }

    #[test]
    fn defaults_active_tab_and_workspace_to_1_when_missing() {
        let sidecar_no_defaults = r#"{"version": 1, "workspaces": {"1": {"tabs": {}}}}"#;
        let f: LayoutFile = serde_json::from_str(sidecar_no_defaults).unwrap();
        assert_eq!(f.active_workspace, 1, "activeWorkspace defaults to 1");
        let ws = f.workspaces.get("1").expect("ws 1");
        assert_eq!(ws.active_tab, 1, "activeTab defaults to 1");
    }
}
