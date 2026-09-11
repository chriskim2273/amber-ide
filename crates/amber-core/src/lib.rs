//! amber-core: pure, testable building blocks for the amber session daemon.
//!
//! Slice 0 scope: scrollback ring, wire protocol framing, state store.
//! No I/O beyond the state store's own filesystem access.
//!
//! Also home to the pure recognizers a client cannot re-derive on its own —
//! [`modes`] remembers the private terminal modes a session's application has
//! asserted, so a cold attach can be put back into them.

pub mod git;
pub mod modes;
pub mod proto;
pub mod ring;
pub mod state;
