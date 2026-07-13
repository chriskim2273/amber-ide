//! Capped raw-byte scrollback ring: append bytes, keep only the newest `cap`.

/// A byte buffer that retains at most `cap` bytes, discarding the oldest on
/// overflow. Used as the per-session scrollback held in memory and flushed to
/// `scrollback/<name>.bin`.
#[derive(Debug, Clone)]
pub struct Ring {
    cap: usize,
    buf: Vec<u8>,
}

impl Ring {
    /// New empty ring holding at most `cap` bytes.
    pub fn new(cap: usize) -> Self {
        Ring {
            cap,
            buf: Vec::new(),
        }
    }

    /// Reload a ring from persisted bytes, keeping only the newest `cap`.
    pub fn from_bytes(cap: usize, bytes: &[u8]) -> Self {
        let mut r = Ring::new(cap);
        r.push(bytes);
        r
    }

    /// Append `data`, discarding oldest bytes beyond `cap`.
    pub fn push(&mut self, data: &[u8]) {
        if self.cap == 0 {
            return;
        }
        if data.len() >= self.cap {
            // The new data alone overflows: keep only its tail.
            self.buf.clear();
            self.buf.extend_from_slice(&data[data.len() - self.cap..]);
            return;
        }
        self.buf.extend_from_slice(data);
        if self.buf.len() > self.cap {
            let overflow = self.buf.len() - self.cap;
            self.buf.drain(..overflow);
        }
    }

    /// Current contents, oldest byte first.
    pub fn snapshot(&self) -> Vec<u8> {
        self.buf.clone()
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::Ring;

    #[test]
    fn new_ring_is_empty() {
        let r = Ring::new(16);
        assert!(r.is_empty());
        assert_eq!(r.len(), 0);
        assert_eq!(r.snapshot(), Vec::<u8>::new());
    }

    #[test]
    fn push_under_cap_returns_exactly_what_was_pushed() {
        let mut r = Ring::new(16);
        r.push(b"hello");
        assert_eq!(r.snapshot(), b"hello");
        assert_eq!(r.len(), 5);
        assert!(!r.is_empty());
    }

    #[test]
    fn accumulates_across_pushes_under_cap() {
        let mut r = Ring::new(16);
        r.push(b"foo");
        r.push(b"bar");
        assert_eq!(r.snapshot(), b"foobar");
    }

    #[test]
    fn over_cap_keeps_only_newest_bytes() {
        let mut r = Ring::new(4);
        r.push(b"abcdef"); // 6 bytes into cap 4
        assert_eq!(r.snapshot(), b"cdef");
        assert_eq!(r.len(), 4);
    }

    #[test]
    fn overflow_spans_multiple_pushes() {
        let mut r = Ring::new(4);
        r.push(b"ab");
        r.push(b"cd");
        r.push(b"ef"); // newest 4 across pushes = "cdef"
        assert_eq!(r.snapshot(), b"cdef");
    }

    #[test]
    fn single_chunk_larger_than_cap_keeps_tail() {
        let mut r = Ring::new(3);
        r.push(b"abcdefgh");
        assert_eq!(r.snapshot(), b"fgh");
    }

    #[test]
    fn from_bytes_truncates_to_newest_cap() {
        let r = Ring::from_bytes(3, b"abcdef");
        assert_eq!(r.snapshot(), b"def");
        assert_eq!(r.len(), 3);
    }

    #[test]
    fn from_bytes_under_cap_keeps_all() {
        let r = Ring::from_bytes(8, b"abc");
        assert_eq!(r.snapshot(), b"abc");
    }

    #[test]
    fn zero_cap_never_stores() {
        let mut r = Ring::new(0);
        r.push(b"anything");
        assert!(r.is_empty());
        assert_eq!(r.snapshot(), Vec::<u8>::new());
    }
}
