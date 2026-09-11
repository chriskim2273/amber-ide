//! The private-terminal-mode state of a session's live application, tracked
//! from its output bytes.
//!
//! # Why the daemon has to remember this
//!
//! Every amber client renders a session by writing the daemon's capped raw byte
//! ring into a terminal emulator. A COLD terminal (fresh pane, a pane the user
//! refreshed, a reconnected client, the phone) must therefore rebuild the live
//! application's MODE state out of whatever bytes the ring still holds — and it
//! usually cannot. The ring is capped at [`crate::state`]'s 2 MiB of *frames*,
//! while a full-screen TUI writes its private-mode enables exactly ONCE, at
//! startup. Measured on a live Pi pane (2026-09-11): the retained 2 MiB window
//! held **zero** occurrences of `ESC [ ? 1049 h` (the alt-screen enter) while
//! holding hundreds of cursor-addressed frames. A cold replay of that window
//! paints a full-screen TUI's frames into the NORMAL buffer — junk stacked in
//! the scrollback, wrong buffer, hidden cursor state lost — and, with no mouse
//! protocol, the wheel stops reaching the application: xterm.js converts wheel
//! events into up/down arrows in a buffer without scrollback
//! (`CoreBrowserTerminal`'s wheel listener), which a TUI's editor reads as its
//! prompt history instead of scrolling the conversation.
//!
//! Remembering more bytes cannot fix this (the enable is arbitrarily old), so
//! this type keeps the STATE instead: a bounded, split-safe streaming
//! recognizer for the private modes an application owns. It is fed the same
//! bytes as the ring (see `PtySession`'s batcher), so its footprint is O(1) and
//! its knowledge never evicts.
//!
//! # What a cold replay may assert
//!
//! [`TerminalModes::replay_preamble`] returns the bytes that put a cold
//! terminal into the session's current modes. It is deliberately EMPTY unless
//! the ALT SCREEN is on. Two reasons:
//!
//! - A mode left behind by a crashed TUI must never be re-asserted into a
//!   shell — that is the "every click spams encoded mouse reports" bug
//!   (`attach.rs`'s `TERM_RESTORE` fights the same hazard).
//! - A full-screen application is exactly the case where a terminal cannot
//!   re-derive the modes itself: it owns every cell, has no scrollback, and
//!   answers a wheel with its own transcript.

/// Alt-screen mode 47 (older, does not clear on entry).
const BIT_ALT_47: u32 = 1 << 0;
/// Alt-screen mode 1047 (clears the alternate buffer on exit).
const BIT_ALT_1047: u32 = 1 << 1;
/// Alt-screen mode 1049 (save cursor + clear) — what modern TUIs use.
const BIT_ALT_1049: u32 = 1 << 2;
/// X10/VT200 mouse reporting — the WHEEL event type lives here.
const BIT_MOUSE_1000: u32 = 1 << 3;
/// Cell-motion (drag) mouse reporting.
const BIT_MOUSE_1002: u32 = 1 << 4;
/// All-motion mouse reporting (what Pi negotiates outside tmux).
const BIT_MOUSE_1003: u32 = 1 << 5;
/// Focus in/out reporting.
const BIT_FOCUS_1004: u32 = 1 << 6;
/// SGR mouse encoding (`CSI < b ; x ; y M`) — without it, coordinates break
/// past column 223.
const BIT_MOUSE_1006: u32 = 1 << 7;
/// urxvt mouse encoding.
const BIT_MOUSE_1015: u32 = 1 << 8;
/// SGR-pixels mouse encoding.
const BIT_MOUSE_1016: u32 = 1 << 9;
/// Bracketed paste. Pi/claude enable it once at startup; a cold renderer that
/// never saw the enable sends a paste as if it were typed (see the Pi paste
/// path in the app's `terminalClipboard`).
const BIT_BRACKETED_PASTE: u32 = 1 << 10;
/// Cursor hidden (`ESC [ ? 25 l`). INVERTED on purpose — see [`TerminalModes::apply`].
const BIT_CURSOR_HIDDEN: u32 = 1 << 11;

/// Every mode this tracker owns, in ascending mode order — the same order
/// [`TerminalModes::replay_preamble`] asserts them in, so the two can be
/// diffed by eye. 25's bit is the inverted "hidden" one.
const TRACKED: [(u16, u32); 12] = [
    (25, BIT_CURSOR_HIDDEN),
    (47, BIT_ALT_47),
    (1000, BIT_MOUSE_1000),
    (1002, BIT_MOUSE_1002),
    (1003, BIT_MOUSE_1003),
    (1004, BIT_FOCUS_1004),
    (1006, BIT_MOUSE_1006),
    (1015, BIT_MOUSE_1015),
    (1016, BIT_MOUSE_1016),
    (1047, BIT_ALT_1047),
    (1049, BIT_ALT_1049),
    (2004, BIT_BRACKETED_PASTE),
];

fn bit_for(mode: u16) -> Option<u32> {
    TRACKED.iter().find(|(m, _)| *m == mode).map(|(_, bit)| *bit)
}

fn is_alt_bit(bit: u32) -> bool {
    bit == BIT_ALT_47 || bit == BIT_ALT_1047 || bit == BIT_ALT_1049
}

/// [`TerminalModes::replay_preamble`]'s two emission passes: alt screen first
/// (buffer choice), then everything that reports input back to the app.
#[derive(Clone, Copy, PartialEq, Eq)]
enum PreamblePass {
    AltScreen,
    Reporting,
}

/// Longest parameter run accepted inside `ESC [ ? … h|l`. The widest real
/// sequence is Pi's `?1000;1002;1003;1004;1006h` (24 bytes); anything longer
/// cannot be a mode set we own, and dropping the candidate keeps the
/// recognizer's memory bounded on arbitrary binary output.
const MAX_PARAMS: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
enum ModeParse {
    Normal,
    Esc,          // saw ESC
    Csi,          // saw ESC [
    Priv(String), // saw ESC [ ? … , collecting parameter bytes
}

/// Streaming state of the private modes a session's application has asserted.
///
/// Not a terminal emulator: it recognizes exactly `ESC [ ? <params> h|l` and
/// ignores everything else. The candidate survives [`feed`](Self::feed) calls,
/// because a mode sequence can be split across daemon `Data` frames.
#[derive(Debug, Clone)]
pub struct TerminalModes {
    enabled: u32,
    state: ModeParse,
}

impl Default for TerminalModes {
    fn default() -> Self {
        Self::new()
    }
}

impl TerminalModes {
    pub fn new() -> Self {
        TerminalModes { enabled: 0, state: ModeParse::Normal }
    }

    /// Feed output bytes; afterwards the getters describe the state at the end
    /// of the stream. Allocation-free for ordinary output (one `ESC`-prefixed
    /// candidate at a time, capped).
    pub fn feed(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.state = match std::mem::replace(&mut self.state, ModeParse::Normal) {
                ModeParse::Normal if b == 0x1b => ModeParse::Esc,
                ModeParse::Normal => ModeParse::Normal,
                ModeParse::Esc if b == b'[' => ModeParse::Csi,
                // A second ESC restarts the candidate rather than dropping it
                // (the first was a stray ESC, e.g. from a truncated write).
                ModeParse::Esc if b == 0x1b => ModeParse::Esc,
                ModeParse::Esc => ModeParse::Normal,
                ModeParse::Csi if b == b'?' => ModeParse::Priv(String::new()),
                ModeParse::Csi if b == 0x1b => ModeParse::Esc,
                ModeParse::Csi => ModeParse::Normal,
                ModeParse::Priv(mut params) => {
                    if b == b'h' || b == b'l' {
                        self.apply_params(&params, b == b'h');
                        ModeParse::Normal
                    } else if b.is_ascii_digit() || b == b';' {
                        if params.len() < MAX_PARAMS {
                            params.push(b as char);
                            ModeParse::Priv(params)
                        } else {
                            ModeParse::Normal
                        }
                    } else if b == 0x1b {
                        ModeParse::Esc
                    } else {
                        ModeParse::Normal
                    }
                }
            };
        }
    }

    /// Apply one recognized `DECSET`/`DECRST`: `set` is true for `h`.
    fn apply_params(&mut self, params: &str, set: bool) {
        for param in params.split(';') {
            let Ok(mode) = param.parse::<u16>() else { continue };
            self.apply(mode, set);
        }
    }

    fn apply(&mut self, mode: u16, set: bool) {
        if mode == 25 {
            // Cursor visibility is INVERTED here: `?25l` is the state worth
            // restoring (hidden), while `?25h` merely means the emulator's
            // default, which a replay must not have to assert. Likewise a
            // stream that never mentions 25 (the overwhelming majority) leaves
            // the bit clear and the preamble silent.
            self.set_bit(BIT_CURSOR_HIDDEN, !set);
            return;
        }
        if let Some(bit) = bit_for(mode) {
            self.set_bit(bit, set);
        }
    }

    fn set_bit(&mut self, bit: u32, on: bool) {
        if on {
            self.enabled |= bit;
        } else {
            self.enabled &= !bit;
        }
    }

    /// Is the application on the alternate screen right now?
    pub fn alt_screen(&self) -> bool {
        self.enabled & (BIT_ALT_47 | BIT_ALT_1047 | BIT_ALT_1049) != 0
    }

    /// Is any mouse protocol (and therefore the wheel) routed to the
    /// application?
    pub fn mouse_tracking(&self) -> bool {
        self.enabled
            & (BIT_MOUSE_1000
                | BIT_MOUSE_1002
                | BIT_MOUSE_1003
                | BIT_MOUSE_1006
                | BIT_MOUSE_1015
                | BIT_MOUSE_1016)
            != 0
    }

    /// Has the application enabled bracketed paste?
    pub fn bracketed_paste(&self) -> bool {
        self.enabled & BIT_BRACKETED_PASTE != 0
    }

    /// Has the application hidden the cursor?
    pub fn cursor_hidden(&self) -> bool {
        self.enabled & BIT_CURSOR_HIDDEN != 0
    }

    /// Bytes to write to a COLD terminal, before a full replay of the ring, to
    /// put it into this session's current modes. Empty when no full-screen
    /// application owns the screen — see the module docs for why that is the
    /// gate.
    ///
    /// Order, and why:
    ///
    /// 1. the alt-screen modes first, so the replayed window is parsed into the
    ///    alternate buffer instead of stacking a full-screen TUI's frames into
    ///    the normal buffer's scrollback (the whole point of the preamble);
    /// 2. then the reporting/paste modes ascending — xterm's `activeProtocol`
    ///    is last-writer-wins, so `?1000h ?1002h ?1003h` (which Pi sets at
    ///    once) must be asserted in that order to land on ANY-motion;
    /// 3. the hidden cursor last, since entering the alt buffer re-initializes
    ///    cursor bookkeeping.
    ///
    /// Emitted as one `ESC [ ? … h` per mode rather than a combined list: the
    /// set is tiny, the bytes are self-describing in a capture, and modes that
    /// a later byte of the window re-toggles are then visually attributable.
    pub fn replay_preamble(&self) -> Vec<u8> {
        if !self.alt_screen() {
            return Vec::new();
        }
        let mut out = Vec::new();
        for pass in [PreamblePass::AltScreen, PreamblePass::Reporting] {
            for (mode, bit) in TRACKED {
                if mode == 25 || (pass == PreamblePass::AltScreen) != is_alt_bit(bit) {
                    continue;
                }
                if self.enabled & bit != 0 {
                    out.extend_from_slice(format!("\x1b[?{mode}h").as_bytes());
                }
            }
        }
        if self.cursor_hidden() {
            out.extend_from_slice(b"\x1b[?25l");
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::TerminalModes;

    /// Pi's real startup sequence (from `beforeTerminalStart`), plus the clear
    /// and cursor hide it follows with.
    const PI_START: &[u8] =
        b"\x1b[?1049h\x1b[?7l\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h\x1b[2J\x1b[H\x1b[?25l";

    #[test]
    fn fresh_tracker_has_no_modes_and_no_preamble() {
        let m = TerminalModes::new();
        assert!(!m.alt_screen());
        assert!(!m.mouse_tracking());
        assert!(!m.bracketed_paste());
        assert!(!m.cursor_hidden());
        assert_eq!(m.replay_preamble(), Vec::<u8>::new());
    }

    #[test]
    fn pi_startup_is_recognized_whole() {
        let mut m = TerminalModes::new();
        m.feed(PI_START);
        assert!(m.alt_screen());
        assert!(m.mouse_tracking());
        assert!(m.cursor_hidden());
        assert_eq!(m.replay_preamble(), b"\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h\x1b[?25l");
    }

    #[test]
    fn sequences_split_across_frames_are_still_recognized() {
        // The daemon's batcher frames bytes at will: a mode sequence can land
        // in two `Data` frames (and, in the ring, straddle a wrap). Feeding one
        // byte at a time is the strongest form of that test.
        let mut m = TerminalModes::new();
        for byte in PI_START {
            m.feed(&[*byte]);
        }
        assert!(m.alt_screen());
        assert!(m.mouse_tracking());
        assert!(m.cursor_hidden());
    }

    #[test]
    fn leaving_the_alt_screen_empties_the_preamble() {
        // The gate: a shell (or a TUI that exited) must never have mouse
        // reporting re-asserted by a replay.
        let mut m = TerminalModes::new();
        m.feed(PI_START);
        m.feed(b"\x1b[?25h\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1049l");
        assert!(!m.alt_screen());
        assert!(!m.mouse_tracking());
        assert!(!m.cursor_hidden());
        assert_eq!(m.replay_preamble(), Vec::<u8>::new());
    }

    #[test]
    fn a_stale_mouse_mode_outside_the_alt_screen_is_not_asserted() {
        // The hazard MOUSE_RESET exists for: a TUI dies without disabling its
        // modes. The tracker knows the mode, but with no alt screen the
        // preamble stays empty so the shell never sees mouse reports.
        let mut m = TerminalModes::new();
        m.feed(b"\x1b[?1000h\x1b[?1006h");
        assert!(m.mouse_tracking());
        assert_eq!(m.replay_preamble(), Vec::<u8>::new());
    }

    #[test]
    fn individual_modes_toggle_without_disturbing_the_rest() {
        let mut m = TerminalModes::new();
        m.feed(PI_START);
        m.feed(b"\x1b[?1003l");
        assert!(m.alt_screen());
        assert!(m.mouse_tracking(), "1000/1002 still report");
        assert_eq!(
            m.replay_preamble(),
            b"\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1004h\x1b[?1006h\x1b[?25l"
        );
        m.feed(b"\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?1004l");
        assert!(!m.mouse_tracking());
        assert_eq!(m.replay_preamble(), b"\x1b[?1049h\x1b[?25l");
    }

    #[test]
    fn combined_parameters_are_applied() {
        // `CSI ? 1 ; 1049 h` (screen's idiom) and a multi-mode set.
        let mut m = TerminalModes::new();
        m.feed(b"\x1b[?1;1049h");
        assert!(m.alt_screen());
        m.feed(b"\x1b[?1000;1006h");
        assert!(m.mouse_tracking());
        assert_eq!(m.replay_preamble(), b"\x1b[?1049h\x1b[?1000h\x1b[?1006h");
    }

    #[test]
    fn older_alt_screen_modes_count_and_are_re_emitted_as_themselves() {
        let mut m = TerminalModes::new();
        m.feed(b"\x1b[?47h");
        assert!(m.alt_screen());
        assert_eq!(m.replay_preamble(), b"\x1b[?47h");
        m.feed(b"\x1b[?1047h");
        assert_eq!(m.replay_preamble(), b"\x1b[?47h\x1b[?1047h");
        m.feed(b"\x1b[?47l");
        assert!(m.alt_screen(), "1047 is still held");
    }

    #[test]
    fn bracketed_paste_is_restored_without_a_mouse_protocol() {
        // A pager in the alt screen: paste mode belongs to it, mouse does not.
        let mut m = TerminalModes::new();
        m.feed(b"\x1b[?1049h\x1b[?2004h");
        assert!(m.bracketed_paste());
        assert!(!m.mouse_tracking());
        assert_eq!(m.replay_preamble(), b"\x1b[?1049h\x1b[?2004h");
    }

    #[test]
    fn non_mode_sequences_and_binary_output_are_ignored() {
        let mut m = TerminalModes::new();
        // A DA1 reply, an OSC title, SGR colors, a DECSTBM margin, UTF-8 text,
        // and a truncated mode candidate that never completes.
        m.feed(b"\x1b[?1;2c\x1b]0;title\x07\x1b[38;2;1;2;3m\x1b[1;10r\xe2\x94\x80text");
        m.feed(b"\x1b[?10");
        assert!(!m.alt_screen());
        assert!(!m.mouse_tracking());
        assert!(!m.cursor_hidden());
        assert_eq!(m.replay_preamble(), Vec::<u8>::new());
    }

    #[test]
    fn a_runaway_parameter_candidate_is_dropped_without_wedging() {
        let mut m = TerminalModes::new();
        m.feed(b"\x1b[?");
        m.feed(&vec![b'1'; 4096]);
        m.feed(b"h");
        assert!(!m.alt_screen());
        // The recognizer still works after the oversized candidate.
        m.feed(b"\x1b[?1049h");
        assert!(m.alt_screen());
    }

    #[test]
    fn a_stray_escape_before_a_real_sequence_does_not_hide_it() {
        let mut m = TerminalModes::new();
        m.feed(b"\x1b\x1b[?1049h"); // e.g. a truncated write, then the real thing
        assert!(m.alt_screen());
    }

    #[test]
    fn cursor_state_is_independent_of_the_alt_gate() {
        let mut m = TerminalModes::new();
        m.feed(b"\x1b[?1049h\x1b[?25l\x1b[?25h");
        assert!(!m.cursor_hidden());
        assert_eq!(m.replay_preamble(), b"\x1b[?1049h");
        m.feed(b"\x1b[?25l");
        assert_eq!(m.replay_preamble(), b"\x1b[?1049h\x1b[?25l");
    }
}
