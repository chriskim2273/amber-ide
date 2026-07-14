//! Registry of client connections that opted in (via `WatchSessions`) to
//! pushed `SessionsChanged` events. Holds weak references to each watcher's
//! shared write half, so a vanished connection is pruned automatically.

use std::io::Write;
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex, Weak};

use amber_core::proto::{self, ControlMsg, Frame};

#[derive(Default)]
pub struct Watchers {
    writers: Mutex<Vec<Weak<Mutex<UnixStream>>>>,
}

impl Watchers {
    pub fn new() -> Self {
        Watchers::default()
    }

    /// Register a connection's shared write half as a watcher.
    pub fn register(&self, writer: &Arc<Mutex<UnixStream>>) {
        self.writers.lock().unwrap().push(Arc::downgrade(writer));
    }

    /// Encode `msg` once and write it to every live watcher. Snapshots the
    /// live set under the registry lock, then writes with the lock released
    /// (rule: registry lock before writer lock, never nested the other way).
    pub fn broadcast(&self, msg: &ControlMsg) {
        let frame = proto::encode(&Frame::Control(msg.clone()));
        let live: Vec<Arc<Mutex<UnixStream>>> = {
            let mut ws = self.writers.lock().unwrap();
            ws.retain(|w| w.strong_count() > 0);
            ws.iter().filter_map(Weak::upgrade).collect()
        };
        for w in live {
            let mut s = w.lock().unwrap();
            let _ = s.write_all(&frame).and_then(|_| s.flush());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use amber_core::proto::Decoder;
    use std::io::Read;
    use std::time::Duration;

    fn read_one(stream: &mut UnixStream) -> Option<Frame> {
        stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let mut dec = Decoder::new();
        let mut buf = [0u8; 4096];
        loop {
            if let Some(f) = dec.next_frame().unwrap() {
                return Some(f);
            }
            match stream.read(&mut buf) {
                Ok(0) => return None,
                Ok(n) => dec.feed(&buf[..n]),
                Err(_) => return None,
            }
        }
    }

    #[test]
    fn broadcast_reaches_live_watchers_and_prunes_dropped_ones() {
        let watchers = Watchers::new();
        let (mut client_a, server_a) = UnixStream::pair().unwrap();
        let (mut client_b, server_b) = UnixStream::pair().unwrap();
        let wa = Arc::new(Mutex::new(server_a));
        let wb = Arc::new(Mutex::new(server_b));
        watchers.register(&wa);
        watchers.register(&wb);

        let msg = ControlMsg::SessionsChanged { added: vec![], removed: vec!["x".into()] };
        watchers.broadcast(&msg);
        assert_eq!(read_one(&mut client_a), Some(Frame::Control(msg.clone())));
        assert_eq!(read_one(&mut client_b), Some(Frame::Control(msg.clone())));

        // Drop watcher B's server writer: the Weak can no longer upgrade, so
        // the next broadcast prunes it and only A receives.
        drop(wb);
        let msg2 = ControlMsg::SessionsChanged { added: vec![], removed: vec!["y".into()] };
        watchers.broadcast(&msg2);
        assert_eq!(read_one(&mut client_a), Some(Frame::Control(msg2)));
        assert_eq!(watchers.writers.lock().unwrap().len(), 1, "dropped watcher pruned");
    }
}
