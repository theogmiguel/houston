use crate::daemon::Daemon;
use houston_protocol as proto;
use notify::Watcher as _;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

const MAX_HEAD_WATCHES: usize = 256; // Bounds inotify use while covering a typical workspace set.
const DEBOUNCE: Duration = Duration::from_millis(250);
const FALLBACK_POLL: Duration = Duration::from_secs(30);

struct HeadWatch {
    refs: HashSet<u32>,
    watcher: Option<notify::RecommendedWatcher>,
}

/// Resolve the per-checkout HEAD file, including the indirection used by linked worktrees.
pub(crate) fn head_path(root: &Path) -> Option<PathBuf> {
    let dot_git = root.join(".git");
    if dot_git.is_dir() {
        return Some(dot_git.join("HEAD"));
    }
    let contents = std::fs::read_to_string(dot_git).ok()?;
    let target = contents.split_once("gitdir:")?.1.trim();
    if target.is_empty() {
        return None;
    }
    let gitdir = Path::new(target);
    let gitdir = if gitdir.is_absolute() {
        gitdir.to_path_buf()
    } else {
        root.join(gitdir)
    };
    Some(gitdir.join("HEAD"))
}

/// Events whose paths name the HEAD file and could change it. Reads of HEAD,
/// including the watcher's own refreshes, must not wake the watcher again.
fn is_head_change(event: &notify::Event, head: &Path) -> bool {
    crate::fs_watch::is_content_change(event.kind)
        && (event.paths.is_empty()
            || event
                .paths
                .iter()
                .any(|path| path.file_name() == head.file_name()))
}

/// HEAD files with an unhandled change; each appears once however many events
/// arrive, so a burst costs one refresh and memory stays bounded by the watches.
#[derive(Default)]
struct Hints {
    dirty: std::sync::Mutex<HashSet<PathBuf>>,
    wake: tokio::sync::Notify,
}

impl Hints {
    fn note(&self, head: &Path) {
        self.dirty
            .lock()
            .expect("checkout hints lock")
            .insert(head.to_path_buf());
        self.wake.notify_one();
    }
}

pub async fn checkout_watch_loop(daemon: Arc<Daemon>) {
    let hints = Arc::new(Hints::default());
    let mut watches: HashMap<PathBuf, HeadWatch> = HashMap::new();
    let mut previous: HashMap<u32, Option<proto::SessionCheckout>> = HashMap::new();
    let mut pending: HashMap<PathBuf, Instant> = HashMap::new();
    let mut warned_overflow = HashSet::new();
    let mut next_fallback_poll = Instant::now() + FALLBACK_POLL;
    let mut ticker = tokio::time::interval(Duration::from_secs(1));

    loop {
        tokio::select! {
            _ = hints.wake.notified() => {}
            _ = ticker.tick() => {}
        }
        let deadline = Instant::now() + DEBOUNCE;
        for head in std::mem::take(&mut *hints.dirty.lock().expect("checkout hints lock")) {
            pending.insert(head, deadline);
        }

        let sessions = daemon.checkout_watch_sessions();
        let mut refs: HashMap<PathBuf, HashSet<u32>> = HashMap::new();
        for info in &sessions {
            let Some(checkout) = info.checkout.as_ref() else {
                continue;
            };
            let Some(head) = head_path(Path::new(&checkout.root)) else {
                continue;
            };
            refs.entry(head).or_default().insert(info.id);
            previous
                .entry(info.id)
                .or_insert_with(|| Some(checkout.clone()));
        }
        previous.retain(|id, _| sessions.iter().any(|session| session.id == *id));

        watches.retain(|head, watch| {
            if let Some(ids) = refs.remove(head) {
                watch.refs = ids;
                true
            } else {
                false
            }
        });

        let distinct = watches.len() + refs.len();
        let overflow = distinct.saturating_sub(MAX_HEAD_WATCHES);
        if overflow > 0 {
            let available = MAX_HEAD_WATCHES.saturating_sub(watches.len());
            for head in refs.keys().skip(available) {
                if warned_overflow.insert(head.clone()) {
                    tracing::warn!(
                        "checkout HEAD watcher limit reached: limit {}, actual {}, dir {}",
                        MAX_HEAD_WATCHES,
                        distinct,
                        head.display()
                    );
                }
            }
        }

        for (head, ids) in refs {
            let can_watch = watches.len() < MAX_HEAD_WATCHES;
            let watcher = if can_watch {
                let callback_hints = hints.clone();
                let event_head = head.clone();
                match notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                    match event {
                        Ok(event) if is_head_change(&event, &event_head) => {
                            callback_hints.note(&event_head);
                        }
                        Ok(_) => {}
                        Err(error) => tracing::warn!("checkout HEAD watcher error: {error}"),
                    }
                }) {
                    Ok(mut watcher) => {
                        let dir = head.parent().unwrap_or(Path::new("."));
                        match watcher.watch(dir, notify::RecursiveMode::NonRecursive) {
                            Ok(()) => Some(watcher),
                            Err(error) => {
                                tracing::warn!("checkout HEAD watch failed for {}: {error}; polling every 30 s", head.display());
                                None
                            }
                        }
                    }
                    Err(error) => {
                        tracing::warn!(
                            "checkout HEAD watch failed for {}: {error}; polling every 30 s",
                            head.display()
                        );
                        None
                    }
                }
            } else {
                None
            };
            if watcher.is_some() {
                pending.insert(head.clone(), Instant::now() + DEBOUNCE);
            }
            watches.insert(head, HeadWatch { refs: ids, watcher });
        }

        let now = Instant::now();
        let due: Vec<PathBuf> = pending
            .iter()
            .filter(|(_, deadline)| **deadline <= now)
            .map(|(path, _)| path.clone())
            .collect();
        for head in due {
            pending.remove(&head);
            refresh_head(&daemon, &sessions, &head, &mut previous);
        }

        if now >= next_fallback_poll {
            for (head, watch) in &watches {
                if watch.watcher.is_none() {
                    refresh_head(&daemon, &sessions, head, &mut previous);
                }
            }
            next_fallback_poll = now + FALLBACK_POLL;
        }
    }
}

fn refresh_head(
    daemon: &Daemon,
    sessions: &[proto::SessionInfo],
    head: &Path,
    previous: &mut HashMap<u32, Option<proto::SessionCheckout>>,
) {
    for snapshot in sessions {
        let Some(checkout) = snapshot.checkout.as_ref() else {
            continue;
        };
        if head_path(Path::new(&checkout.root)).as_deref() != Some(head) {
            continue;
        }
        let mut current = snapshot.clone();
        daemon.session_checkout_metadata(&mut current);
        let checkout = current.checkout;
        let changed = previous.get(&snapshot.id) != Some(&checkout);
        if changed {
            previous.insert(snapshot.id, checkout.clone());
            daemon.broadcast_control(&proto::ServerMsg::SessionCheckout {
                id: snapshot.id,
                checkout,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{
        AccessKind, AccessMode, CreateKind, DataChange, EventKind, ModifyKind, RenameMode,
    };

    fn event(kind: EventKind, paths: &[&str]) -> notify::Event {
        let mut event = notify::Event::new(kind);
        event.paths = paths.iter().map(PathBuf::from).collect();
        event
    }

    #[test]
    fn head_filter_ignores_reads_and_other_files() {
        let head = Path::new("/repo/.git/HEAD");
        for kind in [
            EventKind::Access(AccessKind::Open(AccessMode::Any)),
            EventKind::Access(AccessKind::Read),
            EventKind::Access(AccessKind::Close(AccessMode::Read)),
        ] {
            assert!(!is_head_change(&event(kind, &["/repo/.git/HEAD"]), head));
        }
        let data = EventKind::Modify(ModifyKind::Data(DataChange::Any));
        assert!(!is_head_change(
            &event(data, &["/repo/.git/ORIG_HEAD"]),
            head
        ));
        assert!(!is_head_change(&event(data, &["/repo/.git/index"]), head));
    }

    #[test]
    fn head_filter_accepts_head_writes_and_renames() {
        let head = Path::new("/repo/.git/HEAD");
        let data = EventKind::Modify(ModifyKind::Data(DataChange::Any));
        assert!(is_head_change(&event(data, &["/repo/.git/HEAD"]), head));
        let rename = EventKind::Modify(ModifyKind::Name(RenameMode::Both));
        assert!(is_head_change(
            &event(rename, &["/repo/.git/HEAD.lock", "/repo/.git/HEAD"]),
            head
        ));
        let rename_to = EventKind::Modify(ModifyKind::Name(RenameMode::To));
        assert!(is_head_change(
            &event(rename_to, &["/repo/.git/HEAD"]),
            head
        ));
        let create = EventKind::Create(CreateKind::File);
        assert!(is_head_change(&event(create, &["/repo/.git/HEAD"]), head));
        assert!(is_head_change(&event(EventKind::Other, &[]), head));
    }
}
