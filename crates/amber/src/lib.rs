//! amber daemon internals (Slice 0): pty session ownership, and later the
//! socket server + attach client. Kept as a lib so the pieces are testable.

pub mod attach;
pub mod claude;
pub mod daemon;
pub mod grok;
pub mod layout_cas;
pub mod manager;
pub mod mosaic;
pub mod procinfo;
pub mod pty;
pub mod supervisor;
pub mod web;
pub mod watchers;
