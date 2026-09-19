use std::path::PathBuf;
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_dialog::{DialogExt, FilePath};

use crate::fs_allowlist::{register_allowed_root, AllowedRoots};

async fn await_pick<F>(register: F) -> Result<Option<PathBuf>, String>
where
    F: FnOnce(Box<dyn FnOnce(Result<Option<PathBuf>, String>) + Send>),
{
    let (tx, rx) = tokio::sync::oneshot::channel();
    register(Box::new(move |result| {
        let _ = tx.send(result);
    }));
    rx.await.map_err(|_| {
        "dialog callback was dropped without firing: the native picker's \
         run_on_main_thread dispatch failed, so no result (not even a \
         cancel) was ever produced"
            .to_string()
    })?
}

async fn await_pick_many<F>(register: F) -> Result<Option<Vec<PathBuf>>, String>
where
    F: FnOnce(Box<dyn FnOnce(Result<Option<Vec<PathBuf>>, String>) + Send>),
{
    let (tx, rx) = tokio::sync::oneshot::channel();
    register(Box::new(move |result| {
        let _ = tx.send(result);
    }));
    rx.await.map_err(|_| {
        "dialog callback was dropped without firing: the native picker's \
         run_on_main_thread dispatch failed, so no result (not even a \
         cancel) was ever produced"
            .to_string()
    })?
}

fn starting_directory(default_path: &str) -> Option<&str> {
    if default_path.is_empty() {
        None
    } else {
        Some(default_path)
    }
}

fn to_pick_result(command: &str, picked: Option<FilePath>) -> Result<Option<PathBuf>, String> {
    match picked {
        Some(file_path) => file_path
            .into_path()
            .map(Some)
            .map_err(|e| format!("{command}: selected path is not a filesystem path: {e}")),
        None => Ok(None),
    }
}

async fn register_and_return(
    picked: Option<PathBuf>,
    roots: &AllowedRoots,
) -> Result<Option<String>, String> {
    let Some(path) = picked else {
        return Ok(None);
    };
    let verbatim = path.to_string_lossy().into_owned();
    register_allowed_root(&verbatim, roots).await?;
    Ok(Some(verbatim))
}

async fn register_and_return_many(
    picked: Option<Vec<PathBuf>>,
    roots: &AllowedRoots,
) -> Result<Option<Vec<String>>, String> {
    let Some(paths) = picked else {
        return Ok(None);
    };
    if paths.is_empty() {
        return Ok(None);
    }
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        let verbatim = path.to_string_lossy().into_owned();
        register_allowed_root(&verbatim, roots).await?;
        out.push(verbatim);
    }
    Ok(Some(out))
}

fn to_pick_results(
    command: &str,
    picked: Option<Vec<FilePath>>,
) -> Result<Option<Vec<PathBuf>>, String> {
    let Some(paths) = picked else {
        return Ok(None);
    };
    paths
        .into_iter()
        .map(|file_path| {
            let shown = file_path.to_string();
            file_path.into_path().map_err(|e| {
                format!("{command}: selected path {shown:?} is not a filesystem path: {e}")
            })
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

#[tauri::command]
pub async fn dialog_pick_directory<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AllowedRoots>,
) -> Result<Option<String>, String> {
    let picked = await_pick(|cb| {
        app.dialog()
            .file()
            .pick_folder(move |file_path| cb(to_pick_result("dialog_pick_directory", file_path)));
    })
    .await?;
    register_and_return(picked, state.inner()).await
}

#[tauri::command]
pub async fn dialog_pick_directories<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AllowedRoots>,
) -> Result<Option<Vec<String>>, String> {
    let picked = await_pick_many(|cb| {
        app.dialog()
            .file()
            .set_title("Choose folders to add as workspaces")
            .pick_folders(move |file_paths| {
                cb(to_pick_results("dialog_pick_directories", file_paths))
            });
    })
    .await?;
    register_and_return_many(picked, state.inner()).await
}

#[tauri::command]
pub async fn dialog_pick_file<R: Runtime>(
    default_path: String,
    app: AppHandle<R>,
    state: State<'_, AllowedRoots>,
) -> Result<Option<String>, String> {
    let picked = await_pick(|cb| {
        let mut builder = app.dialog().file();
        if let Some(dir) = starting_directory(&default_path) {
            builder = builder.set_directory(dir);
        }
        builder.pick_file(move |file_path| cb(to_pick_result("dialog_pick_file", file_path)));
    })
    .await?;
    register_and_return(picked, state.inner()).await
}

#[tauri::command]
pub async fn dialog_pick_image<R: Runtime>(app: AppHandle<R>) -> Result<Option<PathBuf>, String> {
    let picked = await_pick(|cb| {
        app.dialog()
            .file()
            .add_filter("Images", &["png", "jpg", "jpeg", "webp", "gif"])
            .pick_file(move |file_path| cb(to_pick_result("dialog_pick_image", file_path)));
    })
    .await?;
    Ok(picked)
}

pub const CHAT_IMAGE_MAX_BYTES: u64 = 32 * 1024 * 1024;

pub fn image_default_name(url: &str) -> String {
    let tail = url
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .rsplit('/')
        .next()
        .unwrap_or("");
    let cleaned: String = tail
        .chars()
        .filter(|c| {
            *c != '/' && *c != '\\' && *c != '\0' && !c.is_control() && *c != ':' && *c != '"'
        })
        .take(96)
        .collect();
    let cleaned = cleaned.trim_matches(['.', ' ']).to_string();
    if cleaned.is_empty() {
        "image.png".to_string()
    } else {
        cleaned
    }
}

fn http_url(url: &str) -> Result<(), String> {
    let scheme = url.split("://").next().unwrap_or("");
    if !url.contains("://") || (scheme != "http" && scheme != "https") {
        return Err(format!(
            "only http and https images can be saved; got {url:?}. Use Open to hand it to the \
             browser instead."
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn dialog_save_image_url<R: Runtime>(
    url: String,
    app: AppHandle<R>,
) -> Result<Option<String>, String> {
    http_url(&url)?;
    let default_name = image_default_name(&url);

    let picked = await_pick(|cb| {
        app.dialog()
            .file()
            .set_title("Save image")
            .set_file_name(&default_name)
            .save_file(move |file_path| cb(to_pick_result("dialog_save_image_url", file_path)));
    })
    .await?;
    let Some(path) = picked else {
        return Ok(None);
    };

    let response = reqwest::get(&url)
        .await
        .map_err(|e| format!("fetching {url}: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "fetching {url}: the server answered {}",
            response.status()
        ));
    }
    if let Some(len) = response.content_length() {
        if len > CHAT_IMAGE_MAX_BYTES {
            return Err(format!(
                "that image is {len} bytes; the limit is {CHAT_IMAGE_MAX_BYTES} \
                 (CHAT_IMAGE_MAX_BYTES). Nothing was written."
            ));
        }
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("reading {url}: {e}"))?;
    if bytes.len() as u64 > CHAT_IMAGE_MAX_BYTES {
        return Err(format!(
            "that image is {} bytes; the limit is {CHAT_IMAGE_MAX_BYTES} \
             (CHAT_IMAGE_MAX_BYTES). Nothing was written.",
            bytes.len()
        ));
    }
    tokio::fs::write(&path, &bytes)
        .await
        .map_err(|e| format!("writing {}: {e}", path.display()))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[cfg(unix)]
    use std::os::unix::fs::symlink;
    use tempfile::tempdir;

    #[cfg(unix)]
    #[tokio::test]
    async fn a_picked_path_is_returned_verbatim_while_its_resolved_form_is_registered() {
        let base = tempdir().unwrap();
        let real_dir = base.path().join("real-target");
        let link = base.path().join("via-symlink");
        std::fs::create_dir_all(&real_dir).unwrap();
        symlink(&real_dir, &link).unwrap();

        let roots = AllowedRoots::new();
        let returned = register_and_return(Some(link.clone()), &roots)
            .await
            .unwrap();

        assert_eq!(
            returned,
            Some(link.to_string_lossy().into_owned()),
            "the returned path must be the symlink path verbatim, not resolved"
        );
        let expected_real = std::fs::canonicalize(&real_dir).unwrap();
        let guard = roots.0.lock().unwrap();
        assert_eq!(
            guard.as_slice(),
            &[expected_real],
            "the registered root must be the resolved real target, not the symlink"
        );
    }

    #[tokio::test]
    async fn a_cancelled_dialog_returns_none_and_registers_nothing() {
        let roots = AllowedRoots::new();
        let returned = register_and_return(None, &roots).await.unwrap();

        assert_eq!(returned, None);
        let guard = roots.0.lock().unwrap();
        assert!(
            guard.is_empty(),
            "cancel must not register any root, found: {guard:?}"
        );
    }

    #[tokio::test]
    async fn re_picking_the_same_path_twice_does_not_duplicate_the_root() {
        let base = tempdir().unwrap();
        let picked_dir = base.path().join("chosen");
        std::fs::create_dir_all(&picked_dir).unwrap();

        let roots = AllowedRoots::new();
        register_and_return(Some(picked_dir.clone()), &roots)
            .await
            .unwrap();
        register_and_return(Some(picked_dir.clone()), &roots)
            .await
            .unwrap();

        let guard = roots.0.lock().unwrap();
        assert_eq!(guard.len(), 1, "re-picking must not duplicate the root");
    }

    #[tokio::test]
    async fn await_pick_resolves_ok_some_when_the_callback_fires_with_a_path() {
        let path = PathBuf::from("/tmp/whatever-was-picked");
        let picked = await_pick(|cb| cb(Ok(Some(path.clone())))).await.unwrap();
        assert_eq!(picked, Some(path));
    }

    #[tokio::test]
    async fn await_pick_resolves_ok_none_when_the_callback_fires_with_a_cancel() {
        let picked = await_pick(|cb| cb(Ok(None))).await.unwrap();
        assert_eq!(picked, None);
    }

    #[tokio::test]
    async fn await_pick_propagates_a_named_error_from_the_callback() {
        let err = await_pick(|cb| cb(Err("boom".to_string())))
            .await
            .expect_err("callback error must propagate");
        assert_eq!(err, "boom");
    }

    #[test]
    fn starting_directory_treats_an_empty_default_path_as_unset() {
        assert_eq!(
            starting_directory(""),
            None,
            "an empty default_path (SshConnectModal.tsx:112's pickFile('')) must mean unset, not Some(\"\")"
        );
        assert_eq!(starting_directory("/some/dir"), Some("/some/dir"));
    }

    #[tokio::test]
    async fn many_registers_every_picked_root_and_returns_them_in_order() {
        let base = tempdir().unwrap();
        let a = base.path().join("alpha");
        let b = base.path().join("beta");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();

        let roots = AllowedRoots::new();
        let returned = register_and_return_many(Some(vec![a.clone(), b.clone()]), &roots)
            .await
            .unwrap();

        assert_eq!(
            returned,
            Some(vec![
                a.to_string_lossy().into_owned(),
                b.to_string_lossy().into_owned()
            ]),
            "the picker's order must survive"
        );
        let guard = roots.0.lock().unwrap();
        assert_eq!(guard.len(), 2, "both roots must register, found: {guard:?}");
    }

    #[tokio::test]
    async fn many_treats_a_cancel_and_an_empty_selection_alike_and_registers_nothing() {
        let roots = AllowedRoots::new();
        assert_eq!(register_and_return_many(None, &roots).await.unwrap(), None);
        assert_eq!(
            register_and_return_many(Some(Vec::new()), &roots)
                .await
                .unwrap(),
            None,
            "an empty selection is not a folder to add"
        );
        assert!(roots.0.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn await_pick_many_propagates_a_named_error_and_survives_a_dropped_callback() {
        let err = await_pick_many(|cb| cb(Err("boom".to_string())))
            .await
            .expect_err("callback error must propagate");
        assert_eq!(err, "boom");

        let dropped = await_pick_many(drop)
            .await
            .expect_err("a dropped callback must be an Err, never Ok(None)");
        assert!(
            dropped.contains("dropped without firing"),
            "error should name what happened: {dropped}"
        );
    }

    #[tokio::test]
    async fn a_dropped_callback_becomes_a_named_error_not_a_panic_and_not_none() {
        let result = await_pick(|cb| {
            drop(cb);
        })
        .await;

        let err = result.expect_err("a dropped callback must be an Err, never Ok(None)");
        assert!(
            err.contains("dropped without firing"),
            "error should name what happened: {err}"
        );
    }
}

#[cfg(test)]
mod save_image_tests {
    use super::*;

    #[test]
    fn only_http_and_https_are_savable() {
        assert!(http_url("https://example.test/a.png").is_ok());
        assert!(http_url("http://example.test/a.png").is_ok());
        for bad in [
            "file:///etc/passwd",
            "data:image/png;base64,AAAA",
            "ftp://example.test/a.png",
            "/etc/passwd",
            "example.test/a.png",
        ] {
            let err = http_url(bad).expect_err(bad);
            assert!(err.contains(bad), "{err}");
            assert!(err.contains("Open"), "{err}");
        }
    }

    #[test]
    fn the_default_name_is_the_urls_last_segment() {
        assert_eq!(
            image_default_name("https://x.test/a/banner_2.png"),
            "banner_2.png"
        );
        assert_eq!(
            image_default_name("https://x.test/shot.png?w=800#top"),
            "shot.png"
        );
    }

    #[test]
    fn a_hostile_url_cannot_smuggle_a_path_into_the_name() {
        assert_eq!(
            image_default_name("https://x.test/a/../../etc/passwd"),
            "passwd"
        );
        assert!(!image_default_name("https://x.test/a%00b\u{7f}.png").contains('\u{7f}'));
        for url in [
            "https://x.test/",
            "https://x.test/...",
            "https://x.test",
            "https://x.test/   ",
        ] {
            let name = image_default_name(url);
            assert!(!name.is_empty(), "{url} -> {name:?}");
            assert!(!name.chars().all(|c| c == '.'), "{url} -> {name:?}");
        }
    }

    #[test]
    fn the_size_cap_is_the_constant() {
        assert_eq!(CHAT_IMAGE_MAX_BYTES, 32 * 1024 * 1024);
    }
}
