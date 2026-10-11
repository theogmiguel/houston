//! Cancellation and absolute expiry belong to the queued operation, not its reply.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

#[derive(Clone)]
pub(crate) struct Dispatch {
    deadline: Instant,
    cancelled: Arc<AtomicBool>,
    latest: Option<(String, Arc<()>)>,
}

pub(crate) struct Operation(Dispatch);

impl Operation {
    pub(crate) fn new(timeout: Duration) -> Self {
        Self(Dispatch {
            deadline: Instant::now() + timeout,
            cancelled: Arc::new(AtomicBool::new(false)),
            latest: None,
        })
    }

    pub(crate) fn latest(key: String, timeout: Duration) -> Self {
        let mut operation = Self::new(timeout);
        let identity = Arc::new(());
        let mut latest = latest_operations()
            .lock()
            .expect("queued operation generations");
        latest.retain(|_, entry| entry.strong_count() != 0);
        latest.insert(key.clone(), Arc::downgrade(&identity));
        operation.0.latest = Some((key, identity));
        operation
    }

    pub(crate) fn dispatch(&self) -> Dispatch {
        self.0.clone()
    }
}

impl Drop for Operation {
    fn drop(&mut self) {
        self.0.cancelled.store(true, Ordering::SeqCst);
    }
}

impl Dispatch {
    pub(crate) fn is_live(&self) -> bool {
        !self.cancelled.load(Ordering::SeqCst)
            && Instant::now() < self.deadline
            && self.latest.as_ref().is_none_or(|(key, identity)| {
                latest_operations()
                    .lock()
                    .expect("queued operation generations")
                    .get(key)
                    .and_then(std::sync::Weak::upgrade)
                    .is_some_and(|current| Arc::ptr_eq(&current, identity))
            })
    }
}

fn latest_operations(
) -> &'static std::sync::Mutex<std::collections::HashMap<String, std::sync::Weak<()>>> {
    static LATEST: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, std::sync::Weak<()>>>,
    > = std::sync::OnceLock::new();
    LATEST.get_or_init(Default::default)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn delayed_executor_cannot_mutate_after_reply_expiry_or_cancellation() {
        let effects = Arc::new(AtomicUsize::new(0));
        for timeout in [Duration::ZERO, Duration::from_secs(60)] {
            let operation = Operation::new(timeout);
            let dispatch = operation.dispatch();
            let effects = effects.clone();
            // An injectable native executor retains this exact queued closure.
            let queued = move || {
                if dispatch.is_live() {
                    effects.fetch_add(1, Ordering::SeqCst);
                }
            };
            if timeout.is_zero() {
                queued();
                drop(operation);
            } else {
                drop(operation);
                queued();
            }
        }
        assert_eq!(effects.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn geometry_executor_discards_a_superseded_generation() {
        let old = Operation::latest("fixture-layout".into(), Duration::from_secs(60));
        let queued = old.dispatch();
        let newer = Operation::latest("fixture-layout".into(), Duration::from_secs(60));
        assert!(!queued.is_live());
        assert!(newer.dispatch().is_live());
    }

    #[test]
    fn live_executor_performs_the_operation() {
        let operation = Operation::new(Duration::from_secs(60));
        assert!(operation.dispatch().is_live());
    }
}
