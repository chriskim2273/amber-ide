//! amber-core: pure, testable building blocks for the amber session daemon.
//!
//! Slice 0 scope: scrollback ring, wire protocol framing, state store.
//! No I/O beyond the state store's own filesystem access.

pub mod proto;
pub mod ring;
pub mod state;
