use std::collections::HashSet;

use amber_core::proto::SearchResult;

const DEFAULT_LIMIT: usize = 100;
const MAX_LIMIT: usize = 200;
const MAX_QUERY_CHARS: usize = 256;
const MAX_PREVIEW_CHARS: usize = 240;

#[derive(Clone, Copy)]
enum StripState {
    Text,
    Escape,
    Csi,
    ControlString { escape: bool },
}

/// Remove terminal control sequences without interpreting cursor movement or
/// constructing a screen. The result is only a searchable text approximation
/// of the retained raw-byte ring, never a second terminal emulator.
pub fn sanitize_scrollback(bytes: &[u8]) -> String {
    let mut out = Vec::with_capacity(bytes.len());
    let mut state = StripState::Text;
    for &byte in bytes {
        state = match state {
            StripState::Text => match byte {
                0x1b => StripState::Escape,
                b'\n' => {
                    out.push(byte);
                    StripState::Text
                }
                b'\t' => {
                    out.push(b' ');
                    StripState::Text
                }
                0x20..=0x7e | 0x80..=0xff => {
                    out.push(byte);
                    StripState::Text
                }
                _ => StripState::Text,
            },
            StripState::Escape => match byte {
                b'[' => StripState::Csi,
                b']' | b'P' | b'_' | b'^' | b'X' => {
                    StripState::ControlString { escape: false }
                }
                _ => StripState::Text,
            },
            StripState::Csi => {
                if (0x40..=0x7e).contains(&byte) {
                    StripState::Text
                } else {
                    StripState::Csi
                }
            }
            StripState::ControlString { escape } => {
                if byte == 0x07 || (escape && byte == b'\\') {
                    StripState::Text
                } else {
                    StripState::ControlString { escape: byte == 0x1b }
                }
            }
        };
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn preview(line: &str) -> String {
    line.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_PREVIEW_CHARS)
        .collect()
}

pub fn validate_query(query: &str) -> anyhow::Result<&str> {
    let query = query.trim();
    let query_chars = query.chars().count();
    if query_chars == 0 {
        anyhow::bail!("search query is empty");
    }
    if query_chars > MAX_QUERY_CHARS {
        anyhow::bail!("search query exceeds {MAX_QUERY_CHARS} characters");
    }
    Ok(query)
}

/// Cancellable search over point-in-time ring snapshots. `None` means a newer
/// request on the same connection superseded this work; stale workers then send
/// no reply and release their bounded copies promptly.
pub fn search_snapshots_cancellable(
    query: &str,
    sessions: &[(String, Vec<u8>)],
    names: &[String],
    limit: u16,
    cancelled: &dyn Fn() -> bool,
) -> anyhow::Result<Option<Vec<SearchResult>>> {
    let query = validate_query(query)?;
    let needle = query.to_lowercase();
    let wanted: HashSet<&str> = names.iter().map(String::as_str).collect();
    let limit = if limit == 0 {
        DEFAULT_LIMIT
    } else {
        usize::from(limit).min(MAX_LIMIT)
    };
    let mut ordered: Vec<_> = sessions.iter().collect();
    ordered.sort_by(|a, b| a.0.cmp(&b.0));
    let mut results = Vec::new();
    'sessions: for (name, bytes) in ordered {
        if cancelled() { return Ok(None) }
        if !wanted.is_empty() && !wanted.contains(name.as_str()) {
            continue;
        }
        let text = sanitize_scrollback(bytes);
        for (index, line) in text.lines().enumerate() {
            if cancelled() { return Ok(None) }
            if line.to_lowercase().contains(&needle) {
                results.push(SearchResult {
                    name: name.clone(),
                    line: u32::try_from(index + 1).unwrap_or(u32::MAX),
                    preview: preview(line),
                });
                if results.len() == limit {
                    break 'sessions;
                }
            }
        }
    }
    Ok(Some(results))
}

/// Non-cancellable wrapper used by pure/unit callers.
pub fn search_snapshots(
    query: &str,
    sessions: &[(String, Vec<u8>)],
    names: &[String],
    limit: u16,
) -> anyhow::Result<Vec<SearchResult>> {
    Ok(search_snapshots_cancellable(query, sessions, names, limit, &|| false)?.unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_terminal_controls_without_emulating_a_screen() {
        let bytes = b"plain \x1b[31mred\x1b[0m\n\x1b]2;secret title\x07next\x1bPignored\x1b\\ end\r\n";
        assert_eq!(sanitize_scrollback(bytes), "plain red\nnext end\n");
    }

    #[test]
    fn strips_c0_backspace_and_survives_invalid_utf8() {
        let bytes = b"a\x08b\x00c\xff\n";
        assert_eq!(sanitize_scrollback(bytes), "abc�\n");
    }

    #[test]
    fn search_is_scoped_ordered_case_insensitive_and_globally_limited() {
        let sessions = vec![
            ("z".to_string(), b"Needle z\n".to_vec()),
            ("a".to_string(), b"one\nNEEDLE a\nneedle b\n".to_vec()),
            ("skip".to_string(), b"needle hidden\n".to_vec()),
        ];
        let results = search_snapshots("needle", &sessions, &["z".into(), "a".into()], 2).unwrap();
        assert_eq!(results, vec![
            SearchResult { name: "a".into(), line: 2, preview: "NEEDLE a".into() },
            SearchResult { name: "a".into(), line: 3, preview: "needle b".into() },
        ]);
    }

    #[test]
    fn empty_scope_means_all_and_preview_is_normalized_and_capped() {
        let long = format!("  needle\t{}  ", "x".repeat(400));
        let results = search_snapshots(" needle ", &[("s".into(), long.into_bytes())], &[], 0).unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].preview.starts_with("needle x"));
        assert!(results[0].preview.chars().count() <= 240);
    }

    #[test]
    fn rejects_empty_and_oversized_queries() {
        assert!(search_snapshots("   ", &[], &[], 10).is_err());
        assert!(search_snapshots(&"x".repeat(257), &[], &[], 10).is_err());
    }

    #[test]
    fn cancellable_search_abandons_a_superseded_scan() {
        let checks = std::cell::Cell::new(0);
        let cancelled = || { checks.set(checks.get() + 1); checks.get() >= 3 };
        let result = search_snapshots_cancellable(
            "needle", &[('s'.to_string(), b"one\ntwo\nneedle\n".to_vec())], &[], 10, &cancelled,
        ).unwrap();
        assert_eq!(result, None);
    }
}
