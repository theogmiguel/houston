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

pub async fn checkout_watch_loop(daemon: Arc<Daemon>) {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<PathBuf>();
    let mut watches: HashMap<PathBuf, HeadWatch> = HashMap::new();
    let mut previous: HashMap<u32, Option<proto::SessionCheckout>> = HashMap::new();
    let mut pending: HashMap<PathBuf, Instant> = HashMap::new();
    let mut warned_overflow = HashSet::new();
    let mut next_fallback_poll = Instant::now() + FALLBACK_POLL;
    let mut ticker = tokio::time::interval(Duration::from_secs(1));

    loop {
        tokio::select! {
            Some(head) = rx.recv() => { pending.insert(head, Instant::now() + DEBOUNCE); }
            _ = ticker.tick() => {}
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
                let callback_tx = tx.clone();
                let event_head = head.clone();
                match notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                    match event {
                        Ok(_) => {
                            let _ = callback_tx.send(event_head.clone());
                        }
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
