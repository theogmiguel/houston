use crate::daemon::Outbound;
use houston_protocol as proto;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast::{self, error::RecvError};
use tokio::sync::Notify;

// A safety net against pathological non-contiguous fan-in (interleaved sessions, many
// gap-separated survivors), not the real limit -- merging on offer collapses the
// contiguous case this used to bound.
pub const FRAME_QUEUE_DEPTH: usize = 4096;

// The queue's real bound now that merging removes frame count as a practical limiter.
// Kept equal to SCROLLBACK_CAP so it also covers the burst produced while a whole-ring
// replay is written to the same socket ahead of these frames.
pub const FRAME_QUEUE_BYTES: usize = 4 * 1024 * 1024;

// Per-item ceiling for coalescing a contiguous run on enqueue: large enough to absorb a
// scheduling gap in one message, small enough that one slow neighbour's backlog never
// becomes a single multi-megabyte write.
pub const FRAME_MERGE_CEILING_BYTES: usize = 256 * 1024;

pub enum Queued {
    Frame(Arc<Vec<u8>>),
    // A drop episode that ended: `anchor` is where loss began in stream offset, `dropped`
    // the payload bytes lost. Always ordered after every frame preceding the loss and
    // before any that survived it, so a client seeing one knows to re-attach.
    Gap { anchor: u64, dropped: u64 },
}

struct PendingFrame {
    session: u32,
    offset: u64,
    payload: Vec<u8>,
}

struct TapState {
    queue: VecDeque<Queued>,
    frames: usize,
    bytes: usize,
    pending: Option<PendingFrame>,
    dropped: u64,
    drop_anchor: u64,
    dropping: bool,
    cutoff: u64,
    attempts: u32,
}

pub struct FrameTap {
    session: Option<u32>,
    wake: Arc<Notify>,
    state: Mutex<TapState>,
}

impl FrameTap {
    pub fn new(session: Option<u32>, wake: Arc<Notify>) -> Arc<Self> {
        Arc::new(Self {
            session,
            wake,
            state: Mutex::new(TapState {
                queue: VecDeque::new(),
                frames: 0,
                bytes: 0,
                pending: None,
                dropped: 0,
                drop_anchor: 0,
                dropping: false,
                cutoff: 0,
                attempts: 0,
            }),
        })
    }

    pub fn session(&self) -> Option<u32> {
        self.session
    }

    pub fn offer(&self, offset: u64, payload_len: usize, frame: &Arc<Vec<u8>>) {
        let mut s = self.state.lock().expect("frame tap lock");
        if offset + payload_len as u64 <= s.cutoff {
            return;
        }

        let (session, _, payload) =
            proto::decode_output_frame(frame).expect("offer receives encode_output_frame output");

        let merge_ok = tail_merge_target(&s, session, offset, payload_len);

        if merge_ok.is_none() && s.frames >= FRAME_QUEUE_DEPTH {
            record_drop(&mut s, offset, payload_len);
            return;
        }
        if s.bytes + payload_len > FRAME_QUEUE_BYTES {
            record_drop(&mut s, offset, payload_len);
            return;
        }

        if merge_ok.is_none() {
            finalize_pending(&mut s);
        }
        if s.dropping {
            let gap = Queued::Gap {
                anchor: s.drop_anchor,
                dropped: s.dropped,
            };
            s.queue.push_back(gap);
            s.dropping = false;
            s.dropped = 0;
        }

        match merge_ok {
            Some(TailMerge::Pending) => {
                s.pending
                    .as_mut()
                    .expect("TailMerge::Pending implies a pending frame")
                    .payload
                    .extend_from_slice(payload);
                s.bytes += payload_len;
            }
            Some(TailMerge::QueuedFrame) => {
                let Some(Queued::Frame(last)) = s.queue.pop_back() else {
                    unreachable!("TailMerge::QueuedFrame implies a queued frame tail")
                };
                let (_, last_offset, last_payload) = proto::decode_output_frame(&last)
                    .expect("queued frames are encode_output_frame output");
                let mut merged = Vec::with_capacity(last_payload.len() + payload_len);
                merged.extend_from_slice(last_payload);
                merged.extend_from_slice(payload);
                s.pending = Some(PendingFrame {
                    session,
                    offset: last_offset,
                    payload: merged,
                });
                s.bytes += payload_len;
            }
            None => {
                s.queue.push_back(Queued::Frame(Arc::clone(frame)));
                s.frames += 1;
                s.bytes += payload_len;
            }
        }
        drop(s);
        self.wake.notify_one();
    }

    pub fn clear(&self) {
        let mut s = self.state.lock().expect("frame tap lock");
        s.queue.clear();
        s.pending = None;
        s.frames = 0;
        s.bytes = 0;
        s.dropping = false;
        s.dropped = 0;
    }

    pub fn drain(&self) -> VecDeque<Queued> {
        let mut s = self.state.lock().expect("frame tap lock");
        finalize_pending(&mut s);
        let mut out = std::mem::take(&mut s.queue);
        s.frames = 0;
        s.bytes = 0;
        if s.dropping {
            out.push_back(Queued::Gap {
                anchor: s.drop_anchor,
                dropped: s.dropped,
            });
            s.dropping = false;
            s.dropped = 0;
        }
        out
    }

    pub fn attach(&self, bytes_seen: Option<u64>) -> u32 {
        let mut s = self.state.lock().expect("frame tap lock");
        s.attempts += 1;
        let Some(cutoff) = bytes_seen else {
            return s.attempts;
        };
        finalize_pending(&mut s);
        s.cutoff = cutoff;
        s.queue.retain(|q| match q {
            Queued::Frame(frame) => frame_end(frame) > cutoff,
            Queued::Gap { anchor, dropped } => anchor + dropped > cutoff,
        });
        s.frames = s
            .queue
            .iter()
            .filter(|q| matches!(q, Queued::Frame(_)))
            .count();
        s.bytes = s
            .queue
            .iter()
            .map(|q| match q {
                Queued::Frame(frame) => frame.len() - proto::FRAME_OUTPUT_HEADER_LEN,
                Queued::Gap { .. } => 0,
            })
            .sum();
        if s.dropping && s.drop_anchor + s.dropped <= cutoff {
            s.dropping = false;
            s.dropped = 0;
        }
        s.attempts
    }
}

enum TailMerge {
    Pending,
    QueuedFrame,
}

fn tail_merge_target(
    s: &TapState,
    session: u32,
    offset: u64,
    payload_len: usize,
) -> Option<TailMerge> {
    if let Some(p) = &s.pending {
        return (p.session == session
            && p.offset + p.payload.len() as u64 == offset
            && p.payload.len() + payload_len <= FRAME_MERGE_CEILING_BYTES)
            .then_some(TailMerge::Pending);
    }
    let Some(Queued::Frame(last)) = s.queue.back() else {
        return None;
    };
    let (last_session, last_offset, last_payload) =
        proto::decode_output_frame(last).expect("queued frames are encode_output_frame output");
    (last_session == session
        && last_offset + last_payload.len() as u64 == offset
        && last_payload.len() + payload_len <= FRAME_MERGE_CEILING_BYTES)
        .then_some(TailMerge::QueuedFrame)
}

fn record_drop(s: &mut TapState, offset: u64, payload_len: usize) {
    s.dropped += payload_len as u64;
    if !s.dropping {
        s.dropping = true;
        s.drop_anchor = offset;
    }
}

fn finalize_pending(s: &mut TapState) {
    if let Some(p) = s.pending.take() {
        s.queue
            .push_back(Queued::Frame(Arc::new(proto::encode_output_frame(
                p.session, p.offset, &p.payload,
            ))));
    }
}

fn frame_end(frame: &[u8]) -> u64 {
    let (_, offset, payload) =
        proto::decode_output_frame(frame).expect("queued frames are encode_output_frame output");
    offset + payload.len() as u64
}

#[derive(Default)]
struct RegistryInner {
    by_session: HashMap<u32, Vec<Arc<FrameTap>>>,
    every: Vec<Arc<FrameTap>>,
}

#[derive(Default)]
pub struct FrameRegistry {
    inner: Mutex<RegistryInner>,
}

impl FrameRegistry {
    pub fn register(&self, tap: &Arc<FrameTap>) {
        let mut inner = self.inner.lock().expect("frame registry lock");
        match tap.session {
            Some(id) => inner
                .by_session
                .entry(id)
                .or_default()
                .push(Arc::clone(tap)),
            None => inner.every.push(Arc::clone(tap)),
        }
    }

    pub fn unregister(&self, tap: &Arc<FrameTap>) {
        let mut inner = self.inner.lock().expect("frame registry lock");
        match tap.session {
            Some(id) => {
                if let Some(taps) = inner.by_session.get_mut(&id) {
                    taps.retain(|t| !Arc::ptr_eq(t, tap));
                    if taps.is_empty() {
                        inner.by_session.remove(&id);
                    }
                }
            }
            None => inner.every.retain(|t| !Arc::ptr_eq(t, tap)),
        }
    }

    pub fn forget_session(&self, session: u32) {
        self.inner
            .lock()
            .expect("frame registry lock")
            .by_session
            .remove(&session);
    }

    pub fn offer(&self, session: u32, offset: u64, payload_len: usize, frame: &Arc<Vec<u8>>) {
        let inner = self.inner.lock().expect("frame registry lock");
        if let Some(taps) = inner.by_session.get(&session) {
            for tap in taps {
                tap.offer(offset, payload_len, frame);
            }
        }
        for tap in &inner.every {
            tap.offer(offset, payload_len, frame);
        }
    }
}

pub struct Observer {
    control: broadcast::Receiver<Outbound>,
    tap: Arc<FrameTap>,
    wake: Arc<Notify>,
    pending: VecDeque<Queued>,
    registry: Arc<FrameRegistry>,
}

impl Observer {
    pub fn new(control: broadcast::Receiver<Outbound>, registry: Arc<FrameRegistry>) -> Self {
        let wake = Arc::new(Notify::new());
        let tap = FrameTap::new(None, Arc::clone(&wake));
        registry.register(&tap);
        Self {
            control,
            tap,
            wake,
            pending: VecDeque::new(),
            registry,
        }
    }

    pub async fn recv(&mut self) -> Result<Outbound, RecvError> {
        loop {
            if let Some(next) = self.pending.pop_front() {
                return match next {
                    Queued::Frame(frame) => Ok(Outbound::Frame(frame)),
                    Queued::Gap { dropped, .. } => Err(RecvError::Lagged(dropped)),
                };
            }
            tokio::select! {
                out = self.control.recv() => return out,
                _ = self.wake.notified() => self.pending = self.tap.drain(),
            }
        }
    }
}

impl Drop for Observer {
    fn drop(&mut self) {
        self.registry.unregister(&self.tap);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(session: u32, offset: u64, len: usize) -> Arc<Vec<u8>> {
        Arc::new(proto::encode_output_frame(
            session,
            offset,
            &vec![b'x'; len],
        ))
    }

    type Shape = (Option<u64>, Option<(u64, u64)>);

    fn offsets(items: &VecDeque<Queued>) -> Vec<Shape> {
        items
            .iter()
            .map(|q| match q {
                Queued::Frame(f) => (Some(proto::decode_output_frame(f).unwrap().1), None),
                Queued::Gap { anchor, dropped } => (None, Some((*anchor, *dropped))),
            })
            .collect()
    }

    #[test]
    fn contiguous_frames_merge_into_one_queued_frame() {
        let tap = FrameTap::new(Some(1), Arc::new(Notify::new()));
        let mut offset = 0u64;
        for _ in 0..5 {
            tap.offer(offset, 10, &frame(1, offset, 10));
            offset += 10;
        }
        let items = tap.drain();
        assert_eq!(
            items.len(),
            1,
            "five contiguous reads coalesce into one frame"
        );
        let Some(Queued::Frame(f)) = items.front() else {
            panic!("expected a merged frame");
        };
        let (session, start, payload) = proto::decode_output_frame(f).unwrap();
        assert_eq!((session, start, payload.len()), (1, 0, 50));
    }

    #[test]
    fn the_merge_ceiling_splits_a_long_contiguous_run() {
        let tap = FrameTap::new(Some(1), Arc::new(Notify::new()));
        let chunk = 1024usize;
        assert_eq!(
            FRAME_MERGE_CEILING_BYTES % chunk,
            0,
            "the ceiling must divide evenly for this test's exact-fit chunk"
        );
        let chunks_per_ceiling = FRAME_MERGE_CEILING_BYTES / chunk;
        let mut offset = 0u64;
        for _ in 0..chunks_per_ceiling + 1 {
            tap.offer(offset, chunk, &frame(1, offset, chunk));
            offset += chunk as u64;
        }
        let items = tap.drain();
        assert_eq!(
            items.len(),
            2,
            "the ceiling closes the first frame; the next chunk starts a second"
        );
        let ends: Vec<u64> = items
            .iter()
            .map(|q| match q {
                Queued::Frame(f) => frame_end(f),
                Queued::Gap { .. } => panic!("no gap expected in an unbroken contiguous run"),
            })
            .collect();
        assert_eq!(ends, vec![FRAME_MERGE_CEILING_BYTES as u64, offset]);
    }

    #[test]
    fn the_item_count_safety_net_drops_interleaved_sessions_well_under_the_byte_bound() {
        let tap = FrameTap::new(None, Arc::new(Notify::new()));
        for i in 0..(FRAME_QUEUE_DEPTH + 2) as u64 {
            let session = 1 + (i % 2) as u32;
            tap.offer(i, 1, &frame(session, i, 1));
        }
        let items = tap.drain();
        assert_eq!(
            items.len(),
            FRAME_QUEUE_DEPTH + 1,
            "DEPTH survivors (none merged: alternating sessions) then one gap"
        );
        assert!(
            matches!(items.back(), Some(Queued::Gap { dropped: 2, .. })),
            "both overflow frames, from either session, land in one gap"
        );
    }

    #[test]
    fn a_full_queue_drops_its_own_frames_and_a_gap_precedes_the_first_survivor() {
        let tap = FrameTap::new(Some(1), Arc::new(Notify::new()));
        let big = FRAME_QUEUE_BYTES / 2 + 1;
        tap.offer(0, big, &frame(1, 0, big));
        tap.offer(big as u64, big, &frame(1, big as u64, big));
        let first = tap.drain();
        assert_eq!(first.len(), 2, "the frame that fit, then one gap");
        assert!(matches!(first.front(), Some(Queued::Frame(_))));
        assert!(
            matches!(first.back(), Some(Queued::Gap { anchor, dropped }) if *anchor == big as u64 && *dropped == big as u64),
            "gap anchored where loss began, counting every dropped payload byte"
        );

        let resumed = 2 * big as u64;
        tap.offer(resumed, 10, &frame(1, resumed, 10));
        let second = tap.drain();
        assert_eq!(
            offsets(&second),
            vec![(Some(resumed), None)],
            "the episode closed at the drain; a later frame carries no second gap"
        );
    }

    #[test]
    fn a_gap_is_queued_ahead_of_the_frame_that_ends_the_episode() {
        let tap = FrameTap::new(Some(1), Arc::new(Notify::new()));
        let big = FRAME_QUEUE_BYTES / 2 + 1;
        tap.offer(0, big, &frame(1, 0, big));
        tap.offer(big as u64, big, &frame(1, big as u64, big));
        let resumed = 2 * big as u64;
        tap.offer(resumed, 10, &frame(1, resumed, 10));
        let items = tap.drain();
        assert_eq!(
            offsets(&items),
            vec![
                (Some(0), None),
                (None, Some((big as u64, big as u64))),
                (Some(resumed), None),
            ],
            "the gap sits strictly between the frame that fit and the one that ended the episode"
        );
    }

    #[test]
    fn a_gap_never_precedes_a_still_pending_frame_that_predates_it() {
        let tap = FrameTap::new(Some(1), Arc::new(Notify::new()));
        tap.offer(0, 10, &frame(1, 0, 10));
        tap.offer(10, 10, &frame(1, 10, 10));
        let big = FRAME_QUEUE_BYTES;
        tap.offer(20, big, &frame(1, 20, big));
        let resumed = 20 + big as u64 + 1000;
        tap.offer(resumed, 5, &frame(1, resumed, 5));
        let items = tap.drain();
        assert_eq!(
            offsets(&items),
            vec![
                (Some(0), None),
                (None, Some((20, big as u64))),
                (Some(resumed), None),
            ],
            "the pending frame that predates the drop must be flushed ahead of its gap"
        );
    }

    #[test]
    fn the_byte_bound_trips_before_the_frame_count_on_large_reads() {
        let tap = FrameTap::new(Some(1), Arc::new(Notify::new()));
        let big = FRAME_QUEUE_BYTES / 2 + 1;
        tap.offer(0, big, &frame(1, 0, big));
        tap.offer(big as u64, big, &frame(1, big as u64, big));
        let items = tap.drain();
        assert_eq!(
            offsets(&items),
            vec![(Some(0), None), (None, Some((big as u64, big as u64)))]
        );
    }

    #[test]
    fn attach_prunes_what_the_replay_covers_and_refuses_it_afterwards() {
        let tap = FrameTap::new(Some(1), Arc::new(Notify::new()));
        tap.offer(0, 10, &frame(1, 0, 10));
        tap.offer(10, 10, &frame(1, 10, 10));
        tap.offer(20, 10, &frame(1, 20, 10));
        assert_eq!(tap.attach(Some(15)), 1);
        assert_eq!(offsets(&tap.drain()), vec![(Some(0), None)]);
        tap.offer(5, 10, &frame(1, 5, 10));
        assert!(
            tap.drain().is_empty(),
            "a frame ending at the cutoff is refused"
        );
        tap.offer(30, 10, &frame(1, 30, 10));
        assert_eq!(offsets(&tap.drain()), vec![(Some(30), None)]);
    }

    #[test]
    fn attach_closes_an_episode_the_replay_covers_and_keeps_one_it_does_not() {
        let tap = FrameTap::new(Some(1), Arc::new(Notify::new()));
        let big = FRAME_QUEUE_BYTES / 2 + 1;
        tap.offer(0, big, &frame(1, 0, big));
        tap.offer(big as u64, big, &frame(1, big as u64, big));
        let loss_end = 2 * big as u64;
        assert_eq!(tap.attach(Some(loss_end)), 1);
        assert!(tap.drain().is_empty());

        tap.offer(loss_end, 10, &frame(1, loss_end, 10));
        assert_eq!(offsets(&tap.drain()), vec![(Some(loss_end), None)]);

        let second_start = loss_end + 10;
        tap.offer(second_start, big, &frame(1, second_start, big));
        let second_loss_anchor = second_start + big as u64;
        tap.offer(second_loss_anchor, big, &frame(1, second_loss_anchor, big));
        assert_eq!(tap.attach(Some(second_loss_anchor - 10)), 2);
        let items = tap.drain();
        assert!(
            matches!(items.back(), Some(Queued::Gap { .. })),
            "an episode extending past the replay survives the attach"
        );
    }

    #[test]
    fn a_refused_attach_still_counts_toward_the_attachment_number() {
        let tap = FrameTap::new(Some(1), Arc::new(Notify::new()));
        assert_eq!(tap.attach(None), 1);
        assert_eq!(tap.attach(Some(0)), 2);
    }

    #[test]
    fn a_drop_open_at_drain_time_is_reported_even_with_no_frame_behind_it() {
        let tap = FrameTap::new(Some(1), Arc::new(Notify::new()));
        let big = FRAME_QUEUE_BYTES / 2 + 1;
        tap.offer(0, big, &frame(1, 0, big));
        tap.offer(big as u64, big, &frame(1, big as u64, big));
        let items = tap.drain();
        assert!(
            matches!(items.back(), Some(Queued::Gap { anchor, dropped }) if *anchor == big as u64 && *dropped == big as u64)
        );
        assert!(
            tap.drain().is_empty(),
            "the episode is closed by the drain that reported it"
        );
    }

    #[test]
    fn the_registry_feeds_session_taps_and_wildcards_and_forgets_cleanly() {
        let registry = FrameRegistry::default();
        let wake = Arc::new(Notify::new());
        let one = FrameTap::new(Some(1), Arc::clone(&wake));
        let all = FrameTap::new(None, Arc::clone(&wake));
        registry.register(&one);
        registry.register(&all);
        registry.offer(1, 0, 3, &frame(1, 0, 3));
        registry.offer(2, 0, 3, &frame(2, 0, 3));
        assert_eq!(one.drain().len(), 1);
        assert_eq!(all.drain().len(), 2);
        registry.unregister(&one);
        registry.offer(1, 3, 3, &frame(1, 3, 3));
        assert!(one.drain().is_empty());
        assert_eq!(all.drain().len(), 1);
        registry.forget_session(1);
        registry.unregister(&all);
        registry.offer(1, 6, 3, &frame(1, 6, 3));
        assert!(all.drain().is_empty());
    }
}
