//! amber daemon internals (Slice 0): pty session ownership, and later the
//! socket server + attach client. Kept as a lib so the pieces are testable.

pub mod attach;
pub mod daemon;
pub mod manager;
pub mod pty;
