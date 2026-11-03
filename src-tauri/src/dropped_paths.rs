use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// A dropped path stays readable for this long: enough for a multi-file drop to start its
/// reads, short enough that a path stops being a grant soon after the user let go of it.
const DROP_ALLOW_WINDOW: Duration = Duration::from_secs(60);

/// A file manager answers a clipboard URI request immediately; a hung owner must not keep an
/// attachment pending, so the wait ends and the path is refused.
const CLIPBOARD_URI_TIMEOUT: Duration = Duration::from_secs(2);

/// WebKit fetches a dropped drag's data within milliseconds; a drop mark older than this
/// belongs to a finished drag whose context address may already be reused.
const DROP_DATA_WAIT: Duration = Duration::from_secs(2);

/// Paths the host itself saw in a native drop's URI list. The renderer names a path to
/// `fs_read_dropped_path`, so the name alone is never the grant; this allowlist is.
#[derive(Default)]
pub struct DropAllowlist {
    entries: Mutex<HashMap<PathBuf, Instant>>,
    gate: Mutex<DropGate>,
}

/// WebKitGTK asks for a drag's data while the pointer only hovers, so data alone is not a
/// drop. Data waits here, keyed by its drag, until that same drag is dropped.
#[derive(Default)]
struct DropGate {
    pending: Option<(usize, Vec<PathBuf>)>,
    dropped: Option<(usize, Instant)>,
}

impl DropGate {
    /// Data arrived for `drag`; it becomes a grant only if `drag` was already dropped.
    fn data(&mut self, drag: usize, paths: Vec<PathBuf>, now: Instant) -> Option<Vec<PathBuf>> {
        if let Some((dropped, at)) = self.dropped.take() {
            if dropped == drag && now.saturating_duration_since(at) < DROP_DATA_WAIT {
                self.pending = None;
                return Some(paths);
            }
        }
        self.pending = Some((drag, paths));
        None
    }

    /// `drag` was dropped; its data, if it already arrived, becomes a grant.
    fn release(&mut self, drag: usize, now: Instant) -> Option<Vec<PathBuf>> {
        match self.pending.take() {
            Some((pending, paths)) if pending == drag => Some(paths),
            _ => {
                self.dropped = Some((drag, now));
                None
            }
        }
    }

    /// A drop that carries no file list ends the gate: nothing pending can be granted later.
    fn clear(&mut self) {
        self.pending = None;
        self.dropped = None;
    }
}

impl DropAllowlist {
    pub fn new() -> Self {
        Self::default()
    }

    fn entries(&self) -> std::sync::MutexGuard<'_, HashMap<PathBuf, Instant>> {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Records each path until `now + DROP_ALLOW_WINDOW`, dropping entries that already expired.
    pub fn record(&self, paths: impl IntoIterator<Item = PathBuf>, now: Instant) {
        let mut entries = self.entries();
        entries.retain(|_, expires| *expires > now);
        for path in paths {
            entries.insert(path, now + DROP_ALLOW_WINDOW);
        }
    }

    fn gate(&self) -> std::sync::MutexGuard<'_, DropGate> {
        self.gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// A drag's URI list arrived; it is recorded only once that drag is dropped.
    pub fn drag_data(&self, drag: usize, paths: Vec<PathBuf>, now: Instant) {
        let granted = self.gate().data(drag, paths, now);
        if let Some(paths) = granted {
            self.record(paths, now);
        }
    }

    /// The user released `drag` over the webview.
    pub fn drag_dropped(&self, drag: usize, now: Instant) {
        let granted = self.gate().release(drag, now);
        if let Some(paths) = granted {
            self.record(paths, now);
        }
    }

    /// A drag without a file list was dropped.
    pub fn drag_dropped_without_files(&self) {
        self.gate().clear();
    }

    pub fn allows(&self, path: &Path, now: Instant) -> bool {
        let mut entries = self.entries();
        entries.retain(|_, expires| *expires > now);
        entries.contains_key(path)
    }
}

/// Splits an RFC 2483 URI list (or GNOME's `copy`/`cut`-prefixed flavor) into local paths,
/// ignoring comments, blank lines and URIs that name no local file. Percent escapes are
/// decoded by `Url::to_file_path`.
pub fn parse_uri_list(data: &[u8]) -> Vec<PathBuf> {
    let Ok(text) = std::str::from_utf8(data) else {
        return Vec::new();
    };
    let mut paths = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let lower = line.to_ascii_lowercase();
        if lower == "copy" || lower == "cut" {
            continue;
        }
        let Ok(url) = url::Url::parse(line) else {
            continue;
        };
        if url.scheme() != "file" {
            continue;
        }
        if let Ok(path) = url.to_file_path() {
            paths.push(path);
        }
    }
    paths
}

/// Grants the read only when the path was recorded from a drop or sits on the clipboard now.
/// `on_clipboard` is passed in so the decision is testable without a display.
pub fn decide(
    path: &str,
    allowlist: &DropAllowlist,
    now: Instant,
    on_clipboard: bool,
) -> Result<(), String> {
    if allowlist.allows(Path::new(path), now) || on_clipboard {
        return Ok(());
    }
    Err(format!(
        "the path {path:?} was not dropped or copied in this session; drop the file from your \
         file manager or copy it, then try again"
    ))
}

/// Authorizes a renderer-named path: the drop allowlist first, then the system clipboard.
pub async fn authorize(
    path: &str,
    allowlist: &DropAllowlist,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    if allowlist.allows(Path::new(path), Instant::now()) {
        return Ok(());
    }
    let on_clipboard = clipboard_holds_now(path, app).await;
    decide(path, allowlist, Instant::now(), on_clipboard)
}

/// Records the local paths of a drop the webview receives, without stopping propagation so
/// WebKit still delivers the drop to the DOM. Data seen while a drag only hovers grants nothing.
pub fn observe_native_drops(
    window: &tauri::WebviewWindow,
    allowlist: std::sync::Arc<DropAllowlist>,
) -> tauri::Result<()> {
    use gtk::prelude::*;

    window.with_webview(move |webview| {
        use gtk::glib::translate::ToGlibPtr;

        let widget = webview.inner();
        let drag_id = |context: &gtk::gdk::DragContext| {
            let pointer: *mut gtk::gdk::ffi::GdkDragContext = context.to_glib_none().0;
            pointer as usize
        };
        let dropped = allowlist.clone();
        let _ = widget.connect_drag_drop(move |_, context, _, _, _| {
            let carries_files = context.list_targets().iter().any(|target| {
                *target == gtk::gdk::Atom::intern("text/uri-list")
                    || *target == gtk::gdk::Atom::intern("x-special/gnome-copied-files")
            });
            if context.drag_get_source_widget().is_none() && carries_files {
                dropped.drag_dropped(drag_id(context), Instant::now());
            } else {
                dropped.drag_dropped_without_files();
            }
            // `false` leaves the drop unhandled here, so WebKit still delivers it to the DOM.
            false
        });
        let _ = widget.connect_drag_data_received(move |_, context, _, _, data, _, _| {
            // A drag started inside this app can carry a page-chosen uri-list; only another
            // process's drag reports no source widget, so only that one is a real drop.
            if context.drag_get_source_widget().is_some() {
                return;
            }
            let kind = data.data_type();
            if kind != gtk::gdk::Atom::intern("text/uri-list")
                && kind != gtk::gdk::Atom::intern("x-special/gnome-copied-files")
            {
                return;
            }
            let paths = selection_uri_paths(data);
            if !paths.is_empty() {
                allowlist.drag_data(drag_id(context), paths, Instant::now());
            }
        });
    })
}

/// Reads a selection's URI list; GTK reports a missing target as a negative length, and the
/// data getter must not be called on it.
fn selection_uri_paths(data: &gtk::SelectionData) -> Vec<PathBuf> {
    if data.length() <= 0 {
        return Vec::new();
    }
    parse_uri_list(&data.data())
}

async fn clipboard_holds_now(path: &str, app: &tauri::AppHandle) -> bool {
    let target = PathBuf::from(path);
    let (tx, rx) = tokio::sync::oneshot::channel::<Vec<PathBuf>>();
    let scheduled = app.run_on_main_thread(move || {
        // A page in this webview can write a uri-list on copy, so a clipboard this process
        // owns proves nothing about the user; only another application's copy counts.
        if gtk::gdk::selection_owner_get(&gtk::gdk::SELECTION_CLIPBOARD).is_some() {
            let _ = tx.send(Vec::new());
            return;
        }
        let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
        let uri_list = gtk::gdk::Atom::intern("text/uri-list");
        let gnome_copied = gtk::gdk::Atom::intern("x-special/gnome-copied-files");
        clipboard.request_contents(&uri_list, move |clipboard, data| {
            let paths = selection_uri_paths(data);
            if !paths.is_empty() {
                let _ = tx.send(paths);
                return;
            }
            clipboard.request_contents(&gnome_copied, move |_, data| {
                let _ = tx.send(selection_uri_paths(data));
            });
        });
    });
    if scheduled.is_err() {
        return false;
    }
    match tokio::time::timeout(CLIPBOARD_URI_TIMEOUT, rx).await {
        Ok(Ok(paths)) => paths.iter().any(|candidate| candidate == &target),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recorded_at(paths: &[&str], now: Instant) -> DropAllowlist {
        let allowlist = DropAllowlist::new();
        allowlist.record(paths.iter().map(PathBuf::from), now);
        allowlist
    }

    #[test]
    fn data_seen_while_a_drag_only_hovers_grants_nothing() {
        let allowlist = DropAllowlist::new();
        let now = Instant::now();
        allowlist.drag_data(7, vec![PathBuf::from("/home/someone/.ssh/id_ed25519")], now);
        assert!(!allowlist.allows(Path::new("/home/someone/.ssh/id_ed25519"), now));
    }

    #[test]
    fn a_drag_is_granted_once_it_is_dropped_whatever_arrives_first() {
        let now = Instant::now();
        let data_first = DropAllowlist::new();
        data_first.drag_data(7, vec![PathBuf::from("/home/someone/a.txt")], now);
        data_first.drag_dropped(7, now);
        assert!(data_first.allows(Path::new("/home/someone/a.txt"), now));

        let drop_first = DropAllowlist::new();
        drop_first.drag_dropped(8, now);
        drop_first.drag_data(8, vec![PathBuf::from("/home/someone/b.txt")], now);
        assert!(drop_first.allows(Path::new("/home/someone/b.txt"), now));
    }

    #[test]
    fn a_stale_drop_mark_does_not_grant_a_later_drag_at_the_same_address() {
        let allowlist = DropAllowlist::new();
        let dropped_at = Instant::now();
        allowlist.drag_dropped(7, dropped_at);
        let later = dropped_at + DROP_DATA_WAIT;
        allowlist.drag_data(7, vec![PathBuf::from("/home/someone/hovered.txt")], later);
        assert!(!allowlist.allows(Path::new("/home/someone/hovered.txt"), later));
    }

    #[test]
    fn a_drop_without_files_clears_pending_data() {
        let allowlist = DropAllowlist::new();
        let now = Instant::now();
        allowlist.drag_data(7, vec![PathBuf::from("/home/someone/hovered.txt")], now);
        allowlist.drag_dropped_without_files();
        allowlist.drag_dropped(7, now);
        assert!(!allowlist.allows(Path::new("/home/someone/hovered.txt"), now));
    }

    #[test]
    fn dropping_one_drag_does_not_grant_another_drags_data() {
        let allowlist = DropAllowlist::new();
        let now = Instant::now();
        allowlist.drag_data(7, vec![PathBuf::from("/home/someone/hovered.txt")], now);
        allowlist.drag_dropped(9, now);
        assert!(!allowlist.allows(Path::new("/home/someone/hovered.txt"), now));
    }

    #[test]
    fn a_recorded_path_is_allowed_inside_the_window() {
        let now = Instant::now();
        let allowlist = recorded_at(&["/home/someone/notes.md"], now);
        assert!(allowlist.allows(Path::new("/home/someone/notes.md"), now));
        assert!(allowlist.allows(
            Path::new("/home/someone/notes.md"),
            now + DROP_ALLOW_WINDOW - Duration::from_millis(1)
        ));
    }

    #[test]
    fn a_path_that_was_never_dropped_is_refused_and_named() {
        let allowlist = DropAllowlist::new();
        let error = decide(
            "/home/someone/.ssh/id_ed25519",
            &allowlist,
            Instant::now(),
            false,
        )
        .expect_err("an unrecorded path has no grant");
        assert!(error.contains("/home/someone/.ssh/id_ed25519"), "{error}");
        assert!(error.contains("not dropped or copied"), "{error}");
    }

    #[test]
    fn a_recorded_path_expires() {
        let now = Instant::now();
        let allowlist = recorded_at(&["/home/someone/notes.md"], now);
        let later = now + DROP_ALLOW_WINDOW;
        assert!(!allowlist.allows(Path::new("/home/someone/notes.md"), later));
        assert!(decide("/home/someone/notes.md", &allowlist, later, false).is_err());
    }

    #[test]
    fn a_path_on_the_clipboard_is_allowed_without_a_drop() {
        let allowlist = DropAllowlist::new();
        assert!(decide("/home/someone/notes.md", &allowlist, Instant::now(), true).is_ok());
    }

    #[test]
    fn a_recorded_path_matches_its_trailing_separator_form() {
        let now = Instant::now();
        let allowlist = recorded_at(&["/home/someone/photos/"], now);
        assert!(allowlist.allows(Path::new("/home/someone/photos"), now));
    }

    #[test]
    fn a_uri_list_decodes_percent_escapes_and_keeps_local_paths() {
        let paths = parse_uri_list(
            b"# copied from a file manager\r\nfile:///tmp/my%20shot.png\r\nfile:///tmp/b.txt\r\n",
        );
        assert_eq!(
            paths,
            vec![
                PathBuf::from("/tmp/my shot.png"),
                PathBuf::from("/tmp/b.txt")
            ]
        );
    }

    #[test]
    fn a_uri_list_ignores_non_file_uris_and_garbage() {
        let paths = parse_uri_list(
            b"copy\r\nhttps://example.com/a\r\nnot a uri\r\nfile://%\r\nfile:///tmp/ok.txt\r\n",
        );
        assert_eq!(paths, vec![PathBuf::from("/tmp/ok.txt")]);
    }

    #[test]
    fn a_gnome_copied_files_list_skips_its_action_line() {
        let paths = parse_uri_list(b"cut\nfile:///tmp/a.txt\nfile:///tmp/b.txt");
        assert_eq!(
            paths,
            vec![PathBuf::from("/tmp/a.txt"), PathBuf::from("/tmp/b.txt")]
        );
    }

    #[test]
    fn a_non_utf8_uri_list_yields_nothing() {
        assert!(parse_uri_list(&[0xff, 0xfe, b'\n']).is_empty());
    }
}
