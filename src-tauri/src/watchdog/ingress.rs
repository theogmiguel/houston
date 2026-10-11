use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::Arc;
use std::time::Duration;

use super::machine::{Event, TerminationReason};
use super::Msg;

// A stalled supervisor retains at most 32 receipts. Native state hints are
// latest-value slots; stop, navigation and process loss cannot be crowded out.
const CAPACITY: usize = 32;

#[derive(Debug)]
pub(super) struct SendError;

#[derive(Clone)]
pub(super) struct Sender {
    tx: SyncSender<Msg>,
    prompt_tx: SyncSender<Msg>,
    pub(super) stop: Arc<AtomicBool>,
    terminated: Arc<AtomicU8>,
    loaded: Arc<AtomicBool>,
    hints: Arc<[AtomicU8; 4]>,
    pub(super) dropped: Arc<AtomicU64>,
}

pub(super) struct Inbox {
    rx: Receiver<Msg>,
    prompt_rx: Receiver<Msg>,
    sender: Sender,
}

pub(super) fn channel() -> (Sender, Inbox) {
    let (tx, rx) = mpsc::sync_channel(CAPACITY);
    let (prompt_tx, prompt_rx) = mpsc::sync_channel(1);
    let sender = Sender {
        tx,
        prompt_tx,
        stop: Arc::new(AtomicBool::new(false)),
        terminated: Arc::new(AtomicU8::new(0)),
        loaded: Arc::new(AtomicBool::new(false)),
        hints: Arc::new(std::array::from_fn(|_| AtomicU8::new(0))),
        dropped: Arc::new(AtomicU64::new(0)),
    };
    (
        sender.clone(),
        Inbox {
            rx,
            prompt_rx,
            sender,
        },
    )
}

impl Sender {
    pub(super) fn send(&self, msg: Msg) -> Result<(), SendError> {
        if self.stop.load(Ordering::SeqCst) {
            return Err(SendError);
        }
        let msg = match msg {
            answer @ Msg::PromptAnswer { .. } => {
                // The sole physical prompt permit stays in its answer until receipt.
                // Ordinary traffic cannot drop the user's Wait choice.
                if self.prompt_tx.try_send(answer).is_err() {
                    return Err(SendError);
                }
                Msg::Wake
            }
            Msg::Event(Event::WebProcessTerminated { reason }) => {
                self.terminated.fetch_or(
                    match reason {
                        TerminationReason::Crashed => 4,
                        TerminationReason::ExceededMemoryLimit => 2,
                        TerminationReason::TerminatedByApi => 1,
                    },
                    Ordering::SeqCst,
                );
                Msg::Wake
            }
            Msg::Event(Event::PageLoaded) => {
                self.loaded.store(true, Ordering::SeqCst);
                Msg::Wake
            }
            Msg::Event(Event::WindowVisible(value)) => {
                self.hint(0, value);
                Msg::Wake
            }
            Msg::Event(Event::WindowFocused(value)) => {
                self.hint(1, value);
                Msg::Wake
            }
            Msg::Event(Event::InspectorAttached(value)) => {
                self.hint(2, value);
                Msg::Wake
            }
            Msg::Event(Event::ResponsivenessChanged { responsive }) => {
                self.hint(3, responsive);
                Msg::Wake
            }
            other => other,
        };
        match self.tx.try_send(msg) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(Msg::Wake)) => Ok(()),
            Err(TrySendError::Full(_)) => {
                self.dropped.fetch_add(1, Ordering::Relaxed);
                Err(SendError)
            }
            Err(TrySendError::Disconnected(_)) => Err(SendError),
        }
    }
    fn hint(&self, index: usize, value: bool) {
        self.hints[index].store(if value { 2 } else { 1 }, Ordering::SeqCst);
    }
    pub(super) fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = self.tx.try_send(Msg::Wake);
    }
}

impl Inbox {
    pub(super) fn recv_timeout(&self, duration: Duration) -> Result<Msg, RecvTimeoutError> {
        if self.sender.stop.load(Ordering::SeqCst) {
            return Err(RecvTimeoutError::Disconnected);
        }
        for (bit, reason) in [
            (4, TerminationReason::Crashed),
            (2, TerminationReason::ExceededMemoryLimit),
            (1, TerminationReason::TerminatedByApi),
        ] {
            if self.sender.terminated.fetch_and(!bit, Ordering::SeqCst) & bit != 0 {
                return Ok(Msg::Event(Event::WebProcessTerminated { reason }));
            }
        }
        if self.sender.loaded.swap(false, Ordering::SeqCst) {
            return Ok(Msg::Event(Event::PageLoaded));
        }
        if let Ok(answer) = self.prompt_rx.try_recv() {
            return Ok(answer);
        }
        for (index, hint) in self.sender.hints.iter().enumerate() {
            let value = hint.swap(0, Ordering::SeqCst);
            if value != 0 {
                let value = value == 2;
                return Ok(Msg::Event(match index {
                    0 => Event::WindowVisible(value),
                    1 => Event::WindowFocused(value),
                    2 => Event::InspectorAttached(value),
                    _ => Event::ResponsivenessChanged { responsive: value },
                }));
            }
        }
        self.rx.recv_timeout(duration)
    }
}

#[derive(Clone)]
pub(super) struct EventSender(pub(super) Sender);
impl EventSender {
    pub(super) fn send(&self, event: Event) -> Result<(), SendError> {
        self.0.send(Msg::Event(event))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn coalescing_process_loss_keeps_each_distinct_reason() {
        let (tx, rx) = channel();
        for reason in [
            TerminationReason::TerminatedByApi,
            TerminationReason::Crashed,
            TerminationReason::ExceededMemoryLimit,
        ] {
            tx.send(Msg::Event(Event::WebProcessTerminated { reason }))
                .unwrap();
        }
        for expected in [
            TerminationReason::Crashed,
            TerminationReason::ExceededMemoryLimit,
            TerminationReason::TerminatedByApi,
        ] {
            assert!(
                matches!(rx.recv_timeout(Duration::ZERO), Ok(Msg::Event(Event::WebProcessTerminated { reason })) if reason == expected)
            );
        }
    }

    #[test]
    fn stop_wakes_and_releases_an_owner_even_when_external_senders_remain() {
        let (tx, rx) = channel();
        let owner = Arc::new(());
        let weak = Arc::downgrade(&owner);
        let (done, completed) = mpsc::sync_channel(1);
        let worker = std::thread::spawn(move || {
            let _owner = owner;
            while rx.recv_timeout(Duration::from_secs(10)).is_ok() {}
            done.send(()).unwrap();
        });
        tx.stop();
        completed.recv_timeout(Duration::from_secs(10)).unwrap();
        worker.join().unwrap();
        assert!(weak.upgrade().is_none());
        assert!(tx.send(Msg::Event(Event::Tick)).is_err());
    }

    #[test]
    fn a_wait_answer_has_reserved_receipt_ownership_under_ordinary_flood() {
        let (tx, rx) = channel();
        for _ in 0..100 {
            let _ = tx.send(Msg::Event(Event::Tick));
        }
        let gate = super::super::WorkGate::new(1);
        let permit = gate.acquire().unwrap();
        tx.send(Msg::PromptAnswer {
            _permit: permit,
            incident_id: 1,
            generation: 1,
            outcome: super::super::PromptOutcome::Decline,
        })
        .unwrap();
        assert!(gate.acquire().is_none());
        let answer = rx.recv_timeout(Duration::ZERO).unwrap();
        assert!(matches!(
            &answer,
            Msg::PromptAnswer {
                outcome: super::super::PromptOutcome::Decline,
                ..
            }
        ));
        drop(answer);
        assert!(gate.acquire().is_some());
    }

    #[test]
    fn blocked_consumer_plateaus_and_keeps_termination_latest_visibility_and_stop() {
        let (tx, rx) = channel();
        for i in 0..10_000 {
            let _ = tx.send(Msg::Event(Event::WindowVisible(i % 2 == 0)));
            let _ = tx.send(Msg::Event(Event::ReloadRequested {
                reason: "test".into(),
            }));
        }
        assert!(tx.dropped.load(Ordering::Relaxed) > 0);
        let _ = tx.send(Msg::Event(Event::WebProcessTerminated {
            reason: TerminationReason::Crashed,
        }));
        assert!(matches!(
            rx.recv_timeout(Duration::ZERO),
            Ok(Msg::Event(Event::WebProcessTerminated { .. }))
        ));
        assert!(matches!(
            rx.recv_timeout(Duration::ZERO),
            Ok(Msg::Event(Event::WindowVisible(false)))
        ));
        assert!(rx.rx.try_iter().count() <= CAPACITY);
        tx.stop();
        assert!(matches!(
            rx.recv_timeout(Duration::ZERO),
            Err(RecvTimeoutError::Disconnected)
        ));
    }
}
