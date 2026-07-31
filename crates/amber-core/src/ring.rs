//! Capped raw-byte scrollback ring: append bytes, keep only the newest `cap`.
//!
//! # Why this is a true circular buffer
//!
//! The original form was a `Vec<u8>` with `drain(..overflow)`. That cost twice,
//! and both costs were measured on the live daemon (2026-07-31 memory audit):
//!
//! - **2× retained memory.** `extend_from_slice` pushed `len` past `cap` before
//!   the drain, tripping `Vec`'s amortized doubling; `drain` never shrinks. A
//!   2 MiB cap fed 256 KiB batches settled at exactly 4 MiB of capacity and
//!   stayed there — 36 MB of pure over-allocation across the box's 18 full rings,
//!   in a daemon whose whole RSS was 106 MB.
//! - **A full-buffer memmove per output frame.** Once at cap, every push shifted
//!   the entire remaining ~2 MiB down. At the 16 ms batch cadence that is on the
//!   order of 125 MB/s of `memmove` *per busy pane*, for nothing.
//!
//! So: grow geometrically up to `cap` (an idle pane must not cost a cap-sized
//! allocation), then wrap in place. Capacity is hard-clamped to `cap`; a push at
//! cap copies only the pushed bytes.

/// A byte buffer that retains at most `cap` bytes, discarding the oldest on
/// overflow. Used as the per-session scrollback held in memory and flushed to
/// `scrollback/<name>.bin`.
///
/// Invariants: `buf.len() <= cap`, `buf.capacity() <= cap`, and `head < cap`
/// (or `head == 0` while `buf.len() < cap`, i.e. before the first wrap).
#[derive(Debug, Clone)]
pub struct Ring {
    cap: usize,
    buf: Vec<u8>,
    /// Index of the OLDEST byte once the buffer is full — i.e. where the next
    /// write lands. Always 0 while still filling.
    head: usize,
    /// Total bytes ever pushed. Monotonic; the snapshot timer compares it to
    /// skip rewriting a scrollback file whose ring has not changed.
    written: u64,
}

/// First allocation once a ring starts filling. Small enough that an idle pane
/// costs nothing, big enough that a chatty one is not re-growing constantly.
const MIN_ALLOC: usize = 8 * 1024;

impl Ring {
    /// New empty ring holding at most `cap` bytes.
    pub fn new(cap: usize) -> Self {
        Ring {
            cap,
            buf: Vec::new(),
            head: 0,
            written: 0,
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
        if self.cap == 0 || data.is_empty() {
            return;
        }
        self.written = self.written.saturating_add(data.len() as u64);
        // Only the newest `cap` bytes of an oversized push can survive, so drop
        // the rest before touching the buffer at all.
        let data = if data.len() > self.cap {
            &data[data.len() - self.cap..]
        } else {
            data
        };
        // Phase 1 — still filling: append, never past `cap`.
        if self.buf.len() < self.cap {
            let room = self.cap - self.buf.len();
            let take = room.min(data.len());
            self.reserve_up_to_cap(take);
            self.buf.extend_from_slice(&data[..take]);
            if take == data.len() {
                return;
            }
            // The buffer just reached exactly `cap` with bytes left over. `head`
            // is still 0 (nothing has wrapped yet), so the remainder overwrites
            // from the start.
            self.write_wrapping(&data[take..]);
            return;
        }
        // Phase 2 — full: overwrite in place from `head`.
        self.write_wrapping(data);
    }

    /// Grow towards `cap` geometrically, never past it. `reserve_exact` keeps
    /// `Vec` from doubling us over the cap — the whole point of this rewrite.
    fn reserve_up_to_cap(&mut self, additional: usize) {
        let needed = self.buf.len() + additional;
        if self.buf.capacity() >= needed {
            return;
        }
        let want = self
            .buf
            .capacity()
            .saturating_mul(2)
            .max(MIN_ALLOC)
            .max(needed)
            .min(self.cap);
        self.buf.reserve_exact(want - self.buf.len());
    }

    /// Overwrite `data` (which must be no longer than `cap`) at `head`, wrapping
    /// once at the end of the buffer. Requires `buf.len() == cap`.
    fn write_wrapping(&mut self, data: &[u8]) {
        debug_assert_eq!(self.buf.len(), self.cap);
        debug_assert!(data.len() <= self.cap);
        let n = data.len();
        let first = (self.cap - self.head).min(n);
        self.buf[self.head..self.head + first].copy_from_slice(&data[..first]);
        if first < n {
            self.buf[..n - first].copy_from_slice(&data[first..]);
        }
        self.head = (self.head + n) % self.cap;
    }

    /// Current contents, oldest byte first. One allocation of exactly [`len`],
    /// same as the previous implementation's clone.
    ///
    /// [`len`]: Self::len
    pub fn snapshot(&self) -> Vec<u8> {
        if self.head == 0 {
            return self.buf.clone();
        }
        let mut out = Vec::with_capacity(self.buf.len());
        out.extend_from_slice(&self.buf[self.head..]);
        out.extend_from_slice(&self.buf[..self.head]);
        out
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    /// Bytes actually allocated for the contents. Never exceeds `cap` — that is
    /// the property this type exists to hold, so it is observable and tested.
    pub fn allocated(&self) -> usize {
        self.buf.capacity()
    }

    /// Total bytes ever pushed (monotonic, survives eviction). A session whose
    /// counter is unchanged since the last snapshot has an unchanged scrollback,
    /// so the snapshot can skip both the clone and the disk write.
    pub fn written(&self) -> u64 {
        self.written
    }

    /// The last `n` bytes, trimmed forward to just after the first `\n` in the
    /// cut window so a preview never begins mid-escape-sequence. If the ring
    /// holds `n` bytes or fewer, everything is returned untrimmed — there was
    /// no arbitrary cut, so nothing to protect against. If a cut window
    /// contains no `\n`, it is returned unchanged rather than as nothing.
    pub fn tail(&self, n: usize) -> Vec<u8> {
        let all = self.snapshot();
        if all.len() <= n {
            return all;
        }
        let window = &all[all.len() - n..];
        match window.iter().position(|&b| b == b'\n') {
            Some(i) => window[i + 1..].to_vec(),
            None => window.to_vec(),
        }
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

    #[test]
    fn allocation_never_exceeds_the_cap() {
        // The old Vec+drain form let `extend_from_slice` push len past cap
        // BEFORE draining, which tripped Vec's amortized doubling — and drain
        // never shrinks. Measured on the real shape (2 MiB cap fed 256 KiB
        // batches, the daemon's BATCH_MAX_BYTES): capacity settled at exactly
        // 2x cap and stayed there for the session's life. On the live box that
        // was 36 MB of pure over-allocation across 18 full rings.
        let cap = 2 * 1024 * 1024;
        let mut r = Ring::new(cap);
        let chunk = vec![b'x'; 256 * 1024];
        for _ in 0..40 {
            r.push(&chunk);
        }
        assert_eq!(r.len(), cap, "ring should be full");
        assert!(
            r.allocated() <= cap,
            "ring allocated {} bytes for a {cap}-byte cap ({:.2}x overshoot)",
            r.allocated(),
            r.allocated() as f64 / cap as f64,
        );
    }

    #[test]
    fn allocation_stays_small_while_the_ring_is_far_under_cap() {
        // The flip side: a 2 MiB cap must not mean 2 MiB resident for a session
        // that has printed one prompt. Growth is geometric up to cap, never a
        // cap-sized allocation up front.
        let mut r = Ring::new(2 * 1024 * 1024);
        r.push(b"$ ");
        assert!(r.allocated() < 64 * 1024, "allocated {}", r.allocated());
    }

    #[test]
    fn wrapped_content_is_still_the_newest_bytes_in_order() {
        // Exercise the wrap path hard: many pushes whose sizes do not divide the
        // cap, so the head lands at every offset. The ring must always read back
        // as exactly the newest `cap` bytes of the concatenated stream.
        let cap = 61; // prime, so chunk sizes never align with it
        let mut r = Ring::new(cap);
        let mut all: Vec<u8> = Vec::new();
        for i in 0..200u32 {
            let chunk: Vec<u8> = (0..(i % 17) + 1).map(|k| (i as u8).wrapping_add(k as u8)).collect();
            r.push(&chunk);
            all.extend_from_slice(&chunk);
            let want = &all[all.len().saturating_sub(cap)..];
            assert_eq!(r.snapshot(), want, "mismatch after push {i}");
            assert_eq!(r.len(), want.len());
        }
    }

    #[test]
    fn a_push_spanning_the_wrap_point_keeps_byte_order() {
        // The two-part copy (tail of the buffer, then the head) is where an
        // off-by-one reverses or drops a segment. Fill exactly, then push a
        // chunk that straddles the seam.
        let mut r = Ring::new(8);
        r.push(b"abcdefgh"); // exactly full, head back at 0
        r.push(b"ijk"); // wraps: overwrites a,b,c
        assert_eq!(r.snapshot(), b"defghijk");
        r.push(b"lmnopqrs"); // a full-cap push onto a mid-wrap ring
        assert_eq!(r.snapshot(), b"lmnopqrs");
    }

    #[test]
    fn written_counts_every_byte_pushed_even_after_eviction() {
        // The snapshot timer uses this to skip rewriting a scrollback file whose
        // ring has not changed. It must count PUSHED bytes, not retained ones —
        // a ring at cap still changes on every push.
        let mut r = Ring::new(4);
        assert_eq!(r.written(), 0);
        r.push(b"abc");
        assert_eq!(r.written(), 3);
        r.push(b"defgh"); // over cap: content fully replaced, still 5 more bytes
        assert_eq!(r.written(), 8);
        r.push(b"");
        assert_eq!(r.written(), 8, "an empty push is not a change");
    }

    #[test]
    fn tail_of_empty_ring_is_empty() {
        let r = Ring::new(16);
        assert_eq!(r.tail(8), Vec::<u8>::new());
    }

    #[test]
    fn tail_of_zero_is_empty() {
        let mut r = Ring::new(16);
        r.push(b"hello");
        assert_eq!(r.tail(0), Vec::<u8>::new());
    }

    #[test]
    fn tail_returns_everything_untrimmed_when_ring_holds_n_or_fewer_bytes() {
        let mut r = Ring::new(16);
        r.push(b"hi\nthere"); // 8 bytes, contains a \n, must NOT be trimmed
        assert_eq!(r.tail(8), b"hi\nthere");
        assert_eq!(r.tail(100), b"hi\nthere");
    }

    #[test]
    fn tail_trims_forward_to_after_the_first_newline_in_the_cut_window() {
        let mut r = Ring::new(64);
        r.push(b"abcd\nefghij"); // 11 bytes total
        // tail(8) window = last 8 bytes = "d\nefghij"; the \n sits at window
        // index 1 (not index 0), so this also proves the trim is forward-from
        // -the-newline, not just "drop the first byte".
        assert_eq!(r.tail(8), b"efghij");
    }

    #[test]
    fn tail_returns_the_last_n_bytes() {
        let mut r = Ring::new(64);
        r.push(b"0123456789");
        assert_eq!(r.tail(4), b"6789");
    }

    #[test]
    fn tail_with_no_newline_in_window_returns_window_unchanged() {
        let mut r = Ring::new(64);
        r.push(b"xxxxxxxxxx"); // no newlines anywhere
        assert_eq!(r.tail(4), b"xxxx");
    }

    #[test]
    fn tail_works_after_the_ring_has_wrapped() {
        // The case a naive slice on the raw (unlinearised) buffer gets wrong.
        let cap = 8;
        let mut r = Ring::new(cap);
        r.push(b"abcdefgh"); // exactly full, head back at 0
        r.push(b"ijk"); // wraps: overwrites a,b,c -> ring is "defghijk"
        assert_eq!(r.snapshot(), b"defghijk");
        // tail(4) of "defghijk" = "hijk", no \n -> unchanged
        assert_eq!(r.tail(4), b"hijk");
        // full ring (8 bytes) requested with n=8 -> untrimmed passthrough
        assert_eq!(r.tail(8), b"defghijk");
    }

    #[test]
    fn tail_trim_after_wrap_with_newline_in_window() {
        let cap = 8;
        let mut r = Ring::new(cap);
        r.push(b"ab\ncdefg"); // fills to cap, head at 0
        r.push(b"hij"); // wraps: overwrites a,b,\n -> ring is "cdefghij"
        assert_eq!(r.snapshot(), b"cdefghij");
        // no newline left in the ring at all now
        assert_eq!(r.tail(5), b"fghij");
    }

    #[test]
    fn zero_cap_ring_reports_no_writes() {
        // cap 0 stores nothing, so it never "changes" — the snapshot skip must
        // not be tricked into rewriting an always-empty file forever.
        let mut r = Ring::new(0);
        r.push(b"anything");
        assert_eq!(r.written(), 0);
        assert_eq!(r.allocated(), 0);
    }
}
