use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::State;

use crate::fs_allowlist::{
    assert_entry_within_allowed_roots, assert_within_allowed_roots, register_allowed_root,
    AllowedRoots,
};

// Every command re-runs the allowlist check rather than gating once at the
// picker: each check is a resolve-then-syscall pair with a TOCTOU window, and
// Houston hosts agent processes that can race it, so nothing here is atomic.

// Keeps the editor pane responsive; larger files go through the terminal instead.
const EDIT_MAX_BYTES: u64 = 2 * 1024 * 1024;

const IGNORED_ENTRY_NAMES: &[&str] = &[
    "node_modules",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".astro",
    ".output",
    ".turbo",
    ".cache",
    ".parcel-cache",
    "target",
    "__pycache__",
    ".venv",
    ".virtualenv",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".tox",
    ".gradle",
    ".git",
    ".DS_Store",
    "Thumbs.db",
    ".vscode",
    ".idea",
];

fn is_ignored_entry(name: &str) -> bool {
    IGNORED_ENTRY_NAMES.contains(&name)
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub dir: bool,
    pub ignored: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatResult {
    pub mtime_ms: f64,
}

async fn list_dir_entries(real: &Path) -> Result<Vec<DirEntry>, String> {
    let mut read_dir = tokio::fs::read_dir(real)
        .await
        .map_err(|e| format!("cannot read directory {path}: {e}", path = real.display()))?;
    let mut out = Vec::new();
    while let Some(entry) = read_dir.next_entry().await.map_err(|e| {
        format!(
            "cannot read next directory entry under {path}: {e}",
            path = real.display()
        )
    })? {
        let name = entry.file_name().to_string_lossy().into_owned();
        let file_type = entry.file_type().await.map_err(|e| {
            format!(
                "cannot stat directory entry {path}: {e}",
                path = entry.path().display()
            )
        })?;
        out.push(DirEntry {
            name: name.clone(),
            path: entry.path().to_string_lossy().into_owned(),
            dir: file_type.is_dir(),
            ignored: is_ignored_entry(&name),
        });
    }
    out.sort_by(|a, b| match (a.dir, b.dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });
    Ok(out)
}

#[tauri::command]
pub async fn fs_read_directory(
    dir_path: String,
    state: State<'_, AllowedRoots>,
) -> Result<Vec<DirEntry>, String> {
    let roots = {
        let guard = state
            .0
            .lock()
            .map_err(|_| "allowed-roots lock poisoned".to_string())?;
        guard.clone()
    };
    let real = assert_within_allowed_roots(&dir_path, &roots).await?;
    list_dir_entries(&real).await
}

// Deliberately not allowlist-gated: it only lists directory names for a
// picker dialog, before the user has chosen a root to grant. Do not gate it.
#[tauri::command]
pub async fn fs_picker_list_dirs(path: String) -> Result<Option<Vec<String>>, String> {
    let p = PathBuf::from(&path);
    let is_dir = match tokio::fs::metadata(&p).await {
        Ok(meta) => meta.is_dir(),
        Err(_) => return Ok(None),
    };
    if !is_dir {
        return Ok(None);
    }
    let mut read_dir = match tokio::fs::read_dir(&p).await {
        Ok(rd) => rd,
        Err(_) => return Ok(None),
    };
    let mut names = Vec::new();
    loop {
        let entry = match read_dir.next_entry().await {
            Ok(Some(e)) => e,
            Ok(None) => break,
            Err(_) => return Ok(None),
        };
        let file_type = match entry.file_type().await {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue;
        }
        names.push(name);
    }
    names.sort();
    Ok(Some(names))
}

#[tauri::command]
pub async fn fs_read_file(
    file_path: String,
    state: State<'_, AllowedRoots>,
) -> Result<String, String> {
    let roots = {
        let guard = state
            .0
            .lock()
            .map_err(|_| "allowed-roots lock poisoned".to_string())?;
        guard.clone()
    };
    let real = assert_within_allowed_roots(&file_path, &roots).await?;
    let metadata = tokio::fs::metadata(&real)
        .await
        .map_err(|e| format!("cannot stat file {path}: {e}", path = real.display()))?;
    if metadata.len() > EDIT_MAX_BYTES {
        return Err(format!(
            "file too large to edit: {path} is {size} bytes (max {max})",
            path = file_path,
            size = metadata.len(),
            max = EDIT_MAX_BYTES
        ));
    }
    let bytes = tokio::fs::read(&real)
        .await
        .map_err(|e| format!("cannot read file {path}: {e}", path = real.display()))?;
    if bytes.iter().take(8192).any(|b| *b == 0) {
        return Err(format!("refusing to open binary file: {file_path}"));
    }
    String::from_utf8(bytes)
        .map_err(|e| format!("file {path} is not valid UTF-8 text: {e}", path = file_path))
}

const MEDIA_MAX_BYTES: u64 = 16 * 1024 * 1024;

const MEDIA_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "tiff", "mp4", "webm", "mov", "avi", "mkv",
    "m4v", "mp3", "wav", "ogg", "flac", "m4a", "aac",
];

#[tauri::command]
pub async fn fs_read_media(
    file_path: String,
    state: State<'_, AllowedRoots>,
) -> Result<tauri::ipc::Response, String> {
    let roots = {
        let guard = state
            .0
            .lock()
            .map_err(|_| "allowed-roots lock poisoned".to_string())?;
        guard.clone()
    };
    let real = assert_within_allowed_roots(&file_path, &roots).await?;
    let ext = ext_of(&real);
    if !MEDIA_EXTS.contains(&ext.as_str()) {
        return Err(format!(
            "not a previewable media file: {path} resolves to {real} with extension {ext:?} \
             (expected one of: {expected})",
            path = file_path,
            real = real.display(),
            ext = ext,
            expected = MEDIA_EXTS.join(", ")
        ));
    }
    let bytes = read_media_bytes(&real, &file_path, MEDIA_MAX_BYTES).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

async fn read_media_bytes(real: &Path, file_path: &str, max: u64) -> Result<Vec<u8>, String> {
    let metadata = tokio::fs::metadata(real)
        .await
        .map_err(|e| format!("cannot stat file {path}: {e}", path = real.display()))?;
    if !metadata.is_file() {
        return Err(format!(
            "not a regular file: {path} is a {kind} (only regular files can be previewed)",
            path = file_path,
            kind = describe_file_type(&metadata)
        ));
    }
    if metadata.len() > max {
        return Err(format!(
            "file too large to preview: {path} is {size} bytes (max {max})",
            path = file_path,
            size = metadata.len(),
            max = max
        ));
    }
    tokio::fs::read(real)
        .await
        .map_err(|e| format!("cannot read file {path}: {e}", path = real.display()))
}

fn ext_of(path: &Path) -> String {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    match name.rfind('.') {
        Some(dot) => name[dot + 1..].to_ascii_lowercase(),
        None => String::new(),
    }
}

fn describe_file_type(metadata: &std::fs::Metadata) -> &'static str {
    let ft = metadata.file_type();
    if ft.is_dir() {
        "directory"
    } else if ft.is_symlink() {
        "symlink"
    } else {
        #[cfg(unix)]
        #[cfg(unix)]
        {
            use std::os::unix::fs::FileTypeExt;
            if ft.is_fifo() {
                "FIFO/named pipe"
            } else if ft.is_socket() {
                "socket"
            } else if ft.is_char_device() {
                "character device"
            } else if ft.is_block_device() {
                "block device"
            } else {
                "non-regular file"
            }
        }
        #[cfg(not(unix))]
        {
            "non-regular file"
        }
    }
}

#[tauri::command]
pub async fn fs_write_file(
    file_path: String,
    content: String,
    state: State<'_, AllowedRoots>,
) -> Result<(), String> {
    let roots = {
        let guard = state
            .0
            .lock()
            .map_err(|_| "allowed-roots lock poisoned".to_string())?;
        guard.clone()
    };
    let real = assert_within_allowed_roots(&file_path, &roots).await?;
    tokio::fs::write(&real, content)
        .await
        .map_err(|e| format!("cannot write file {path}: {e}", path = real.display()))
}

#[tauri::command]
pub async fn fs_stat(
    target_path: String,
    state: State<'_, AllowedRoots>,
) -> Result<Option<StatResult>, String> {
    let roots = {
        let guard = state
            .0
            .lock()
            .map_err(|_| "allowed-roots lock poisoned".to_string())?;
        guard.clone()
    };
    let real = assert_within_allowed_roots(&target_path, &roots).await?;
    match tokio::fs::metadata(&real).await {
        Ok(metadata) => {
            let mtime_ms = metadata
                .modified()
                .ok()
                .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs_f64() * 1000.0)
                .unwrap_or(0.0);
            Ok(Some(StatResult { mtime_ms }))
        }
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub async fn fs_exists(
    target_path: String,
    state: State<'_, AllowedRoots>,
) -> Result<Option<String>, String> {
    let roots = {
        let guard = state
            .0
            .lock()
            .map_err(|_| "allowed-roots lock poisoned".to_string())?;
        guard.clone()
    };
    let real = match assert_within_allowed_roots(&target_path, &roots).await {
        Ok(real) => real,
        Err(_) => return Ok(None),
    };
    match tokio::fs::metadata(&real).await {
        Ok(metadata) => Ok(Some(
            if metadata.is_dir() { "dir" } else { "file" }.to_string(),
        )),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub async fn fs_delete(target_path: String, state: State<'_, AllowedRoots>) -> Result<(), String> {
    let roots = {
        let guard = state
            .0
            .lock()
            .map_err(|_| "allowed-roots lock poisoned".to_string())?;
        guard.clone()
    };
    let real = assert_entry_within_allowed_roots(&target_path, &roots).await?;
    trash_entry(real, &target_path).await
}

async fn trash_entry(real: PathBuf, target_path: &str) -> Result<(), String> {
    tokio::fs::symlink_metadata(&real).await.map_err(|e| {
        format!(
            "cannot delete {path}: {e} (expected an existing file, directory or symlink at {real})",
            path = target_path,
            real = real.display()
        )
    })?;
    let for_error = real.clone();
    tokio::task::spawn_blocking(move || trash::delete(&real))
        .await
        .map_err(|e| format!("the trash operation could not be run for {target_path}: {e}"))?
        .map_err(|e| {
            format!(
                "cannot move {path} to the trash: {e} \
                 (the trash operation failed; Houston did not delete anything itself — check {real})",
                path = target_path,
                real = for_error.display()
            )
        })
}

#[tauri::command]
pub async fn fs_create_file(
    file_path: String,
    state: State<'_, AllowedRoots>,
) -> Result<(), String> {
    let roots = {
        let guard = state
            .0
            .lock()
            .map_err(|_| "allowed-roots lock poisoned".to_string())?;
        guard.clone()
    };
    let real = assert_entry_within_allowed_roots(&file_path, &roots).await?;
    tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&real)
        .await
        .map(|_| ())
        .map_err(|e| {
            format!(
                "cannot create file {path}: {e} (expected a name that does not exist yet, \
                 in an existing directory; resolved to {real})",
                path = file_path,
                real = real.display()
            )
        })
}

#[tauri::command]
pub async fn fs_create_directory(
    dir_path: String,
    state: State<'_, AllowedRoots>,
) -> Result<(), String> {
    let roots = {
        let guard = state
            .0
            .lock()
            .map_err(|_| "allowed-roots lock poisoned".to_string())?;
        guard.clone()
    };
    let real = assert_entry_within_allowed_roots(&dir_path, &roots).await?;
    tokio::fs::create_dir(&real).await.map_err(|e| {
        format!(
            "cannot create directory {path}: {e} (expected a name that does not exist yet, \
             in an existing directory; resolved to {real})",
            path = dir_path,
            real = real.display()
        )
    })
}

#[tauri::command]
pub async fn fs_rename(
    from_path: String,
    to_path: String,
    state: State<'_, AllowedRoots>,
) -> Result<(), String> {
    let roots = {
        let guard = state
            .0
            .lock()
            .map_err(|_| "allowed-roots lock poisoned".to_string())?;
        guard.clone()
    };
    let from_real = assert_entry_within_allowed_roots(&from_path, &roots).await?;
    let to_real = assert_entry_within_allowed_roots(&to_path, &roots).await?;
    if tokio::fs::symlink_metadata(&to_real).await.is_ok() {
        return Err(format!(
            "cannot rename {from} to {to}: something already exists there \
             (expected a name that is free; resolved to {real})",
            from = from_path,
            to = to_path,
            real = to_real.display()
        ));
    }
    tokio::fs::rename(&from_real, &to_real).await.map_err(|e| {
        format!(
            "cannot rename {from} to {to}: {e} (resolved to {from_real} -> {to_real})",
            from = from_path,
            to = to_path,
            from_real = from_real.display(),
            to_real = to_real.display()
        )
    })
}

const ENTRY_COUNT_CAP: u64 = 10_000;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EntryCount {
    pub count: u64,
    pub capped: bool,
    pub cap: u64,
}

#[tauri::command]
pub async fn fs_entry_count(
    target_path: String,
    state: State<'_, AllowedRoots>,
) -> Result<EntryCount, String> {
    let roots = {
        let guard = state
            .0
            .lock()
            .map_err(|_| "allowed-roots lock poisoned".to_string())?;
        guard.clone()
    };
    let real = assert_entry_within_allowed_roots(&target_path, &roots).await?;
    count_entries_under(&real, ENTRY_COUNT_CAP).await
}

async fn count_entries_under(real: &Path, cap: u64) -> Result<EntryCount, String> {
    let is_real_dir = tokio::fs::symlink_metadata(real)
        .await
        .map(|m| m.is_dir())
        .unwrap_or(false);
    if !is_real_dir {
        return Ok(EntryCount {
            count: 0,
            capped: false,
            cap,
        });
    }
    let mut count = 0u64;
    let mut stack = vec![real.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let mut read_dir = match tokio::fs::read_dir(&dir).await {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        while let Some(entry) = read_dir.next_entry().await.map_err(|e| {
            format!(
                "cannot read next directory entry under {path}: {e}",
                path = dir.display()
            )
        })? {
            count += 1;
            if count > cap {
                return Ok(EntryCount {
                    count: cap,
                    capped: true,
                    cap,
                });
            }
            if entry
                .file_type()
                .await
                .map(|ft| ft.is_dir())
                .unwrap_or(false)
            {
                stack.push(entry.path());
            }
        }
    }
    Ok(EntryCount {
        count,
        capped: false,
        cap,
    })
}

fn save_path_for(state_dir: &Path, dir_name: &str, ext: &str, millis: u128) -> PathBuf {
    let dir = state_dir.join(dir_name);
    let safe_ext = sanitize_ext(ext);
    dir.join(format!("{millis}.{safe_ext}"))
}

async fn save_bytes_under_base(
    state_dir: &Path,
    dir_name: &str,
    ext: &str,
    bytes: &[u8],
) -> Result<String, String> {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let file = save_path_for(state_dir, dir_name, ext, millis);
    let dir = file
        .parent()
        .expect("save_path_for always joins dir_name onto state_dir")
        .to_path_buf();
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("cannot create directory {path}: {e}", path = dir.display()))?;
    set_dir_mode_0700(&dir).await?;
    tokio::fs::write(&file, bytes)
        .await
        .map_err(|e| format!("cannot write file {path}: {e}", path = file.display()))?;
    set_file_mode_0600(&file).await?;
    Ok(file.to_string_lossy().into_owned())
}

const MAX_CAPTURE_BYTES: u64 = 32 * 1024 * 1024;

fn capture_path_within(state_dir: &Path, dir_name: &str, path: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(path);
    let base = state_dir.join(dir_name);
    let rest = candidate.strip_prefix(&base).map_err(|_| {
        format!(
            "fs_read_capture: {path:?} is not inside {base}; this command reads only files \
             directly under that directory",
            base = base.display()
        )
    })?;
    let mut parts = rest.components();
    let (Some(std::path::Component::Normal(name)), None) = (parts.next(), parts.next()) else {
        return Err(format!(
            "fs_read_capture: {path:?} must name a single file directly inside {base} \
             (no subdirectories, no \"..\"); got {rest:?}",
            base = base.display()
        ));
    };
    if Path::new(name).extension().and_then(|e| e.to_str()) != Some("png") {
        return Err(format!(
            "fs_read_capture: {path:?} must be a .png (captures are PNG); got {name:?}"
        ));
    }
    Ok(base.join(name))
}

#[tauri::command]
pub async fn fs_read_capture(path: String) -> Result<String, String> {
    let state_dir = houston_core::paths::config_dir()
        .map_err(|e| format!("cannot resolve state directory: {e}"))?;
    read_capture_under(&state_dir, &path).await
}

async fn read_capture_under(state_dir: &Path, path: &str) -> Result<String, String> {
    use base64::Engine;

    let file = capture_path_within(state_dir, "pastes", path)?;

    let meta = tokio::fs::symlink_metadata(&file).await.map_err(|e| {
        format!(
            "fs_read_capture: cannot stat {file}: {e}",
            file = file.display()
        )
    })?;
    if meta.file_type().is_symlink() {
        return Err(format!(
            "fs_read_capture: {file} is a symlink; captures are read only as regular files, so \
             the pastes/ restriction cannot be pointed somewhere else",
            file = file.display()
        ));
    }
    if !meta.is_file() {
        return Err(format!(
            "fs_read_capture: {file} is not a regular file (it is {kind:?})",
            file = file.display(),
            kind = meta.file_type()
        ));
    }
    if meta.len() > MAX_CAPTURE_BYTES {
        return Err(format!(
            "fs_read_capture: {file} is {len} bytes, over the {MAX_CAPTURE_BYTES}-byte capture \
             read limit; it was not read",
            file = file.display(),
            len = meta.len()
        ));
    }

    use tokio::io::AsyncReadExt;
    let handle = tokio::fs::File::open(&file).await.map_err(|e| {
        format!(
            "fs_read_capture: cannot open {file}: {e}",
            file = file.display()
        )
    })?;
    let mut bytes = Vec::new();
    handle
        .take(MAX_CAPTURE_BYTES + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|e| {
            format!(
                "fs_read_capture: cannot read {file}: {e}",
                file = file.display()
            )
        })?;
    if bytes.len() as u64 > MAX_CAPTURE_BYTES {
        return Err(format!(
            "fs_read_capture: {file} grew past the {MAX_CAPTURE_BYTES}-byte capture read limit \
             while being read; it was discarded",
            file = file.display()
        ));
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

pub(crate) async fn save_bytes_under(
    dir_name: &str,
    ext: &str,
    bytes: &[u8],
) -> Result<String, String> {
    let state_dir = houston_core::paths::config_dir()
        .map_err(|e| format!("cannot resolve state directory: {e}"))?;
    save_bytes_under_base(&state_dir, dir_name, ext, bytes).await
}

#[tauri::command]
pub async fn fs_save_image(ext: String, bytes: Vec<u8>) -> Result<String, String> {
    save_bytes_under("pastes", &ext, &bytes).await
}

#[tauri::command]
pub async fn fs_save_review(text: String) -> Result<String, String> {
    save_bytes_under("reviews", "diff", text.as_bytes()).await
}

const WINDOW_BACKGROUND_DIR: &str = "background";
const WINDOW_BACKGROUND_STEM: &str = "window-background";
const WINDOW_BACKGROUND_PREVIOUS_STEM: &str = "window-background-previous";

const WINDOW_BACKGROUND_MAX_BYTES: u64 = 32 * 1024 * 1024;

const WINDOW_BACKGROUND_EXTS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif"];

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WindowBackgroundInfo {
    pub filename: String,
    pub size: u64,
    pub ext: String,
}

fn window_background_file(state_dir: &Path, ext: &str) -> PathBuf {
    state_dir
        .join(WINDOW_BACKGROUND_DIR)
        .join(format!("{WINDOW_BACKGROUND_STEM}.{ext}"))
}

async fn remove_other_ext_slots(dir: &Path, keep_ext: &str) -> Result<(), String> {
    let mut read_dir = match tokio::fs::read_dir(dir).await {
        Ok(rd) => rd,
        Err(_) => return Ok(()),
    };
    while let Some(entry) = read_dir
        .next_entry()
        .await
        .map_err(|e| format!("cannot read directory {path}: {e}", path = dir.display()))?
    {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(rest) = name.strip_prefix(&format!("{WINDOW_BACKGROUND_STEM}.")) else {
            continue;
        };
        if rest != keep_ext {
            tokio::fs::remove_file(entry.path()).await.map_err(|e| {
                format!(
                    "cannot remove stale slot {path}: {e}",
                    path = entry.path().display()
                )
            })?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn fs_set_window_background(path: String) -> Result<String, String> {
    let state_dir = houston_core::paths::config_dir()
        .map_err(|e| format!("cannot resolve state directory: {e}"))?;
    set_window_background_under(&state_dir, &path).await
}

async fn set_window_background_under(state_dir: &Path, path: &str) -> Result<String, String> {
    let ext = ext_of(Path::new(path));
    if !WINDOW_BACKGROUND_EXTS.contains(&ext.as_str()) {
        return Err(format!(
            "not an accepted background image: {path} has extension {ext:?} \
             (expected one of: {expected})",
            expected = WINDOW_BACKGROUND_EXTS.join(", ")
        ));
    }
    let meta = tokio::fs::metadata(path)
        .await
        .map_err(|e| format!("cannot stat {path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!(
            "not a regular file: {path} is a {kind}; nothing was written",
            kind = describe_file_type(&meta)
        ));
    }
    if meta.len() > WINDOW_BACKGROUND_MAX_BYTES {
        return Err(format!(
            "window background too large: {path} is {size} bytes (max {max}); \
             nothing was written — your existing background is untouched",
            size = meta.len(),
            max = WINDOW_BACKGROUND_MAX_BYTES
        ));
    }
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|e| format!("cannot read {path}: {e}"))?;

    let dir = state_dir.join(WINDOW_BACKGROUND_DIR);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("cannot create directory {path}: {e}", path = dir.display()))?;
    set_dir_mode_0700(&dir).await?;
    let parked = park_current_window_background(state_dir).await?;
    let file = window_background_file(state_dir, &ext);
    if let Err(e) = tokio::fs::write(&file, &bytes).await {
        let _ = tokio::fs::remove_file(&file).await;
        if let Some(parked) = parked {
            unpark_window_background(state_dir, &parked).await?;
        }
        return Err(format!(
            "cannot write file {path}: {e}",
            path = file.display()
        ));
    }
    set_file_mode_0600(&file).await?;
    remove_other_ext_slots(&dir, &ext).await?;
    Ok(file.to_string_lossy().into_owned())
}

async fn park_current_window_background(state_dir: &Path) -> Result<Option<PathBuf>, String> {
    if let Some(stale) = find_previous_window_background(state_dir).await? {
        tokio::fs::remove_file(&stale).await.map_err(|e| {
            format!(
                "cannot remove parked background {path}: {e}",
                path = stale.display()
            )
        })?;
    }
    let Some(current) = find_window_background_slot(state_dir).await? else {
        return Ok(None);
    };
    let parked = state_dir.join(WINDOW_BACKGROUND_DIR).join(format!(
        "{WINDOW_BACKGROUND_PREVIOUS_STEM}.{}",
        ext_of(&current)
    ));
    tokio::fs::rename(&current, &parked).await.map_err(|e| {
        format!(
            "cannot park background {from} as {to}: {e}",
            from = current.display(),
            to = parked.display()
        )
    })?;
    Ok(Some(parked))
}

async fn unpark_window_background(state_dir: &Path, parked: &Path) -> Result<(), String> {
    if let Some(current) = find_window_background_slot(state_dir).await? {
        tokio::fs::remove_file(&current).await.map_err(|e| {
            format!(
                "cannot remove refused background {path}: {e}",
                path = current.display()
            )
        })?;
    }
    let restored = window_background_file(state_dir, &ext_of(parked));
    tokio::fs::rename(parked, &restored).await.map_err(|e| {
        format!(
            "cannot restore background {from} as {to}: {e}",
            from = parked.display(),
            to = restored.display()
        )
    })
}

#[tauri::command]
pub async fn fs_settle_window_background(keep: String) -> Result<bool, String> {
    let state_dir = houston_core::paths::config_dir()
        .map_err(|e| format!("cannot resolve state directory: {e}"))?;
    settle_window_background_under(&state_dir, &keep).await
}

async fn settle_window_background_under(state_dir: &Path, keep: &str) -> Result<bool, String> {
    match keep {
        "new" => {
            if let Some(parked) = find_previous_window_background(state_dir).await? {
                tokio::fs::remove_file(&parked).await.map_err(|e| {
                    format!(
                        "cannot remove parked background {path}: {e}",
                        path = parked.display()
                    )
                })?;
            }
        }
        "previous" => {
            if let Some(parked) = find_previous_window_background(state_dir).await? {
                unpark_window_background(state_dir, &parked).await?;
            }
        }
        other => {
            return Err(format!(
            "cannot settle window background: keep is {other:?}, expected \"new\" or \"previous\""
        ))
        }
    }
    Ok(find_window_background_slot(state_dir).await?.is_some())
}

async fn find_window_background_slot(state_dir: &Path) -> Result<Option<PathBuf>, String> {
    find_slot_with_stem(state_dir, WINDOW_BACKGROUND_STEM).await
}

async fn find_previous_window_background(state_dir: &Path) -> Result<Option<PathBuf>, String> {
    find_slot_with_stem(state_dir, WINDOW_BACKGROUND_PREVIOUS_STEM).await
}

async fn find_slot_with_stem(state_dir: &Path, stem: &str) -> Result<Option<PathBuf>, String> {
    let dir = state_dir.join(WINDOW_BACKGROUND_DIR);
    let mut read_dir = match tokio::fs::read_dir(&dir).await {
        Ok(rd) => rd,
        Err(_) => return Ok(None),
    };
    let mut found = None;
    while let Some(entry) = read_dir.next_entry().await.map_err(|e| {
        format!(
            "cannot read background directory {path}: {e}",
            path = dir.display()
        )
    })? {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name.starts_with(&format!("{stem}.")) {
            if found.is_some() {
                return Err(format!(
                    "{stem} slot is ambiguous: multiple files under {dir}; remove one",
                    dir = dir.display()
                ));
            }
            found = Some(entry.path());
        }
    }
    Ok(found)
}

async fn read_window_background_bytes(file: &Path) -> Result<Vec<u8>, String> {
    let meta = tokio::fs::symlink_metadata(file)
        .await
        .map_err(|e| format!("cannot stat {path}: {e}", path = file.display()))?;
    if meta.file_type().is_symlink() {
        return Err(format!(
            "window background {file} is a symlink; backgrounds are read only as regular \
             files, so the slot cannot be pointed somewhere else",
            file = file.display()
        ));
    }
    if !meta.is_file() {
        return Err(format!(
            "window background {file} is not a regular file (it is {kind:?})",
            file = file.display(),
            kind = meta.file_type()
        ));
    }
    if meta.len() > WINDOW_BACKGROUND_MAX_BYTES {
        return Err(format!(
            "window background {file} is {len} bytes, over the {WINDOW_BACKGROUND_MAX_BYTES}-byte \
             limit; it was not read",
            file = file.display(),
            len = meta.len()
        ));
    }
    tokio::fs::read(file)
        .await
        .map_err(|e| format!("cannot read {path}: {e}", path = file.display()))
}

#[tauri::command]
pub async fn fs_read_window_background() -> Result<tauri::ipc::Response, String> {
    let state_dir = houston_core::paths::config_dir()
        .map_err(|e| format!("cannot resolve state directory: {e}"))?;
    let file = find_window_background_slot(&state_dir)
        .await?
        .ok_or_else(|| {
            "no window background is set; set one with fs_set_window_background".to_string()
        })?;
    let bytes = read_window_background_bytes(&file).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn fs_window_background_info() -> Result<Option<WindowBackgroundInfo>, String> {
    let state_dir = houston_core::paths::config_dir()
        .map_err(|e| format!("cannot resolve state directory: {e}"))?;
    window_background_info_under(&state_dir).await
}

async fn window_background_info_under(
    state_dir: &Path,
) -> Result<Option<WindowBackgroundInfo>, String> {
    let Some(file) = find_window_background_slot(state_dir).await? else {
        return Ok(None);
    };
    let meta = match tokio::fs::symlink_metadata(&file).await {
        Ok(m) => m,
        Err(_) => return Ok(None),
    };
    if !meta.is_file() {
        return Ok(None);
    }
    let filename = file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = ext_of(&file);
    Ok(Some(WindowBackgroundInfo {
        filename,
        size: meta.len(),
        ext,
    }))
}

#[tauri::command]
pub async fn fs_remove_window_background() -> Result<(), String> {
    let state_dir = houston_core::paths::config_dir()
        .map_err(|e| format!("cannot resolve state directory: {e}"))?;
    remove_window_background_under(&state_dir).await
}

async fn remove_window_background_under(state_dir: &Path) -> Result<(), String> {
    for file in [
        find_window_background_slot(state_dir).await?,
        find_previous_window_background(state_dir).await?,
    ]
    .into_iter()
    .flatten()
    {
        tokio::fs::remove_file(&file).await.map_err(|e| {
            format!(
                "cannot remove window background {path}: {e}",
                path = file.display()
            )
        })?;
    }
    Ok(())
}

fn sanitize_ext(ext: &str) -> String {
    let cleaned: String = ext
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(5)
        .collect();
    if cleaned.is_empty() {
        "png".to_string()
    } else {
        cleaned
    }
}

const DROPPED_FILES_DIR: &str = "dropped-files";

fn sanitize_dropped_file_name(name: &str) -> String {
    const MAX_NAME_BYTES: usize = 100;
    let candidate = Path::new(name)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut truncated = String::new();
    for c in candidate.chars() {
        if truncated.len() + c.len_utf8() > MAX_NAME_BYTES {
            break;
        }
        truncated.push(c);
    }
    if truncated.is_empty() || truncated == "." || truncated == ".." {
        "dropped-file".to_string()
    } else {
        truncated
    }
}

async fn copy_dropped_file_under_base(
    state_dir: &Path,
    name: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    let safe_name = sanitize_dropped_file_name(name);
    let sub_dir = state_dir
        .join(DROPPED_FILES_DIR)
        .join(uuid::Uuid::new_v4().to_string());
    tokio::fs::create_dir_all(&sub_dir).await.map_err(|e| {
        format!(
            "cannot create directory {path}: {e}",
            path = sub_dir.display()
        )
    })?;
    set_dir_mode_0700(&sub_dir).await?;
    let file = sub_dir.join(&safe_name);
    tokio::fs::write(&file, bytes)
        .await
        .map_err(|e| format!("cannot write file {path}: {e}", path = file.display()))?;
    set_file_mode_0600(&file).await?;
    Ok(file)
}

#[tauri::command]
pub async fn fs_copy_dropped_file(
    name: String,
    bytes: Vec<u8>,
    state: State<'_, AllowedRoots>,
) -> Result<String, String> {
    let state_dir = houston_core::paths::config_dir()
        .map_err(|e| format!("cannot resolve state directory: {e}"))?;
    let file = copy_dropped_file_under_base(&state_dir, &name, &bytes).await?;
    register_allowed_root(&file.to_string_lossy(), state.inner()).await?;
    Ok(file.to_string_lossy().into_owned())
}

#[cfg(unix)]
#[cfg(unix)]
async fn set_dir_mode_0700(dir: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    tokio::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
        .await
        .map_err(|e| {
            format!(
                "cannot set permissions on {path}: {e}",
                path = dir.display()
            )
        })
}

#[cfg(unix)]
#[cfg(unix)]
async fn set_file_mode_0600(file: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    tokio::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600))
        .await
        .map_err(|e| {
            format!(
                "cannot set permissions on {path}: {e}",
                path = file.display()
            )
        })
}

#[cfg(windows)]
async fn set_dir_mode_0700(_dir: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
async fn set_file_mode_0600(_file: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::Manager;
    use tempfile::tempdir;

    fn mock_app(roots: Vec<PathBuf>) -> tauri::App<tauri::test::MockRuntime> {
        tauri::test::mock_builder()
            .manage(AllowedRoots(std::sync::Mutex::new(roots)))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app builds")
    }

    #[tokio::test]
    async fn list_dir_entries_matches_the_ts_shape_and_sort_order() {
        let base = tempdir().unwrap();
        let dir = base.path();
        tokio::fs::create_dir(dir.join("zzz_dir")).await.unwrap();
        tokio::fs::create_dir(dir.join("node_modules"))
            .await
            .unwrap();
        tokio::fs::write(dir.join("aaa_file.txt"), "hi")
            .await
            .unwrap();

        let entries = list_dir_entries(dir).await.unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["node_modules", "zzz_dir", "aaa_file.txt"]);

        let nm = entries.iter().find(|e| e.name == "node_modules").unwrap();
        assert!(nm.dir);
        assert!(
            nm.ignored,
            "node_modules must be annotated ignored, not filtered out"
        );

        let file = entries.iter().find(|e| e.name == "aaa_file.txt").unwrap();
        assert!(!file.dir);
        assert!(!file.ignored);
    }

    #[tokio::test]
    async fn falsification_list_dir_entries_sort_order_would_catch_a_files_first_regression() {
        let base = tempdir().unwrap();
        let dir = base.path();
        tokio::fs::create_dir(dir.join("a_dir")).await.unwrap();
        tokio::fs::write(dir.join("z_file.txt"), "hi")
            .await
            .unwrap();

        let entries = list_dir_entries(dir).await.unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["a_dir", "z_file.txt"]);
    }

    #[tokio::test]
    async fn fs_read_directory_rejects_a_path_outside_every_allowed_root() {
        let base = tempdir().unwrap();
        let root = base.path().join("root");
        let outside = base.path().join("outside");
        tokio::fs::create_dir_all(&root).await.unwrap();
        tokio::fs::create_dir_all(&outside).await.unwrap();

        let roots = vec![tokio::fs::canonicalize(&root).await.unwrap()];
        let result =
            crate::fs_allowlist::assert_within_allowed_roots(outside.to_str().unwrap(), &roots)
                .await;
        assert!(result.is_err(), "path outside every root must be rejected");
    }

    #[tokio::test]
    async fn picker_list_dirs_works_on_a_directory_that_is_not_an_allowed_root() {
        let base = tempdir().unwrap();
        let dir = base.path();
        tokio::fs::create_dir(dir.join("sub_a")).await.unwrap();
        tokio::fs::create_dir(dir.join("sub_b")).await.unwrap();
        tokio::fs::write(dir.join("a_file.txt"), "hi")
            .await
            .unwrap();
        tokio::fs::create_dir(dir.join(".git")).await.unwrap();

        let result = fs_picker_list_dirs(dir.to_str().unwrap().to_string())
            .await
            .unwrap();
        let names = result.expect("existing directory must return Some");
        assert_eq!(
            names,
            vec!["sub_a".to_string(), "sub_b".to_string()],
            "must return directory names only, sorted, excluding .git"
        );
    }

    #[tokio::test]
    async fn falsification_picker_list_dirs_would_catch_a_leaked_file_name() {
        let base = tempdir().unwrap();
        let dir = base.path();
        tokio::fs::create_dir(dir.join("sub")).await.unwrap();
        tokio::fs::write(dir.join("leak.txt"), "hi").await.unwrap();

        let result = fs_picker_list_dirs(dir.to_str().unwrap().to_string())
            .await
            .unwrap();
        let names = result.unwrap();
        assert!(
            !names.contains(&"leak.txt".to_string()),
            "a file name must never appear in the picker result"
        );
        assert_eq!(names, vec!["sub".to_string()]);
    }

    #[tokio::test]
    async fn picker_list_dirs_returns_none_for_a_file_not_a_directory() {
        let base = tempdir().unwrap();
        let file = base.path().join("plain.txt");
        tokio::fs::write(&file, "hi").await.unwrap();

        let result = fs_picker_list_dirs(file.to_str().unwrap().to_string())
            .await
            .unwrap();
        assert_eq!(result, None);
    }

    #[tokio::test]
    async fn picker_list_dirs_returns_none_for_a_missing_path_never_erroring() {
        let base = tempdir().unwrap();
        let missing = base.path().join("does-not-exist");

        let result = fs_picker_list_dirs(missing.to_str().unwrap().to_string()).await;
        assert_eq!(result, Ok(None));
    }

    #[tokio::test]
    async fn fs_read_file_rejects_a_path_outside_every_allowed_root() {
        let base = tempdir().unwrap();
        let root = base.path().join("root");
        let outside_dir = base.path().join("outside");
        tokio::fs::create_dir_all(&root).await.unwrap();
        tokio::fs::create_dir_all(&outside_dir).await.unwrap();
        let outside_file = outside_dir.join("secret.txt");
        tokio::fs::write(&outside_file, "top secret").await.unwrap();

        let app = mock_app(vec![tokio::fs::canonicalize(&root).await.unwrap()]);
        let state = app.state::<AllowedRoots>();
        let result = fs_read_file(outside_file.to_str().unwrap().to_string(), state).await;
        let err = result.expect_err("path outside every root must be rejected");
        assert!(err.contains("outside every open workspace root"));
    }

    #[tokio::test]
    async fn fs_read_file_enforces_the_2mib_cap_naming_size_and_max() {
        let base = tempdir().unwrap();
        let root = base.path().join("root");
        tokio::fs::create_dir_all(&root).await.unwrap();
        let real_root = tokio::fs::canonicalize(&root).await.unwrap();
        let big_file = root.join("big.txt");
        let oversized = vec![b'x'; (EDIT_MAX_BYTES + 1) as usize];
        tokio::fs::write(&big_file, &oversized).await.unwrap();

        let app = mock_app(vec![real_root]);
        let state = app.state::<AllowedRoots>();
        let result = fs_read_file(big_file.to_str().unwrap().to_string(), state).await;
        let err = result.expect_err("oversized file must be rejected");
        assert!(
            err.contains(&(EDIT_MAX_BYTES + 1).to_string()),
            "must name the actual size: {err}"
        );
        assert!(
            err.contains(&EDIT_MAX_BYTES.to_string()),
            "must name the max: {err}"
        );
    }

    #[tokio::test]
    async fn falsification_fs_read_file_succeeds_just_under_the_cap() {
        let base = tempdir().unwrap();
        let root = base.path().join("root");
        tokio::fs::create_dir_all(&root).await.unwrap();
        let real_root = tokio::fs::canonicalize(&root).await.unwrap();
        let small_file = root.join("small.txt");
        let under = vec![b'x'; (EDIT_MAX_BYTES - 1) as usize];
        tokio::fs::write(&small_file, &under).await.unwrap();

        let app = mock_app(vec![real_root]);
        let state = app.state::<AllowedRoots>();
        let result = fs_read_file(small_file.to_str().unwrap().to_string(), state).await;
        assert!(
            result.is_ok(),
            "a file under the cap must be readable: {result:?}"
        );
    }

    #[tokio::test]
    async fn fs_read_file_refuses_a_nul_byte_in_the_first_8192_bytes() {
        let base = tempdir().unwrap();
        let root = base.path().join("root");
        tokio::fs::create_dir_all(&root).await.unwrap();
        let real_root = tokio::fs::canonicalize(&root).await.unwrap();
        let bin_file = root.join("bin.dat");
        let mut content = vec![b'a'; 100];
        content[50] = 0;
        tokio::fs::write(&bin_file, &content).await.unwrap();

        let app = mock_app(vec![real_root]);
        let state = app.state::<AllowedRoots>();
        let result = fs_read_file(bin_file.to_str().unwrap().to_string(), state).await;
        let err = result.expect_err("a NUL byte must be refused as binary");
        assert!(
            err.contains("refusing to open binary file"),
            "unexpected message: {err}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn falsification_fs_read_file_ignores_a_nul_byte_after_8192_bytes() {
        let base = tempdir().unwrap();
        let root = base.path().join("root");
        tokio::fs::create_dir_all(&root).await.unwrap();
        let real_root = tokio::fs::canonicalize(&root).await.unwrap();
        let file = root.join("late-nul.dat");
        let mut content = vec![b'a'; 9000];
        content[8500] = 0;
        tokio::fs::write(&file, &content).await.unwrap();

        let app = mock_app(vec![real_root]);
        let state = app.state::<AllowedRoots>();
        let result = fs_read_file(file.to_str().unwrap().to_string(), state).await;
        assert!(
            result.is_ok(),
            "a NUL past byte 8192 must not trip the binary refusal: {result:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fs_read_media_rejects_a_symlink_escaping_every_allowed_root() {
        let base = tempdir().unwrap();
        let ws = base.path().join("ws");
        let secret = base.path().join("secret");
        tokio::fs::create_dir_all(&ws).await.unwrap();
        tokio::fs::create_dir_all(&secret).await.unwrap();
        tokio::fs::write(secret.join("creds.png"), b"TOP SECRET BYTES")
            .await
            .unwrap();
        std::os::unix::fs::symlink("../secret", ws.join("link")).unwrap();

        let real_ws = tokio::fs::canonicalize(&ws).await.unwrap();
        let app = mock_app(vec![real_ws]);
        let state = app.state::<AllowedRoots>();
        let attack_path = format!("{}/link/../secret/creds.png", ws.display());

        let result = fs_read_media(attack_path.clone(), state).await.map(|_| ());
        let err = result.expect_err("symlink-then-dotdot escape must be rejected");
        assert!(
            err.contains("outside every open workspace root"),
            "unexpected message: {err}"
        );
        assert!(
            err.contains(&attack_path),
            "must name the offending path: {err}"
        );
    }

    #[tokio::test]
    async fn fs_read_media_rejects_a_plain_dotdot_traversal_escaping_the_root() {
        let base = tempdir().unwrap();
        let ws = base.path().join("ws");
        let outside = base.path().join("outside");
        tokio::fs::create_dir_all(&ws).await.unwrap();
        tokio::fs::create_dir_all(&outside).await.unwrap();
        tokio::fs::write(outside.join("secret.png"), b"secret bytes")
            .await
            .unwrap();

        let real_ws = tokio::fs::canonicalize(&ws).await.unwrap();
        let app = mock_app(vec![real_ws]);
        let state = app.state::<AllowedRoots>();
        let attack_path = format!("{}/../outside/secret.png", ws.display());

        let result = fs_read_media(attack_path, state).await.map(|_| ());
        let err = result.expect_err("a `..` traversal escaping the root must be rejected");
        assert!(
            err.contains("outside every open workspace root"),
            "unexpected message: {err}"
        );
    }

    #[tokio::test]
    async fn fs_read_media_names_the_no_roots_open_case_distinctly() {
        let base = tempdir().unwrap();
        let target = base.path().join("x.png");
        tokio::fs::write(&target, b"bytes").await.unwrap();

        let app = mock_app(vec![]);
        let state = app.state::<AllowedRoots>();
        let result = fs_read_media(target.to_str().unwrap().to_string(), state)
            .await
            .map(|_| ());
        let err = result.expect_err("must be rejected with no roots open");
        assert!(
            err.contains("no workspace roots are open yet"),
            "unexpected message: {err}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fs_read_media_names_the_expected_roots_when_some_are_open_but_none_match() {
        let base = tempdir().unwrap();
        let root = base.path().join("root");
        let outside = base.path().join("outside");
        tokio::fs::create_dir_all(&root).await.unwrap();
        tokio::fs::create_dir_all(&outside).await.unwrap();
        let outside_file = outside.join("x.png");
        tokio::fs::write(&outside_file, b"bytes").await.unwrap();

        let real_root = tokio::fs::canonicalize(&root).await.unwrap();
        let app = mock_app(vec![real_root.clone()]);
        let state = app.state::<AllowedRoots>();
        let result = fs_read_media(outside_file.to_str().unwrap().to_string(), state)
            .await
            .map(|_| ());
        let err = result.expect_err("path outside the one open root must be rejected");
        assert!(
            err.contains("expected under one of"),
            "must distinguish this from the no-roots-open case: {err}"
        );
        assert!(
            err.contains(&real_root.display().to_string()),
            "must name the open root: {err}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fs_read_media_reads_the_resolved_path_not_the_callers_string() {
        let base = tempdir().unwrap();
        let ws = base.path().join("ws");
        let b = ws.join("b");
        tokio::fs::create_dir_all(&b).await.unwrap();
        tokio::fs::write(b.join("f.png"), b"real bytes")
            .await
            .unwrap();

        let real_ws = tokio::fs::canonicalize(&ws).await.unwrap();
        let app = mock_app(vec![real_ws]);
        let state = app.state::<AllowedRoots>();
        let path = format!("{}/a/../b/f.png", ws.display());
        assert!(
            !ws.join("a").exists(),
            "precondition: <ws>/a must NOT exist — it is the missing component that \
             forces the resolver onto its lexical tail path"
        );
        assert!(
            tokio::fs::read(&path).await.is_err(),
            "precondition: the kernel must refuse the caller's raw string, or this \
             test would also pass for a read of `file_path`"
        );

        let result = fs_read_media(path, state).await.map(|_| ());
        assert!(
            result.is_ok(),
            "the command must read the resolved path the gate returned: {result:?}"
        );
    }

    #[tokio::test]
    async fn fs_read_media_returns_the_exact_bytes_of_a_legitimate_file_under_a_root() {
        let base = tempdir().unwrap();
        let ws = base.path().join("ws");
        tokio::fs::create_dir_all(&ws).await.unwrap();
        let file = ws.join("photo.png");
        let content: Vec<u8> = (0u8..=255).cycle().take(5000).collect();
        tokio::fs::write(&file, &content).await.unwrap();

        let real = tokio::fs::canonicalize(&file).await.unwrap();
        let bytes = read_media_bytes(&real, file.to_str().unwrap(), MEDIA_MAX_BYTES)
            .await
            .expect("a legitimate file under an allowed root must read");
        assert_eq!(bytes, content, "bytes must match byte-for-byte");
    }

    #[tokio::test]
    async fn fs_read_media_enforces_the_cap_naming_path_size_and_max() {
        let base = tempdir().unwrap();
        let big_file = base.path().join("big.mp4");
        tokio::fs::write(&big_file, vec![b'x'; 17]).await.unwrap();

        let real = tokio::fs::canonicalize(&big_file).await.unwrap();
        let result = read_media_bytes(&real, big_file.to_str().unwrap(), 16).await;
        let err = result.expect_err("oversized media file must be rejected");
        assert!(err.contains("17"), "must name the actual size: {err}");
        assert!(err.contains("max 16"), "must name the max: {err}");
        assert!(
            err.contains(big_file.to_str().unwrap()),
            "must name the offending path: {err}"
        );
    }

    #[tokio::test]
    async fn falsification_fs_read_media_succeeds_at_exactly_the_cap() {
        let base = tempdir().unwrap();
        let file = base.path().join("small.mp3");
        tokio::fs::write(&file, vec![b'x'; 16]).await.unwrap();

        let real = tokio::fs::canonicalize(&file).await.unwrap();
        let result = read_media_bytes(&real, file.to_str().unwrap(), 16).await;
        assert!(
            result.is_ok(),
            "a file at exactly the cap must be readable: {result:?}"
        );
    }

    #[tokio::test]
    async fn fs_read_media_refuses_a_file_over_media_max_bytes() {
        let base = tempdir().unwrap();
        let ws = base.path().join("ws");
        tokio::fs::create_dir_all(&ws).await.unwrap();
        let big = ws.join("huge.mp4");
        std::fs::File::create(&big)
            .unwrap()
            .set_len(MEDIA_MAX_BYTES + 1)
            .unwrap();

        let real_ws = tokio::fs::canonicalize(&ws).await.unwrap();
        let app = mock_app(vec![real_ws]);
        let state = app.state::<AllowedRoots>();
        let result = fs_read_media(big.to_str().unwrap().to_string(), state)
            .await
            .map(|_| ());
        let err = result.expect_err("a file over MEDIA_MAX_BYTES must be refused");
        assert!(
            err.contains("file too large to preview")
                && err.contains(&(MEDIA_MAX_BYTES + 1).to_string())
                && err.contains(&MEDIA_MAX_BYTES.to_string()),
            "must name the refusal, the actual size and the cap: {err}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fs_read_media_refuses_a_non_regular_file_instead_of_hanging_on_it() {
        let base = tempdir().unwrap();
        let ws = base.path().join("ws");
        tokio::fs::create_dir_all(&ws).await.unwrap();
        let sock_path = ws.join("out.mp4");
        let _listener = std::os::unix::net::UnixListener::bind(&sock_path).unwrap();
        assert_eq!(
            std::fs::metadata(&sock_path).unwrap().len(),
            0,
            "precondition: a non-regular file stats as zero-length, which is why the \
             size cap cannot catch it"
        );

        let real_ws = tokio::fs::canonicalize(&ws).await.unwrap();
        let app = mock_app(vec![real_ws]);
        let state = app.state::<AllowedRoots>();
        let result = fs_read_media(sock_path.to_str().unwrap().to_string(), state)
            .await
            .map(|_| ());
        let err = result.expect_err("a non-regular file must be refused, not read");
        assert!(
            err.contains("not a regular file") && err.contains(sock_path.to_str().unwrap()),
            "must name the refusal and the offending path: {err}"
        );
        assert!(
            err.contains("socket"),
            "must name what it actually is: {err}"
        );
    }

    #[tokio::test]
    async fn fs_read_media_refuses_a_non_media_extension_under_an_open_root() {
        let base = tempdir().unwrap();
        let ws = base.path().join("ws");
        tokio::fs::create_dir_all(&ws).await.unwrap();
        let secret = ws.join(".env");
        tokio::fs::write(&secret, b"TOKEN=hunter2").await.unwrap();

        let real_ws = tokio::fs::canonicalize(&ws).await.unwrap();
        let app = mock_app(vec![real_ws]);
        let state = app.state::<AllowedRoots>();
        let result = fs_read_media(secret.to_str().unwrap().to_string(), state)
            .await
            .map(|_| ());
        let err = result.expect_err("a non-media extension must be refused");
        assert!(
            err.contains("not a previewable media file"),
            "unexpected message: {err}"
        );
        assert!(
            err.contains(secret.to_str().unwrap()),
            "must name the offending path: {err}"
        );
        assert!(err.contains("\"env\""), "must name the extension: {err}");
    }

    #[tokio::test]
    async fn falsification_fs_read_media_allows_the_same_bytes_under_a_media_extension() {
        let base = tempdir().unwrap();
        let ws = base.path().join("ws");
        tokio::fs::create_dir_all(&ws).await.unwrap();
        let allowed = ws.join("shot.png");
        tokio::fs::write(&allowed, b"TOKEN=hunter2").await.unwrap();

        let real_ws = tokio::fs::canonicalize(&ws).await.unwrap();
        let app = mock_app(vec![real_ws]);
        let state = app.state::<AllowedRoots>();
        let result = fs_read_media(allowed.to_str().unwrap().to_string(), state)
            .await
            .map(|_| ());
        assert!(
            result.is_ok(),
            "a media extension must be allowed: {result:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn ext_of_matches_the_ts_extof_rule_including_dotfiles() {
        assert_eq!(ext_of(Path::new("/ws/photo.PNG")), "png");
        assert_eq!(ext_of(Path::new("/ws/.env")), "env");
        assert_eq!(ext_of(Path::new("/ws/.png")), "png");
        assert_eq!(ext_of(Path::new("/ws/archive.tar.gz")), "gz");
        assert_eq!(ext_of(Path::new("/ws/Makefile")), "");
        assert_eq!(
            ext_of(Path::new("/ws.d/Makefile")),
            "",
            "a dot in a parent directory is not the file's extension"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fs_read_media_gates_on_the_symlink_target_extension_not_the_link_name() {
        let base = tempdir().unwrap();
        let ws = base.path().join("ws");
        tokio::fs::create_dir_all(&ws).await.unwrap();
        tokio::fs::write(ws.join("secrets.env"), b"TOKEN=hunter2")
            .await
            .unwrap();
        std::os::unix::fs::symlink("secrets.env", ws.join("x.png")).unwrap();

        let real_ws = tokio::fs::canonicalize(&ws).await.unwrap();
        let app = mock_app(vec![real_ws]);
        let state = app.state::<AllowedRoots>();
        let result = fs_read_media(ws.join("x.png").to_str().unwrap().to_string(), state)
            .await
            .map(|_| ());
        let err = result.expect_err("a media-named symlink to a non-media file must be refused");
        assert!(
            err.contains("not a previewable media file") && err.contains("\"env\""),
            "must refuse on the resolved target's extension: {err}"
        );
    }

    #[tokio::test]
    async fn fs_write_file_rejects_a_path_outside_every_allowed_root() {
        let base = tempdir().unwrap();
        let root = base.path().join("root");
        let outside = base.path().join("outside");
        tokio::fs::create_dir_all(&root).await.unwrap();
        tokio::fs::create_dir_all(&outside).await.unwrap();
        let real_root = tokio::fs::canonicalize(&root).await.unwrap();

        let app = mock_app(vec![real_root]);
        let state = app.state::<AllowedRoots>();
        let result = fs_write_file(
            outside.join("x.txt").to_str().unwrap().to_string(),
            "hi".to_string(),
            state,
        )
        .await;
        assert!(result.is_err(), "path outside every root must be rejected");
    }

    #[tokio::test]
    async fn fs_write_file_writes_content_inside_an_allowed_root() {
        let base = tempdir().unwrap();
        let root = base.path().join("root");
        tokio::fs::create_dir_all(&root).await.unwrap();
        let real_root = tokio::fs::canonicalize(&root).await.unwrap();
        let target = root.join("new.txt");

        let app = mock_app(vec![real_root]);
        let state = app.state::<AllowedRoots>();
        fs_write_file(
            target.to_str().unwrap().to_string(),
            "hello world".to_string(),
            state,
        )
        .await
        .unwrap();

        let written = tokio::fs::read_to_string(&target).await.unwrap();
        assert_eq!(written, "hello world");
    }

    #[tokio::test]
    async fn fs_stat_returns_none_for_a_missing_file_inside_an_allowed_root() {
        let base = tempdir().unwrap();
        let root = base.path().join("root");
        tokio::fs::create_dir_all(&root).await.unwrap();
        let real_root = tokio::fs::canonicalize(&root).await.unwrap();
        let missing = root.join("missing.txt");

        let app = mock_app(vec![real_root]);
        let state = app.state::<AllowedRoots>();
        let result = fs_stat(missing.to_str().unwrap().to_string(), state)
            .await
            .unwrap();
        assert_eq!(
            result, None,
            "missing file must be a quiet None, not an error"
        );
    }

    #[tokio::test]
    async fn fs_stat_errors_loudly_for_a_path_outside_every_allowed_root() {
        let base = tempdir().unwrap();
        let root = base.path().join("root");
        let outside = base.path().join("outside");
        tokio::fs::create_dir_all(&root).await.unwrap();
        tokio::fs::create_dir_all(&outside).await.unwrap();
        let real_root = tokio::fs::canonicalize(&root).await.unwrap();

        let app = mock_app(vec![real_root]);
        let state = app.state::<AllowedRoots>();
        let result = fs_stat(outside.join("x.txt").to_str().unwrap().to_string(), state).await;
        assert!(
            result.is_err(),
            "an out-of-root path must be a loud error, not a quiet None: {result:?}"
        );
    }

    #[tokio::test]
    async fn fs_stat_returns_mtime_for_an_existing_file() {
        let base = tempdir().unwrap();
        let root = base.path().join("root");
        tokio::fs::create_dir_all(&root).await.unwrap();
        let real_root = tokio::fs::canonicalize(&root).await.unwrap();
        let file = root.join("exists.txt");
        tokio::fs::write(&file, "hi").await.unwrap();

        let app = mock_app(vec![real_root]);
        let state = app.state::<AllowedRoots>();
        let result = fs_stat(file.to_str().unwrap().to_string(), state)
            .await
            .unwrap();
        let stat = result.expect("existing file must return Some");
        assert!(stat.mtime_ms > 0.0);
    }

    #[tokio::test]
    async fn fs_exists_never_throws_and_returns_none_on_an_out_of_root_path() {
        let base = tempdir().unwrap();
        let root = base.path().join("root");
        let outside = base.path().join("outside");
        tokio::fs::create_dir_all(&root).await.unwrap();
        tokio::fs::create_dir_all(&outside).await.unwrap();
        let real_root = tokio::fs::canonicalize(&root).await.unwrap();

        let app = mock_app(vec![real_root]);
        let state = app.state::<AllowedRoots>();
        let result = fs_exists(outside.join("x.txt").to_str().unwrap().to_string(), state)
            .await
            .unwrap();
        assert_eq!(
            result, None,
            "gate rejection must swallow into None, never Err"
        );
    }

    #[tokio::test]
    async fn fs_exists_distinguishes_dir_and_file_kinds() {
        let base = tempdir().unwrap();
        let root = base.path().join("root");
        tokio::fs::create_dir_all(&root).await.unwrap();
        let real_root = tokio::fs::canonicalize(&root).await.unwrap();
        let file = root.join("f.txt");
        tokio::fs::write(&file, "hi").await.unwrap();
        let dir = root.join("d");
        tokio::fs::create_dir(&dir).await.unwrap();

        let app = mock_app(vec![real_root.clone()]);
        let state = app.state::<AllowedRoots>();
        let file_kind = fs_exists(file.to_str().unwrap().to_string(), state)
            .await
            .unwrap();
        assert_eq!(file_kind, Some("file".to_string()));

        let app = mock_app(vec![real_root]);
        let state = app.state::<AllowedRoots>();
        let dir_kind = fs_exists(dir.to_str().unwrap().to_string(), state)
            .await
            .unwrap();
        assert_eq!(dir_kind, Some("dir".to_string()));
    }

    #[tokio::test]
    async fn fs_exists_returns_none_for_a_missing_file_never_erroring() {
        let base = tempdir().unwrap();
        let root = base.path().join("root");
        tokio::fs::create_dir_all(&root).await.unwrap();
        let real_root = tokio::fs::canonicalize(&root).await.unwrap();
        let missing = root.join("nope.txt");

        let app = mock_app(vec![real_root]);
        let state = app.state::<AllowedRoots>();
        let result = fs_exists(missing.to_str().unwrap().to_string(), state)
            .await
            .unwrap();
        assert_eq!(result, None);
    }

    #[tokio::test]
    async fn fs_delete_rejects_a_path_outside_every_allowed_root() {
        let base = tempdir().unwrap();
        let root = base.path().join("root");
        let outside = base.path().join("outside");
        tokio::fs::create_dir_all(&root).await.unwrap();
        tokio::fs::create_dir_all(&outside).await.unwrap();
        let real_root = tokio::fs::canonicalize(&root).await.unwrap();
        let outside_file = outside.join("keep.txt");
        tokio::fs::write(&outside_file, "hi").await.unwrap();

        let app = mock_app(vec![real_root]);
        let state = app.state::<AllowedRoots>();
        let result = fs_delete(outside_file.to_str().unwrap().to_string(), state).await;
        assert!(result.is_err(), "path outside every root must be rejected");
        assert!(
            tokio::fs::metadata(&outside_file).await.is_ok(),
            "rejected delete must not touch the file"
        );
    }

    #[cfg(unix)]
    const TRASH_TEST_PREFIX: &str = "tr-b3b-";

    #[cfg(unix)]
    static TRASH_ENV: std::sync::RwLock<()> = std::sync::RwLock::new(());

    #[allow(clippy::await_holding_lock)]
    #[cfg(unix)]
    #[tokio::test]
    async fn fs_delete_moves_a_file_to_the_trash_rather_than_unlinking_it() {
        let _env = TRASH_ENV.read().unwrap();
        let base = tempdir().unwrap();
        let root = base.path().join("root");
        tokio::fs::create_dir_all(&root).await.unwrap();
        let real_root = tokio::fs::canonicalize(&root).await.unwrap();
        let file = root.join(format!("{TRASH_TEST_PREFIX}deleted-file.txt"));
        tokio::fs::write(&file, "hi").await.unwrap();
        let original = tokio::fs::canonicalize(&file).await.unwrap();

        let app = mock_app(vec![real_root]);
        let state = app.state::<AllowedRoots>();
        fs_delete(file.to_str().unwrap().to_string(), state)
            .await
            .unwrap();
        assert!(tokio::fs::symlink_metadata(&file).await.is_err());
        let listed = trash::os_limited::list().expect("the trash must be enumerable");
        assert!(
            listed.iter().any(|item| item.original_path() == original),
            "trashed entry must appear in the trash under {original:?}"
        );
    }

    #[allow(clippy::await_holding_lock)]
    #[cfg(unix)]
    #[tokio::test]
    async fn fs_delete_on_a_symlink_leaving_the_root_takes_the_link_and_leaves_its_target() {
        let _env = TRASH_ENV.read().unwrap();
        use std::os::unix::fs::symlink;
        let base = tempdir().unwrap();
        let ws = base.path().join("ws");
        let outside = base.path().join("outside");
        tokio::fs::create_dir_all(&ws).await.unwrap();
        tokio::fs::create_dir_all(&outside).await.unwrap();
        let target = outside.join("keep-me.txt");
        tokio::fs::write(&target, "TARGET BYTES").await.unwrap();
        let link = ws.join(format!("{TRASH_TEST_PREFIX}symlink-to-outside"));
        symlink(&target, &link).unwrap();
        let real_ws = tokio::fs::canonicalize(&ws).await.unwrap();

        let app = mock_app(vec![real_ws]);
        let state = app.state::<AllowedRoots>();
        fs_delete(link.to_str().unwrap().to_string(), state)
            .await
            .unwrap();

        assert!(
            tokio::fs::symlink_metadata(&link).await.is_err(),
            "the symlink itself must be gone"
        );
        assert_eq!(
            tokio::fs::read_to_string(&target).await.unwrap(),
            "TARGET BYTES",
            "the symlink's target must be untouched"
        );
    }

    #[allow(clippy::await_holding_lock)]
    #[cfg(unix)]
    #[tokio::test]
    async fn fs_delete_on_a_symlinked_directory_leaving_the_root_leaves_the_target_subtree() {
        let _env = TRASH_ENV.read().unwrap();
        use std::os::unix::fs::symlink;
        let base = tempdir().unwrap();
        let ws = base.path().join("ws");
        let outside = base.path().join("outside");
        tokio::fs::create_dir_all(&ws).await.unwrap();
        tokio::fs::create_dir_all(outside.join("nested"))
            .await
            .unwrap();
        tokio::fs::write(outside.join("nested").join("deep.txt"), "DEEP")
            .await
            .unwrap();
        let link = ws.join(format!("{TRASH_TEST_PREFIX}symlinked-dir"));
        symlink(&outside, &link).unwrap();
        let real_ws = tokio::fs::canonicalize(&ws).await.unwrap();

        let app = mock_app(vec![real_ws]);
        let state = app.state::<AllowedRoots>();
        fs_delete(link.to_str().unwrap().to_string(), state)
            .await
            .unwrap();

        assert!(tokio::fs::symlink_metadata(&link).await.is_err());
        assert_eq!(
            tokio::fs::read_to_string(outside.join("nested").join("deep.txt"))
                .await
                .unwrap(),
            "DEEP",
            "the target subtree must survive intact"
        );
    }

    #[tokio::test]
    async fn fs_delete_refuses_a_dotdot_escape_out_of_every_root() {
        let base = tempdir().unwrap();
        let ws = base.path().join("ws");
        let outside = base.path().join("outside");
        tokio::fs::create_dir_all(&ws).await.unwrap();
        tokio::fs::create_dir_all(&outside).await.unwrap();
        let victim = outside.join("keep.txt");
        tokio::fs::write(&victim, "hi").await.unwrap();
        let real_ws = tokio::fs::canonicalize(&ws).await.unwrap();
        let attack = format!("{}/../outside/keep.txt", ws.display());

        let app = mock_app(vec![real_ws]);
        let state = app.state::<AllowedRoots>();
        let err = fs_delete(attack.clone(), state)
            .await
            .expect_err("a '..' escape must be refused");
        assert!(
            err.contains("outside every open workspace root") && err.contains(&attack),
            "refusal must name the offending path: {err}"
        );
        assert!(
            tokio::fs::metadata(&victim).await.is_ok(),
            "a refused delete must not touch anything"
        );
    }

    #[tokio::test]
    async fn fs_delete_with_no_roots_open_says_so_rather_than_naming_an_empty_list() {
        let base = tempdir().unwrap();
        let file = base.path().join("x.txt");
        tokio::fs::write(&file, "hi").await.unwrap();

        let app = mock_app(vec![]);
        let state = app.state::<AllowedRoots>();
        let err = fs_delete(file.to_str().unwrap().to_string(), state)
            .await
            .expect_err("no roots open must be a refusal");
        assert!(
            err.contains("no workspace roots are open yet"),
            "the no-roots case must be distinguished from 'expected under one of': {err}"
        );
        assert!(tokio::fs::metadata(&file).await.is_ok());
    }

    #[allow(clippy::await_holding_lock)]
    #[cfg(unix)]
    #[tokio::test]
    async fn fs_delete_takes_a_non_empty_directory_whole() {
        let _env = TRASH_ENV.read().unwrap();
        let base = tempdir().unwrap();
        let root = base.path().join("root");
        let doomed = root.join(format!("{TRASH_TEST_PREFIX}deleted-dir"));
        tokio::fs::create_dir_all(doomed.join("nested"))
            .await
            .unwrap();
        tokio::fs::write(doomed.join("nested").join("a.txt"), "a")
            .await
            .unwrap();
        let real_root = tokio::fs::canonicalize(&root).await.unwrap();

        let app = mock_app(vec![real_root]);
        let state = app.state::<AllowedRoots>();
        fs_delete(doomed.to_str().unwrap().to_string(), state)
            .await
            .unwrap();
        assert!(tokio::fs::symlink_metadata(&doomed).await.is_err());
    }

    #[allow(clippy::await_holding_lock)]
    #[cfg(unix)]
    #[tokio::test]
    async fn a_delete_that_cannot_be_trashed_reports_it_instead_of_unlinking() {
        let _env = TRASH_ENV.write().unwrap();
        let base = tempdir().unwrap();
        let root = base.path().join("root");
        tokio::fs::create_dir_all(&root).await.unwrap();
        let real_root = tokio::fs::canonicalize(&root).await.unwrap();
        let victim = root.join("must-survive.txt");
        tokio::fs::write(&victim, "STILL HERE").await.unwrap();

        let data_home = base.path().join("readonly-data-home");
        tokio::fs::create_dir_all(&data_home).await.unwrap();
        let mut perms = tokio::fs::metadata(&data_home).await.unwrap().permissions();
        std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o555);
        tokio::fs::set_permissions(&data_home, perms).await.unwrap();

        let previous = std::env::var_os("XDG_DATA_HOME");
        std::env::set_var("XDG_DATA_HOME", &data_home);
        let app = mock_app(vec![real_root]);
        let result = fs_delete(
            victim.to_str().unwrap().to_string(),
            app.state::<AllowedRoots>(),
        )
        .await;
        match previous {
            Some(v) => std::env::set_var("XDG_DATA_HOME", v),
            None => std::env::remove_var("XDG_DATA_HOME"),
        }
        let mut perms = tokio::fs::metadata(&data_home).await.unwrap().permissions();
        std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o755);
        tokio::fs::set_permissions(&data_home, perms).await.unwrap();

        let err = result.expect_err("an untrashable delete must fail, not succeed quietly");
        assert!(
            err.contains("cannot move") && err.contains("must-survive.txt"),
            "the failure must name the entry the user asked to delete: {err}"
        );
        assert!(
            err.contains("Denied") || err.contains("denied") || err.contains("FileSystem"),
            "the crate's own error text must reach the user rather than be flattened: {err}"
        );
        assert_eq!(
            tokio::fs::read_to_string(&victim).await.unwrap(),
            "STILL HERE",
            "fail closed: a delete that could not be trashed must not have happened"
        );
    }

    #[tokio::test]
    async fn a_delete_of_a_missing_entry_is_refused_before_the_trash_is_called() {
        let base = tempdir().unwrap();
        let sibling = base.path().join("sibling.txt");
        tokio::fs::write(&sibling, "UNRELATED").await.unwrap();
        let missing = base.path().join("not-here.txt");

        let err = trash_entry(missing.clone(), missing.to_str().unwrap())
            .await
            .expect_err("a delete of a missing entry must fail");
        assert!(
            err.contains("not-here.txt"),
            "the failure must name the offending path: {err}"
        );
        assert_eq!(
            tokio::fs::read_to_string(&sibling).await.unwrap(),
            "UNRELATED",
            "a refusal must not have touched a neighbouring file"
        );
    }

    #[tokio::test]
    async fn fs_create_file_creates_an_empty_file_inside_an_allowed_root() {
        let base = tempdir().unwrap();
        let root = base.path().join("root");
        tokio::fs::create_dir_all(&root).await.unwrap();
        let real_root = tokio::fs::canonicalize(&root).await.unwrap();
        let target = root.join("fresh.txt");

        let app = mock_app(vec![real_root]);
        let state = app.state::<AllowedRoots>();
        fs_create_file(target.to_str().unwrap().to_string(), state)
            .await
            .unwrap();
        assert_eq!(tokio::fs::read_to_string(&target).await.unwrap(), "");
    }

    #[tokio::test]
    async fn fs_create_file_refuses_to_clobber_an_existing_file() {
        let base = tempdir().unwrap();
        let root = base.path().join("root");
        tokio::fs::create_dir_all(&root).await.unwrap();
        let real_root = tokio::fs::canonicalize(&root).await.unwrap();
        let target = root.join("taken.txt");
        tokio::fs::write(&target, "PRECIOUS").await.unwrap();

        let app = mock_app(vec![real_root]);
        let state = app.state::<AllowedRoots>();
        let err = fs_create_file(target.to_str().unwrap().to_string(), state)
            .await
            .expect_err("an existing name must be refused");
        assert!(err.contains("taken.txt"), "must name the path: {err}");
        assert_eq!(
            tokio::fs::read_to_string(&target).await.unwrap(),
            "PRECIOUS",
            "a refused create must not touch the existing file"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fs_create_file_rejects_a_path_outside_every_allowed_root() {
        let base = tempdir().unwrap();
        let root = base.path().join("root");
        let outside = base.path().join("outside");
        tokio::fs::create_dir_all(&root).await.unwrap();
        tokio::fs::create_dir_all(&outside).await.unwrap();
        let real_root = tokio::fs::canonicalize(&root).await.unwrap();
        let target = outside.join("x.txt");

        let app = mock_app(vec![real_root]);
        let state = app.state::<AllowedRoots>();
        let err = fs_create_file(target.to_str().unwrap().to_string(), state)
            .await
            .expect_err("outside every root must be refused");
        assert!(err.contains("outside every open workspace root"), "{err}");
        assert!(tokio::fs::metadata(&target).await.is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fs_create_file_refuses_a_path_through_a_symlink_leaving_the_root() {
        use std::os::unix::fs::symlink;
        let base = tempdir().unwrap();
        let ws = base.path().join("ws");
        let outside = base.path().join("outside");
        tokio::fs::create_dir_all(&ws).await.unwrap();
        tokio::fs::create_dir_all(&outside).await.unwrap();
        symlink(&outside, ws.join("link")).unwrap();
        let real_ws = tokio::fs::canonicalize(&ws).await.unwrap();

        let app = mock_app(vec![real_ws]);
        let state = app.state::<AllowedRoots>();
        let err = fs_create_file(
            ws.join("link")
                .join("planted.txt")
                .to_str()
                .unwrap()
                .to_string(),
            state,
        )
        .await
        .expect_err("writing through an escaping symlink must be refused");
        assert!(err.contains("outside every open workspace root"), "{err}");
        assert!(tokio::fs::metadata(outside.join("planted.txt"))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn fs_create_directory_creates_one_level_and_refuses_a_missing_parent() {
        let base = tempdir().unwrap();
        let root = base.path().join("root");
        tokio::fs::create_dir_all(&root).await.unwrap();
        let real_root = tokio::fs::canonicalize(&root).await.unwrap();

        let app = mock_app(vec![real_root]);
        fs_create_directory(
            root.join("made").to_str().unwrap().to_string(),
            app.state::<AllowedRoots>(),
        )
        .await
        .unwrap();
        assert!(tokio::fs::metadata(root.join("made"))
            .await
            .unwrap()
            .is_dir());

        let err = fs_create_directory(
            root.join("nope").join("deep").to_str().unwrap().to_string(),
            app.state::<AllowedRoots>(),
        )
        .await
        .expect_err("a missing parent must be refused, not materialized");
        assert!(err.contains("deep"), "must name the path: {err}");
        assert!(tokio::fs::metadata(root.join("nope")).await.is_err());
    }

    #[tokio::test]
    async fn fs_create_directory_rejects_a_path_outside_every_allowed_root() {
        let base = tempdir().unwrap();
        let root = base.path().join("root");
        let outside = base.path().join("outside");
        tokio::fs::create_dir_all(&root).await.unwrap();
        tokio::fs::create_dir_all(&outside).await.unwrap();
        let real_root = tokio::fs::canonicalize(&root).await.unwrap();

        let app = mock_app(vec![real_root]);
        let state = app.state::<AllowedRoots>();
        let err = fs_create_directory(outside.join("nope").to_str().unwrap().to_string(), state)
            .await
            .expect_err("outside every root must be refused");
        assert!(err.contains("outside every open workspace root"), "{err}");
        assert!(tokio::fs::metadata(outside.join("nope")).await.is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fs_rename_moves_an_entry_inside_an_allowed_root() {
        let base = tempdir().unwrap();
        let root = base.path().join("root");
        tokio::fs::create_dir_all(&root).await.unwrap();
        let real_root = tokio::fs::canonicalize(&root).await.unwrap();
        let from = root.join("before.txt");
        let to = root.join("after.txt");
        tokio::fs::write(&from, "CONTENT").await.unwrap();

        let app = mock_app(vec![real_root]);
        let state = app.state::<AllowedRoots>();
        fs_rename(
            from.to_str().unwrap().to_string(),
            to.to_str().unwrap().to_string(),
            state,
        )
        .await
        .unwrap();
        assert!(tokio::fs::symlink_metadata(&from).await.is_err());
        assert_eq!(tokio::fs::read_to_string(&to).await.unwrap(), "CONTENT");
    }

    #[tokio::test]
    async fn fs_rename_refuses_a_destination_outside_every_root_and_names_it() {
        let base = tempdir().unwrap();
        let root = base.path().join("root");
        let outside = base.path().join("outside");
        tokio::fs::create_dir_all(&root).await.unwrap();
        tokio::fs::create_dir_all(&outside).await.unwrap();
        let real_root = tokio::fs::canonicalize(&root).await.unwrap();
        let from = root.join("inside.txt");
        tokio::fs::write(&from, "CONTENT").await.unwrap();
        let to = outside.join("escaped.txt");

        let app = mock_app(vec![real_root]);
        let state = app.state::<AllowedRoots>();
        let err = fs_rename(
            from.to_str().unwrap().to_string(),
            to.to_str().unwrap().to_string(),
            state,
        )
        .await
        .expect_err("an escaping destination must be refused");
        assert!(
            err.contains("outside every open workspace root") && err.contains(to.to_str().unwrap()),
            "the refusal must name the DESTINATION, not the source: {err}"
        );
        assert!(
            tokio::fs::read_to_string(&from).await.unwrap() == "CONTENT"
                && tokio::fs::metadata(&to).await.is_err(),
            "a refused rename must move nothing"
        );
    }

    #[tokio::test]
    async fn fs_rename_refuses_a_source_outside_every_root() {
        let base = tempdir().unwrap();
        let root = base.path().join("root");
        let outside = base.path().join("outside");
        tokio::fs::create_dir_all(&root).await.unwrap();
        tokio::fs::create_dir_all(&outside).await.unwrap();
        let real_root = tokio::fs::canonicalize(&root).await.unwrap();
        let from = outside.join("theirs.txt");
        tokio::fs::write(&from, "CONTENT").await.unwrap();

        let app = mock_app(vec![real_root]);
        let state = app.state::<AllowedRoots>();
        let err = fs_rename(
            from.to_str().unwrap().to_string(),
            root.join("stolen.txt").to_str().unwrap().to_string(),
            state,
        )
        .await
        .expect_err("an outside source must be refused");
        assert!(err.contains("outside every open workspace root"), "{err}");
        assert!(tokio::fs::metadata(&from).await.is_ok());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fs_rename_refuses_an_occupied_destination_instead_of_overwriting_it() {
        let base = tempdir().unwrap();
        let root = base.path().join("root");
        tokio::fs::create_dir_all(&root).await.unwrap();
        let real_root = tokio::fs::canonicalize(&root).await.unwrap();
        let from = root.join("a.txt");
        let to = root.join("b.txt");
        tokio::fs::write(&from, "A").await.unwrap();
        tokio::fs::write(&to, "B — MUST SURVIVE").await.unwrap();

        let app = mock_app(vec![real_root]);
        let state = app.state::<AllowedRoots>();
        let err = fs_rename(
            from.to_str().unwrap().to_string(),
            to.to_str().unwrap().to_string(),
            state,
        )
        .await
        .expect_err("an occupied destination must be refused");
        assert!(err.contains("already exists"), "{err}");
        assert_eq!(
            tokio::fs::read_to_string(&to).await.unwrap(),
            "B — MUST SURVIVE",
            "rename(2) would have silently overwritten this"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fs_rename_on_a_symlink_leaving_the_root_moves_the_link_not_its_target() {
        use std::os::unix::fs::symlink;
        let base = tempdir().unwrap();
        let ws = base.path().join("ws");
        let outside = base.path().join("outside");
        tokio::fs::create_dir_all(&ws).await.unwrap();
        tokio::fs::create_dir_all(&outside).await.unwrap();
        let target = outside.join("keep-me.txt");
        tokio::fs::write(&target, "TARGET BYTES").await.unwrap();
        let link = ws.join("link");
        symlink(&target, &link).unwrap();
        let real_ws = tokio::fs::canonicalize(&ws).await.unwrap();

        let app = mock_app(vec![real_ws]);
        let state = app.state::<AllowedRoots>();
        fs_rename(
            link.to_str().unwrap().to_string(),
            ws.join("renamed-link").to_str().unwrap().to_string(),
            state,
        )
        .await
        .unwrap();

        assert!(tokio::fs::symlink_metadata(&link).await.is_err());
        assert!(tokio::fs::symlink_metadata(ws.join("renamed-link"))
            .await
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            tokio::fs::read_to_string(&target).await.unwrap(),
            "TARGET BYTES",
            "the target must not have moved"
        );
        assert!(
            tokio::fs::metadata(outside.join("renamed-link"))
                .await
                .is_err(),
            "nothing may have been created outside the root"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn count_entries_under_counts_recursively_without_following_symlinks() {
        use std::os::unix::fs::symlink;
        let base = tempdir().unwrap();
        let dir = base.path().join("dir");
        let elsewhere = base.path().join("elsewhere");
        tokio::fs::create_dir_all(dir.join("nested")).await.unwrap();
        tokio::fs::create_dir_all(&elsewhere).await.unwrap();
        for n in 0..3 {
            tokio::fs::write(elsewhere.join(format!("{n}.txt")), "x")
                .await
                .unwrap();
        }
        tokio::fs::write(dir.join("a.txt"), "a").await.unwrap();
        tokio::fs::write(dir.join("nested").join("b.txt"), "b")
            .await
            .unwrap();
        symlink(&elsewhere, dir.join("link")).unwrap();

        let result = count_entries_under(&dir, ENTRY_COUNT_CAP).await.unwrap();
        assert_eq!(result.count, 4);
        assert!(!result.capped);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn count_entries_under_does_not_walk_a_symlink_it_is_handed_directly() {
        use std::os::unix::fs::symlink;
        let base = tempdir().unwrap();
        let dir = base.path().join("dir");
        let elsewhere = base.path().join("elsewhere");
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::create_dir_all(elsewhere.join("nested"))
            .await
            .unwrap();
        for n in 0..4 {
            tokio::fs::write(elsewhere.join(format!("{n}.txt")), "x")
                .await
                .unwrap();
        }
        let link = dir.join("link");
        symlink(&elsewhere, &link).unwrap();

        let result = count_entries_under(&link, ENTRY_COUNT_CAP).await.unwrap();
        assert_eq!(
            (result.count, result.capped),
            (0, false),
            "a symlink handed in directly is one entry with no children — the \
             delete takes the link, so the count must describe the link"
        );
    }

    #[tokio::test]
    async fn count_entries_under_reports_exactly_cap_entries_as_exact_not_capped() {
        let base = tempdir().unwrap();
        let dir = base.path().join("dir");
        tokio::fs::create_dir_all(&dir).await.unwrap();
        for n in 0..3 {
            tokio::fs::write(dir.join(format!("{n}.txt")), "x")
                .await
                .unwrap();
        }

        let result = count_entries_under(&dir, 3).await.unwrap();
        assert_eq!(
            (result.count, result.capped, result.cap),
            (3, false, 3),
            "the cap-th entry is the last one that FITS, not the first that overflows"
        );
    }

    #[tokio::test]
    async fn count_entries_under_reports_the_cap_it_stopped_at() {
        let base = tempdir().unwrap();
        let dir = base.path().join("dir");
        tokio::fs::create_dir_all(&dir).await.unwrap();
        for n in 0..5 {
            tokio::fs::write(dir.join(format!("{n}.txt")), "x")
                .await
                .unwrap();
        }

        let result = count_entries_under(&dir, 3).await.unwrap();
        assert_eq!(
            (result.count, result.capped, result.cap),
            (3, true, 3),
            "a capped count must be distinguishable from an exact one, and name the cap"
        );
    }

    #[tokio::test]
    async fn fs_entry_count_is_zero_for_a_plain_file_and_gated_like_the_delete() {
        let base = tempdir().unwrap();
        let root = base.path().join("root");
        let outside = base.path().join("outside");
        tokio::fs::create_dir_all(&root).await.unwrap();
        tokio::fs::create_dir_all(&outside).await.unwrap();
        tokio::fs::write(root.join("f.txt"), "x").await.unwrap();
        let real_root = tokio::fs::canonicalize(&root).await.unwrap();

        let app = mock_app(vec![real_root]);
        let counted = fs_entry_count(
            root.join("f.txt").to_str().unwrap().to_string(),
            app.state::<AllowedRoots>(),
        )
        .await
        .unwrap();
        assert_eq!(counted.count, 0);

        let err = fs_entry_count(
            outside.to_str().unwrap().to_string(),
            app.state::<AllowedRoots>(),
        )
        .await
        .expect_err("outside every root must be refused");
        assert!(err.contains("outside every open workspace root"), "{err}");
    }

    #[test]
    fn sanitize_ext_matches_the_ts_original() {
        assert_eq!(sanitize_ext("PNG"), "png");
        assert_eq!(sanitize_ext(""), "png");
        assert_eq!(sanitize_ext("jpeg-2000!!"), "jpeg2");
        assert_eq!(sanitize_ext("!!!"), "png");
    }

    #[test]
    fn sanitize_ext_strips_path_separators_and_dot_dot() {
        assert_eq!(sanitize_ext("../../etc/passwd"), "etcpa");
        assert_eq!(sanitize_ext("/etc/passwd"), "etcpa");
        assert_eq!(sanitize_ext(".."), "png");
        assert_eq!(sanitize_ext("a/b\\c"), "abc");
    }

    #[test]
    fn save_path_for_is_always_contained_under_the_state_dir() {
        let state_dir = PathBuf::from("/synthetic/state/dir");
        let cases: &[(&str, &str)] = &[
            ("pastes", "png"),
            ("reviews", "diff"),
            ("pastes", "../../../tmp/escaped"),
            ("pastes", "/etc/passwd"),
            ("pastes", ".."),
        ];
        for (dir_name, ext) in cases {
            let path = save_path_for(&state_dir, dir_name, ext, 1_700_000_000_000);
            let suffix = path
                .strip_prefix(state_dir.join(dir_name))
                .unwrap_or_else(|_| {
                    panic!(
                        "save_path_for({dir_name:?}, {ext:?}) did not even nest under \
                         {state_dir:?}/{dir_name}: {path:?}"
                    )
                });
            let components: Vec<_> = suffix.components().collect();
            assert_eq!(
                components.len(),
                1,
                "save_path_for({dir_name:?}, {ext:?}) produced {n} path components after \
                 {state_dir:?}/{dir_name} instead of exactly 1 (a bare filename): {path:?}",
                n = components.len()
            );
            assert_ne!(
                components[0].as_os_str(),
                std::ffi::OsStr::new(".."),
                "save_path_for({dir_name:?}, {ext:?}) let the filename component be \"..\": {path:?}"
            );
        }
    }

    #[tokio::test]
    async fn save_bytes_under_base_writes_inside_the_given_state_dir() {
        let state_dir = tempdir().unwrap();
        let returned = save_bytes_under_base(state_dir.path(), "pastes", "png", &[1, 2, 3])
            .await
            .expect("save must succeed");
        let returned_path = PathBuf::from(&returned);
        let canonical_returned = tokio::fs::canonicalize(&returned_path)
            .await
            .expect("returned path must exist and canonicalize");
        let canonical_state = tokio::fs::canonicalize(state_dir.path())
            .await
            .expect("state dir must exist and canonicalize");
        assert!(
            canonical_returned.starts_with(&canonical_state),
            "save destination {returned:?} escaped the state dir {state_dir:?}",
            state_dir = state_dir.path()
        );
        let content = tokio::fs::read(&returned_path).await.unwrap();
        assert_eq!(content, vec![1, 2, 3]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn save_bytes_under_base_writes_review_text_inside_the_given_state_dir() {
        let state_dir = tempdir().unwrap();
        let returned = save_bytes_under_base(
            state_dir.path(),
            "reviews",
            "diff",
            "diff --git a b\n".as_bytes(),
        )
        .await
        .expect("save must succeed");
        let returned_path = PathBuf::from(&returned);
        let canonical_returned = tokio::fs::canonicalize(&returned_path)
            .await
            .expect("returned path must exist and canonicalize");
        let canonical_state = tokio::fs::canonicalize(state_dir.path())
            .await
            .expect("state dir must exist and canonicalize");
        assert!(
            canonical_returned.starts_with(&canonical_state),
            "save destination {returned:?} escaped the state dir {state_dir:?}",
            state_dir = state_dir.path()
        );
        let content = tokio::fs::read_to_string(&returned_path).await.unwrap();
        assert_eq!(content, "diff --git a b\n");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fs_read_capture_refuses_a_symlink_wearing_a_capture_name() {
        use base64::Engine;

        let tmp = tempfile::tempdir().expect("tempdir");
        let pastes = tmp.path().join("pastes");
        std::fs::create_dir_all(&pastes).expect("pastes dir");
        let secret = tmp.path().join("secret.txt");
        std::fs::write(&secret, b"not a screenshot").expect("secret file");
        let link = pastes.join("1.png");
        std::os::unix::fs::symlink(&secret, &link).expect("symlink");

        let named = capture_path_within(tmp.path(), "pastes", link.to_str().expect("utf8"));
        assert!(named.is_ok(), "the NAME must be acceptable: {named:?}");

        let refused = read_capture_under(tmp.path(), link.to_str().expect("utf8")).await;
        let msg = refused.expect_err("a symlink must be refused");
        assert!(
            msg.contains("symlink"),
            "the refusal must say what it refused and why; got {msg:?}"
        );

        let real = pastes.join("2.png");
        std::fs::write(&real, b"\x89PNG").expect("capture file");
        let ok = read_capture_under(tmp.path(), real.to_str().expect("utf8"))
            .await
            .expect("a real capture must be readable");
        assert_eq!(
            ok,
            base64::engine::general_purpose::STANDARD.encode(b"\x89PNG")
        );
    }

    #[test]
    fn capture_path_within_refuses_everything_that_is_not_one_file_in_pastes() {
        let state_dir = PathBuf::from("/synthetic/state/dir");
        let ok = capture_path_within(&state_dir, "pastes", "/synthetic/state/dir/pastes/1.png")
            .expect("a plain capture filename must be accepted");
        assert_eq!(ok, state_dir.join("pastes").join("1.png"));

        for bad in [
            "/synthetic/state/dir/pastes/../../../etc/shadow",
            "/synthetic/state/dir/pastes/../pastes/1.png",
            "/synthetic/state/dir/pastes/sub/1.png",
            "/synthetic/state/dir/reviews/1.png",
            "/etc/shadow",
            "/synthetic/state/dir/pastes/1.txt",
            "/synthetic/state/dir/pastes/1",
            "/synthetic/state/dir/pastes",
        ] {
            let refused = capture_path_within(&state_dir, "pastes", bad);
            assert!(refused.is_err(), "{bad:?} must be refused, got {refused:?}");
            let msg = refused.unwrap_err();
            assert!(
                msg.contains(bad),
                "the refusal must name what was refused; got {msg:?}"
            );
        }
    }

    #[test]
    fn sanitize_dropped_file_name_keeps_an_ordinary_name_untouched() {
        assert_eq!(sanitize_dropped_file_name("report.pdf"), "report.pdf");
        assert_eq!(sanitize_dropped_file_name("photo.png"), "photo.png");
    }

    #[test]
    fn sanitize_dropped_file_name_strips_a_relative_escape_to_its_final_component() {
        assert_eq!(
            sanitize_dropped_file_name("../../etc/passwd"),
            "passwd",
            "must keep only the final path component, dropping every .. segment"
        );
    }

    #[test]
    fn sanitize_dropped_file_name_strips_an_absolute_path_to_its_final_component() {
        assert_eq!(sanitize_dropped_file_name("/etc/passwd"), "passwd");
    }

    #[test]
    fn sanitize_dropped_file_name_falls_back_on_dot_dot() {
        assert_eq!(sanitize_dropped_file_name(".."), "dropped-file");
    }

    #[test]
    fn sanitize_dropped_file_name_falls_back_on_a_bare_dot() {
        assert_eq!(sanitize_dropped_file_name("."), "dropped-file");
    }

    #[test]
    fn sanitize_dropped_file_name_falls_back_on_an_empty_string() {
        assert_eq!(sanitize_dropped_file_name(""), "dropped-file");
    }

    #[test]
    fn sanitize_dropped_file_name_caps_the_length() {
        let long_name = "a".repeat(500);
        let result = sanitize_dropped_file_name(&long_name);
        assert_eq!(result.len(), 100, "must cap at 100 bytes");
    }

    #[test]
    fn sanitize_dropped_file_name_caps_multibyte_names_by_bytes_not_characters() {
        let wide_name = "\u{6f22}".repeat(200);
        let result = sanitize_dropped_file_name(&wide_name);
        assert!(
            result.len() <= 100,
            "a multibyte name must be capped by byte length, got {} bytes",
            result.len()
        );
        assert_eq!(result.chars().count(), 33);
        assert_eq!(result.len(), 99);
    }

    #[tokio::test]
    async fn copy_dropped_file_under_base_accepts_a_name_that_would_overflow_the_component_limit() {
        let state_dir = tempdir().unwrap();
        let wide_name = format!("{}.txt", "\u{6f22}".repeat(200));
        let file = copy_dropped_file_under_base(state_dir.path(), &wide_name, b"payload")
            .await
            .expect("an over-long name must be capped, not passed through to fail the write");
        assert!(file.starts_with(state_dir.path()));
        assert_eq!(tokio::fs::read(&file).await.unwrap(), b"payload");
    }

    #[tokio::test]
    async fn copy_dropped_file_under_base_stays_inside_the_destination_for_hostile_names() {
        let cases = ["../../etc/passwd", "/etc/passwd", "..", ".", ""];
        for name in cases {
            let state_dir = tempdir().unwrap();
            let file = copy_dropped_file_under_base(state_dir.path(), name, b"payload")
                .await
                .unwrap_or_else(|e| panic!("copy for name {name:?} must succeed: {e}"));

            let canonical_file = tokio::fs::canonicalize(&file).await.unwrap();
            let canonical_root = tokio::fs::canonicalize(state_dir.path()).await.unwrap();
            assert!(
                canonical_file.starts_with(&canonical_root),
                "name {name:?} escaped the destination: {file:?} not under {root:?}",
                root = state_dir.path()
            );
        }
    }

    #[tokio::test]
    async fn copy_dropped_file_under_base_preserves_a_safe_basename_and_writes_the_bytes() {
        let state_dir = tempdir().unwrap();
        let file = copy_dropped_file_under_base(state_dir.path(), "report.pdf", b"hello")
            .await
            .unwrap();
        assert_eq!(
            file.file_name().unwrap().to_str().unwrap(),
            "report.pdf",
            "a safe basename must survive untouched (editor tab title / extension detection)"
        );
        let content = tokio::fs::read(&file).await.unwrap();
        assert_eq!(content, b"hello");
    }

    #[tokio::test]
    async fn copy_dropped_file_under_base_does_not_clobber_two_drops_of_the_same_name() {
        let state_dir = tempdir().unwrap();
        let first = copy_dropped_file_under_base(state_dir.path(), "same.txt", b"first")
            .await
            .unwrap();
        let second = copy_dropped_file_under_base(state_dir.path(), "same.txt", b"second")
            .await
            .unwrap();
        assert_ne!(
            first, second,
            "two drops of the same name must land in distinct paths"
        );
        assert_eq!(tokio::fs::read(&first).await.unwrap(), b"first");
        assert_eq!(tokio::fs::read(&second).await.unwrap(), b"second");
    }

    #[tokio::test]
    async fn a_registered_dropped_file_copy_passes_the_same_gate_fs_read_file_uses() {
        let state_dir = tempdir().unwrap();
        let file = copy_dropped_file_under_base(state_dir.path(), "note.txt", b"hello")
            .await
            .unwrap();

        let roots = AllowedRoots::new();
        register_allowed_root(&file.to_string_lossy(), &roots)
            .await
            .unwrap();

        let snapshot = roots.0.lock().unwrap().clone();
        let resolved =
            crate::fs_allowlist::assert_within_allowed_roots(&file.to_string_lossy(), &snapshot)
                .await
                .expect("a registered dropped-file copy must pass the allowlist gate");
        assert_eq!(resolved, tokio::fs::canonicalize(&file).await.unwrap());
    }

    #[tokio::test]
    async fn falsification_an_unregistered_dropped_file_copy_fails_the_same_gate() {
        let state_dir = tempdir().unwrap();
        let file = copy_dropped_file_under_base(state_dir.path(), "note.txt", b"hello")
            .await
            .unwrap();

        let result =
            crate::fs_allowlist::assert_within_allowed_roots(&file.to_string_lossy(), &[]).await;
        assert!(
            result.is_err(),
            "an unregistered dropped-file copy must be rejected, same as any other path"
        );
    }

    #[test]
    fn dir_entry_serializes_the_expected_camel_case_key_set() {
        let entry = DirEntry {
            name: "a".to_string(),
            path: "/a".to_string(),
            dir: false,
            ignored: false,
        };
        let value = serde_json::to_value(&entry).unwrap();
        let obj = value.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["dir", "ignored", "name", "path"]);
    }

    #[test]
    fn stat_result_serializes_mtime_ms_as_camel_case() {
        let stat = StatResult { mtime_ms: 123.0 };
        let value = serde_json::to_value(&stat).unwrap();
        let obj = value.as_object().unwrap();
        let keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            vec!["mtimeMs"],
            "must be camelCase mtimeMs, not mtime_ms"
        );
    }

    #[test]
    fn falsification_snake_case_would_produce_a_different_key() {
        #[derive(Serialize)]
        struct SnakeCaseStat {
            mtime_ms: f64,
        }
        let value = serde_json::to_value(SnakeCaseStat { mtime_ms: 1.0 }).unwrap();
        let obj = value.as_object().unwrap();
        let keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        assert_eq!(keys, vec!["mtime_ms"]);
        assert_ne!(keys, vec!["mtimeMs"]);
    }

    #[tokio::test]
    async fn fs_set_window_background_accepts_each_extension_and_refuses_a_sixth_by_name() {
        for ext in WINDOW_BACKGROUND_EXTS {
            let state_dir = tempdir().unwrap();
            let src = tempdir().unwrap();
            let source = src.path().join(format!("photo.{ext}"));
            tokio::fs::write(&source, b"image bytes").await.unwrap();
            let slot = set_window_background_under(state_dir.path(), source.to_str().unwrap())
                .await
                .unwrap_or_else(|e| panic!("extension {ext:?} must be accepted: {e}"));
            assert_eq!(
                Path::new(&slot).file_name().unwrap().to_str().unwrap(),
                format!("window-background.{ext}"),
                "the slot must carry the accepted extension"
            );
        }

        let state_dir = tempdir().unwrap();
        let src = tempdir().unwrap();
        let source = src.path().join("photo.bmp");
        tokio::fs::write(&source, b"image bytes").await.unwrap();
        let err = set_window_background_under(state_dir.path(), source.to_str().unwrap())
            .await
            .expect_err("a non-accepted extension must be refused");
        assert!(
            err.contains("bmp"),
            "must name the offending extension: {err}"
        );
        for ext in WINDOW_BACKGROUND_EXTS {
            assert!(err.contains(ext), "must list {ext} as accepted: {err}");
        }
        assert!(
            tokio::fs::metadata(state_dir.path().join("background"))
                .await
                .is_err(),
            "a refused extension must write nothing at all"
        );
    }

    #[tokio::test]
    async fn fs_set_window_background_byte_cap_names_limit_actual_and_nothing_written() {
        let state_dir = tempdir().unwrap();
        let src = tempdir().unwrap();
        let source = src.path().join("big.png");
        std::fs::File::create(&source)
            .unwrap()
            .set_len(WINDOW_BACKGROUND_MAX_BYTES + 1)
            .unwrap();

        let err = set_window_background_under(state_dir.path(), source.to_str().unwrap())
            .await
            .expect_err("a file over the cap must be refused");
        assert!(
            err.contains("window background too large"),
            "must name the refusal: {err}"
        );
        assert!(
            err.contains(&(WINDOW_BACKGROUND_MAX_BYTES + 1).to_string()),
            "must name the actual size: {err}"
        );
        assert!(
            err.contains(&WINDOW_BACKGROUND_MAX_BYTES.to_string()),
            "must name the limit: {err}"
        );
        assert!(err.contains("big.png"), "must name the file: {err}");
        assert!(
            err.contains("nothing was written"),
            "must tell the user nothing was written: {err}"
        );
        assert!(
            tokio::fs::metadata(state_dir.path().join("background"))
                .await
                .is_err(),
            "a cap refusal must write nothing"
        );
    }

    #[test]
    fn window_background_max_bytes_is_pinned_to_32_mib() {
        assert_eq!(WINDOW_BACKGROUND_MAX_BYTES, 32 * 1024 * 1024);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fs_read_window_background_refuses_a_symlink_slot_and_reads_a_regular_one() {
        use std::os::unix::fs::symlink;

        let base = tempdir().unwrap();
        let background = base.path().join("background");
        tokio::fs::create_dir_all(&background).await.unwrap();
        let secret = base.path().join("secret.png");
        tokio::fs::write(&secret, b"SECRET").await.unwrap();
        let link = background.join("window-background.png");
        symlink(&secret, &link).unwrap();

        let err = read_window_background_bytes(&link)
            .await
            .expect_err("a symlink slot must be refused");
        assert!(
            err.contains("symlink"),
            "the refusal must say what it refused and why; got {err:?}"
        );

        let real = background.join("window-background.jpg");
        tokio::fs::write(&real, b"\xFF\xD8real").await.unwrap();
        let bytes = read_window_background_bytes(&real)
            .await
            .expect("a regular slot file must be readable");
        assert_eq!(bytes, b"\xFF\xD8real");
    }

    #[tokio::test]
    async fn fs_set_window_background_with_a_different_extension_leaves_one_slot_file() {
        let state_dir = tempdir().unwrap();
        let src = tempdir().unwrap();

        let png = src.path().join("first.png");
        tokio::fs::write(&png, b"PNG").await.unwrap();
        set_window_background_under(state_dir.path(), png.to_str().unwrap())
            .await
            .unwrap();

        let jpg = src.path().join("second.jpg");
        tokio::fs::write(&jpg, b"JPG").await.unwrap();
        set_window_background_under(state_dir.path(), jpg.to_str().unwrap())
            .await
            .unwrap();
        assert!(settle_window_background_under(state_dir.path(), "new")
            .await
            .unwrap());

        assert_eq!(
            slot_dir_names(state_dir.path()).await,
            vec!["window-background.jpg".to_string()],
            "exactly one slot must remain, carrying the new extension"
        );
    }

    async fn slot_dir_names(state_dir: &Path) -> Vec<String> {
        let dir = state_dir.join("background");
        let mut names: Vec<String> = Vec::new();
        let Ok(mut read_dir) = tokio::fs::read_dir(&dir).await else {
            return names;
        };
        while let Some(entry) = read_dir.next_entry().await.unwrap() {
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
        names.sort();
        names
    }

    async fn set_two_pictures(state_dir: &Path, src: &Path) {
        let png = src.join("first.png");
        tokio::fs::write(&png, b"FIRST").await.unwrap();
        set_window_background_under(state_dir, png.to_str().unwrap())
            .await
            .unwrap();
        let jpg = src.join("second.jpg");
        tokio::fs::write(&jpg, b"SECOND").await.unwrap();
        set_window_background_under(state_dir, jpg.to_str().unwrap())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn a_refused_pick_hands_back_the_previous_picture() {
        let state_dir = tempdir().unwrap();
        let src = tempdir().unwrap();
        set_two_pictures(state_dir.path(), src.path()).await;
        assert_eq!(
            slot_dir_names(state_dir.path()).await,
            vec![
                "window-background-previous.png".to_string(),
                "window-background.jpg".to_string()
            ],
            "the first picture must be parked while the second awaits its checks"
        );
        assert!(
            window_background_info_under(state_dir.path())
                .await
                .unwrap()
                .unwrap()
                .filename
                == "window-background.jpg",
            "the parked file must never read as the slot"
        );

        assert!(settle_window_background_under(state_dir.path(), "previous")
            .await
            .unwrap());
        assert_eq!(
            slot_dir_names(state_dir.path()).await,
            vec!["window-background.png".to_string()]
        );
        let slot = find_window_background_slot(state_dir.path())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(tokio::fs::read(&slot).await.unwrap(), b"FIRST");
    }

    #[tokio::test]
    async fn settling_an_empty_slot_reports_no_picture() {
        let state_dir = tempdir().unwrap();
        assert!(
            !settle_window_background_under(state_dir.path(), "previous")
                .await
                .unwrap()
        );
        assert!(!settle_window_background_under(state_dir.path(), "new")
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn settling_refuses_an_unknown_keep_by_name() {
        let state_dir = tempdir().unwrap();
        let err = settle_window_background_under(state_dir.path(), "old")
            .await
            .unwrap_err();
        assert!(
            err.contains("\"old\"") && err.contains("\"new\"") && err.contains("\"previous\""),
            "{err}"
        );
    }

    #[tokio::test]
    async fn remove_sweeps_the_parked_picture_too() {
        let state_dir = tempdir().unwrap();
        let src = tempdir().unwrap();
        set_two_pictures(state_dir.path(), src.path()).await;
        remove_window_background_under(state_dir.path())
            .await
            .unwrap();
        assert!(slot_dir_names(state_dir.path()).await.is_empty());
    }

    #[tokio::test]
    async fn fs_remove_window_background_is_idempotent() {
        let state_dir = tempdir().unwrap();
        assert!(remove_window_background_under(state_dir.path())
            .await
            .is_ok());

        let src = tempdir().unwrap();
        let source = src.path().join("bg.png");
        tokio::fs::write(&source, b"x").await.unwrap();
        set_window_background_under(state_dir.path(), source.to_str().unwrap())
            .await
            .unwrap();
        assert!(remove_window_background_under(state_dir.path())
            .await
            .is_ok());
        assert!(remove_window_background_under(state_dir.path())
            .await
            .is_ok());
        assert!(
            tokio::fs::metadata(state_dir.path().join("background"))
                .await
                .is_err()
                || tokio::fs::read_dir(state_dir.path().join("background"))
                    .await
                    .unwrap()
                    .next_entry()
                    .await
                    .unwrap()
                    .is_none(),
            "the slot must be gone after removal"
        );
    }

    #[tokio::test]
    async fn fs_window_background_info_reports_none_then_the_set_details() {
        let state_dir = tempdir().unwrap();
        assert_eq!(
            window_background_info_under(state_dir.path())
                .await
                .unwrap(),
            None,
            "an empty slot must be None"
        );

        let src = tempdir().unwrap();
        let source = src.path().join("photo.png");
        let content = b"0123456789";
        tokio::fs::write(&source, content).await.unwrap();
        set_window_background_under(state_dir.path(), source.to_str().unwrap())
            .await
            .unwrap();

        let info = window_background_info_under(state_dir.path())
            .await
            .unwrap()
            .expect("a set slot must be Some");
        assert_eq!(info.filename, "window-background.png");
        assert_eq!(info.size, content.len() as u64);
        assert_eq!(info.ext, "png");
    }

    #[tokio::test]
    async fn fs_read_window_background_resolves_the_slot_and_cannot_be_pointed_elsewhere() {
        let base = tempdir().unwrap();
        let background = base.path().join("background");
        tokio::fs::create_dir_all(&background).await.unwrap();
        tokio::fs::write(background.join("window-background.png"), b"THE SLOT")
            .await
            .unwrap();
        tokio::fs::write(background.join("other.png"), b"DECOY IN SLOT DIR")
            .await
            .unwrap();
        let outside = base.path().join("elsewhere");
        tokio::fs::create_dir_all(&outside).await.unwrap();
        tokio::fs::write(outside.join("window-background.png"), b"DECOY ELSEWHERE")
            .await
            .unwrap();

        let slot = find_window_background_slot(base.path())
            .await
            .unwrap()
            .expect("the real slot must be found");
        assert_eq!(
            slot.file_name().unwrap().to_str().unwrap(),
            "window-background.png",
            "must pick the fixed-stem slot, not a decoy"
        );
        assert!(
            slot.starts_with(&background),
            "the slot must be inside the background directory"
        );
        assert_eq!(
            tokio::fs::read(&slot).await.unwrap(),
            b"THE SLOT",
            "must read the real slot's bytes, never a decoy"
        );
    }
}
