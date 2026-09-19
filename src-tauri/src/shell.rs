use std::path::Path;
use std::path::PathBuf;

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathOpenResult {
    pub ok: bool,
    pub error: Option<String>,
}

impl PathOpenResult {
    fn ok() -> Self {
        Self {
            ok: true,
            error: None,
        }
    }

    fn err(error: String) -> Self {
        Self {
            ok: false,
            error: Some(error),
        }
    }
}

fn expand_tilde(input: &str) -> Result<PathBuf, String> {
    if input == "~" {
        return houston_core::home_dir::home_dir().ok_or_else(|| {
            "cannot resolve home directory (expected $HOME or a platform equivalent to be set)"
                .to_string()
        });
    }
    if let Some(rest) = input.strip_prefix("~/") {
        let home = houston_core::home_dir::home_dir().ok_or_else(|| {
            "cannot resolve home directory (expected $HOME or a platform equivalent to be set)"
                .to_string()
        })?;
        return Ok(home.join(rest));
    }
    Ok(PathBuf::from(input))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExpectedKind {
    Directory,
    File,
}

impl ExpectedKind {
    fn label(self) -> &'static str {
        match self {
            ExpectedKind::Directory => "a directory",
            ExpectedKind::File => "a file",
        }
    }

    fn matches(self, meta: &std::fs::Metadata) -> bool {
        match self {
            ExpectedKind::Directory => meta.is_dir(),
            ExpectedKind::File => meta.is_file(),
        }
    }
}

#[cfg(unix)]
async fn run_open_command(program: &str, path: &Path) -> Result<(), String> {
    let output = houston_core::spawn::tokio_command(program)
        .arg(path)
        .output()
        .await
        .map_err(|e| format!("failed to spawn {program} for path {path:?}: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!(
            "{program} exited with status {:?} for path {path:?}: {}",
            output.status.code(),
            stderr.trim()
        ))
    }
}

#[cfg(windows)]
fn shell_execute_open(target: &std::ffi::OsStr) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt as _;
    use windows_sys::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED,
    };
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    const RPC_E_CHANGED_MODE: i32 = -2147417850;

    let mut wide: Vec<u16> = target.encode_wide().collect();
    if wide.contains(&0) {
        return Err(format!(
            "refusing to open a target containing an interior NUL: {target:?}"
        ));
    }
    wide.push(0);
    let verb: Vec<u16> = "open\0".encode_utf16().collect();

    // SAFETY: `verb`/`wide` are NUL-terminated wide buffers that outlive this
    // call; `CoUninitialize` only runs when the matching `CoInitializeEx` won.
    let (hr, rc) = unsafe {
        let hr = CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32);
        let rc = ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            wide.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        );
        if hr >= 0 {
            CoUninitialize();
        }
        (hr, rc as isize)
    };
    if hr < 0 && hr != RPC_E_CHANGED_MODE {
        return Err(format!(
            "could not initialize COM to open {target:?} (CoInitializeEx returned {hr:#x})"
        ));
    }

    if rc > 32 {
        return Ok(());
    }
    let reason = match rc {
        0 | 8 => "the system is out of memory or resources",
        2 => "the file was not found",
        3 => "the path was not found",
        5 => "access was denied",
        26 => "a sharing violation occurred",
        27 => "the file association is incomplete or invalid",
        28 => "the DDE request timed out",
        29 => "the DDE request failed",
        30 => "the DDE request is busy",
        31 => "no application is associated with this file type",
        32 => "the associated application could not be run",
        _ => "the shell refused to open it",
    };
    Err(format!(
        "could not open {target:?}: {reason} (ShellExecuteW returned {rc})"
    ))
}

async fn open_target(target: &std::ffi::OsStr) -> Result<(), String> {
    #[cfg(windows)]
    {
        let owned = target.to_os_string();
        tokio::task::spawn_blocking(move || shell_execute_open(&owned))
            .await
            .map_err(|e| format!("the shell-open task failed to run: {e}"))?
    }
    #[cfg(not(windows))]
    {
        run_open_command("xdg-open", Path::new(target)).await
    }
}

async fn open_checked(raw: &str, expected: ExpectedKind) -> PathOpenResult {
    open_checked_via(
        raw,
        expected,
        |target| async move { open_target(&target).await },
    )
    .await
}

async fn open_checked_via<F, Fut>(raw: &str, expected: ExpectedKind, open: F) -> PathOpenResult
where
    F: FnOnce(std::ffi::OsString) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    let path = match resolve_and_check(raw, expected).await {
        Ok(p) => p,
        Err(e) => return PathOpenResult::err(e),
    };
    match open(path.into_os_string()).await {
        Ok(()) => PathOpenResult::ok(),
        Err(e) => PathOpenResult::err(e),
    }
}

async fn resolve_and_check(raw: &str, expected: ExpectedKind) -> Result<PathBuf, String> {
    let path = expand_tilde(raw)?;
    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("not found: {} ({e})", path.display()))?;
    if !expected.matches(&meta) {
        return Err(format!(
            "expected {}, got {}",
            expected.label(),
            path.display()
        ));
    }
    Ok(path)
}

#[tauri::command]
pub async fn shell_show_item_in_folder(full_path: String) -> PathOpenResult {
    open_checked(&full_path, ExpectedKind::Directory).await
}

#[tauri::command]
pub async fn shell_open_media_file(full_path: String) -> PathOpenResult {
    open_checked(&full_path, ExpectedKind::File).await
}

pub(crate) fn is_http_or_https(url: &str) -> bool {
    let lower_prefix_matches = |scheme: &str| {
        url.len() >= scheme.len()
            && url.as_bytes()[..scheme.len()].eq_ignore_ascii_case(scheme.as_bytes())
    };
    lower_prefix_matches("http://") || lower_prefix_matches("https://")
}

#[tauri::command]
pub async fn shell_open_external(url: String) -> Result<(), String> {
    if !is_http_or_https(&url) {
        return Err(format!(
            "shell_open_external: url must start with http:// or https:// (case-insensitive), \
             got {url:?}"
        ));
    }
    open_target(std::ffi::OsStr::new(&url)).await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct EditorSpec {
    id: &'static str,
    label: &'static str,
    goto_flag: bool,
}

const EDITOR_CANDIDATES: &[EditorSpec] = &[
    EditorSpec {
        id: "code",
        label: "VS Code",
        goto_flag: true,
    },
    EditorSpec {
        id: "code-insiders",
        label: "VS Code Insiders",
        goto_flag: true,
    },
    EditorSpec {
        id: "codium",
        label: "VSCodium",
        goto_flag: true,
    },
    EditorSpec {
        id: "cursor",
        label: "Cursor",
        goto_flag: true,
    },
    EditorSpec {
        id: "zed",
        label: "Zed",
        goto_flag: false,
    },
    EditorSpec {
        id: "windsurf",
        label: "Windsurf",
        goto_flag: true,
    },
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorTarget {
    pub id: String,
    pub label: String,
}

fn goto_argument(path: &Path, line: Option<u32>, col: Option<u32>) -> std::ffi::OsString {
    let mut arg = path.as_os_str().to_os_string();
    if let Some(line) = line {
        arg.push(format!(":{line}"));
        if let Some(col) = col {
            arg.push(format!(":{col}"));
        }
    }
    arg
}

fn find_editor(id: &str) -> Result<&'static EditorSpec, String> {
    EDITOR_CANDIDATES
        .iter()
        .find(|s| s.id == id)
        .ok_or_else(|| {
            format!(
                "unknown editor {id:?} (expected one of: {})",
                EDITOR_CANDIDATES
                    .iter()
                    .map(|s| s.id)
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
}

#[tauri::command]
pub async fn shell_list_editors() -> Vec<EditorTarget> {
    EDITOR_CANDIDATES
        .iter()
        .filter(|spec| houston_core::exe_path::resolve(spec.id).is_some())
        .map(|spec| EditorTarget {
            id: spec.id.to_string(),
            label: spec.label.to_string(),
        })
        .collect()
}

#[tauri::command]
pub async fn shell_open_in_editor(
    editor: String,
    path: String,
    line: Option<u32>,
    col: Option<u32>,
    state: tauri::State<'_, crate::fs_allowlist::AllowedRoots>,
) -> Result<(), String> {
    let spec = find_editor(&editor)?;
    let roots = {
        let guard = state
            .0
            .lock()
            .map_err(|_| "allowed-roots lock poisoned".to_string())?;
        guard.clone()
    };
    let real = crate::fs_allowlist::assert_within_allowed_roots(&path, &roots).await?;
    let program = houston_core::exe_path::resolve(spec.id).ok_or_else(|| {
        format!(
            "cannot open {path} in {}: no {:?} binary on PATH (expected an executable named {:?} \
             in one of the PATH directories)",
            spec.label, spec.id, spec.id
        )
    })?;
    let arg = goto_argument(&real, line, col);
    let mut cmd = houston_core::spawn::command(&program);
    if spec.goto_flag {
        cmd.arg("--goto");
    }
    cmd.arg(&arg);
    cmd.spawn().map(|_| ()).map_err(|e| {
        format!(
            "cannot open {path} in {}: failed to spawn {} ({e})",
            spec.label,
            program.display()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expand_tilde_resolves_bare_tilde_and_tilde_slash() {
        let home =
            houston_core::home_dir::home_dir().expect("test host must have a resolvable home dir");
        assert_eq!(expand_tilde("~").unwrap(), home);
        assert_eq!(
            expand_tilde("~/.houston/memory").unwrap(),
            home.join(".houston/memory")
        );
    }

    #[test]
    fn expand_tilde_leaves_absolute_paths_untouched() {
        assert_eq!(
            expand_tilde("/etc/shells").unwrap(),
            PathBuf::from("/etc/shells")
        );
    }

    #[test]
    fn expand_tilde_does_not_touch_a_word_merely_containing_tilde() {
        assert_eq!(expand_tilde("~foo/bar").unwrap(), PathBuf::from("~foo/bar"));
    }

    #[test]
    fn scheme_check_accepts_http_and_https_case_insensitively() {
        assert!(is_http_or_https("http://example.com"));
        assert!(is_http_or_https("HTTPS://example.com"));
        assert!(is_http_or_https("HtTp://example.com"));
    }

    #[test]
    fn goto_argument_appends_only_what_it_was_given() {
        let p = Path::new("/ws/src/main.rs");
        assert_eq!(goto_argument(p, None, None), "/ws/src/main.rs");
        assert_eq!(goto_argument(p, Some(12), None), "/ws/src/main.rs:12");
        assert_eq!(goto_argument(p, Some(12), Some(5)), "/ws/src/main.rs:12:5");
        assert_eq!(goto_argument(p, None, Some(5)), "/ws/src/main.rs");
    }

    #[test]
    fn every_editor_candidate_has_a_distinct_id_and_a_label() {
        let mut ids: Vec<&str> = EDITOR_CANDIDATES.iter().map(|s| s.id).collect();
        let count = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), count, "duplicate editor id in EDITOR_CANDIDATES");
        assert!(EDITOR_CANDIDATES.iter().all(|s| !s.label.is_empty()));
    }

    #[test]
    fn find_editor_accepts_a_candidate_and_names_the_whole_set_on_a_miss() {
        assert_eq!(find_editor("zed").unwrap().label, "Zed");
        let err = find_editor("emacs").unwrap_err();
        assert!(err.contains("emacs"), "{err}");
        for spec in EDITOR_CANDIDATES {
            assert!(err.contains(spec.id), "{err} is missing {}", spec.id);
        }
    }

    #[test]
    fn only_the_vs_code_family_takes_the_goto_flag() {
        let flagged: Vec<&str> = EDITOR_CANDIDATES
            .iter()
            .filter(|s| s.goto_flag)
            .map(|s| s.id)
            .collect();
        assert_eq!(
            flagged,
            vec!["code", "code-insiders", "codium", "cursor", "windsurf"]
        );
    }

    #[test]
    fn scheme_check_rejects_everything_else() {
        assert!(!is_http_or_https("file:///etc/passwd"));
        assert!(!is_http_or_https("javascript:alert(1)"));
        assert!(!is_http_or_https("ftp://example.com"));
        assert!(!is_http_or_https(""));
        assert!(!is_http_or_https("http"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_open_command_maps_a_zero_exit_to_ok() {
        run_open_command("/usr/bin/true", &std::env::temp_dir())
            .await
            .expect("a program that exits 0 must map to Ok");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_open_command_maps_a_nonzero_exit_to_err_naming_the_path() {
        let err = run_open_command("/usr/bin/false", Path::new("/tmp/some-target"))
            .await
            .expect_err("a program that exits nonzero must map to Err");
        assert!(
            err.contains("/tmp/some-target"),
            "error must name the offending path: {err}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_open_command_maps_a_missing_program_to_err() {
        let err = run_open_command("/no/such/program-xyz", Path::new("/tmp"))
            .await
            .expect_err("a nonexistent program must map to Err, not panic");
        assert!(err.contains("/no/such/program-xyz"));
    }

    #[cfg(windows)]
    #[test]
    fn shell_execute_refuses_an_interior_nul() {
        use std::os::windows::ffi::OsStringExt as _;
        let sneaky = std::ffi::OsString::from_wide(&[0x43, 0x3a, 0x5c, 0x61, 0x00, 0x62]);
        let err = shell_execute_open(&sneaky).expect_err("an interior NUL must be refused");
        assert!(
            err.contains("interior NUL"),
            "the refusal must name the reason: {err}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn shell_execute_maps_a_missing_target_to_a_named_error() {
        let missing =
            std::ffi::OsString::from("C:\\tr-no-such-dir-9f3a\\tr-no-such-file-9f3a.zzzqqq");
        let err = shell_execute_open(&missing).expect_err("a missing target must map to Err");
        assert!(
            err.contains("tr-no-such-file-9f3a"),
            "the error must name the target: {err}"
        );
        assert!(
            err.contains("ShellExecuteW returned"),
            "the error must carry the raw status for diagnosis: {err}"
        );
    }

    #[tokio::test]
    async fn show_item_in_folder_rejects_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("not-a-dir.txt");
        tokio::fs::write(&file, b"x").await.unwrap();

        let result = open_checked(file.to_str().unwrap(), ExpectedKind::Directory).await;
        assert!(
            !result.ok,
            "a file must be rejected by the directory-only check"
        );
        assert!(
            result.error.as_deref().unwrap().contains("a directory"),
            "error must name what was expected: {:?}",
            result.error
        );
    }

    #[tokio::test]
    async fn open_media_file_rejects_a_directory() {
        let dir = std::env::temp_dir().join(format!("tr-shell-dir-{}", std::process::id()));
        let _ = tokio::fs::create_dir_all(&dir).await;

        let result = open_checked(dir.to_str().unwrap(), ExpectedKind::File).await;
        assert!(
            !result.ok,
            "a directory must be rejected by the file-only check"
        );
        assert!(
            result.error.as_deref().unwrap().contains("a file"),
            "error must name what was expected: {:?}",
            result.error
        );
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn open_checked_rejects_a_nonexistent_path() {
        let result = open_checked("/no/such/path-abc-xyz", ExpectedKind::Directory).await;
        assert!(!result.ok);
        assert!(result.error.as_deref().unwrap().contains("not found"));
    }

    #[tokio::test]
    async fn resolve_and_check_accepts_a_matching_directory() {
        let dir = tempfile::tempdir().unwrap();
        let resolved = resolve_and_check(dir.path().to_str().unwrap(), ExpectedKind::Directory)
            .await
            .expect("an existing directory must pass the directory-only check");
        assert_eq!(resolved, dir.path());
    }

    #[tokio::test]
    async fn open_checked_propagates_an_opener_failure() {
        let dir = tempfile::tempdir().unwrap();
        let result = open_checked_via(
            dir.path().to_str().unwrap(),
            ExpectedKind::Directory,
            |_target| async { Err("the shell said no".to_string()) },
        )
        .await;
        assert!(!result.ok, "a failing opener must surface as ok:false");
        assert_eq!(result.error.as_deref(), Some("the shell said no"));
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "opens a real Explorer window; run explicitly with --ignored"]
    fn shell_execute_opens_a_real_directory() {
        let dir = tempfile::tempdir().unwrap();
        shell_execute_open(dir.path().as_os_str())
            .expect("the shell must accept an existing directory");
        std::thread::sleep(std::time::Duration::from_millis(1500));
    }

    #[tokio::test]
    async fn open_checked_reports_ok_when_the_opener_succeeds() {
        let dir = tempfile::tempdir().unwrap();
        let result = open_checked_via(
            dir.path().to_str().unwrap(),
            ExpectedKind::Directory,
            |target| async move {
                assert!(!target.is_empty(), "the opener receives the resolved path");
                Ok(())
            },
        )
        .await;
        assert!(result.ok, "a successful opener must surface as ok:true");
        assert_eq!(result.error, None);
    }

    #[test]
    fn path_open_result_serializes_camel_case_keys() {
        let value = serde_json::to_value(PathOpenResult::err("boom".into())).unwrap();
        let mut keys: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["error", "ok"]);
    }

    #[tokio::test]
    async fn shell_open_external_rejects_a_non_http_scheme_without_spawning_anything() {
        let err = shell_open_external("file:///etc/passwd".to_string())
            .await
            .expect_err("a non-http(s) scheme must be rejected");
        assert!(
            err.contains("file:///etc/passwd"),
            "error must name the offending url: {err}"
        );
        assert!(
            err.contains("http"),
            "error must name the expected shape: {err}"
        );
    }

    #[test]
    fn shell_show_item_in_folder_accepts_camel_case_full_path_and_returns_ok_false_shape() {
        let dir = std::env::temp_dir().join(format!("tr-shell-ipc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("leaf.txt");
        std::fs::write(&file, b"x").unwrap();

        let app = tauri::test::mock_builder()
            .invoke_handler(tauri::generate_handler![shell_show_item_in_folder])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app builds");
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .build()
        .expect("mock window builds");

        let response = tauri::test::get_ipc_response(
            &window,
            tauri::webview::InvokeRequest {
                cmd: "shell_show_item_in_folder".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: if cfg!(any(windows, target_os = "android")) {
                    "http://tauri.localhost"
                } else {
                    "tauri://localhost"
                }
                .parse()
                .unwrap(),
                body: tauri::ipc::InvokeBody::Json(serde_json::json!({
                    "fullPath": file.to_str().unwrap(),
                })),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.into(),
            },
        );
        let value =
            response.expect("command must resolve, not reject, even on a validation failure");
        let value = value
            .deserialize::<serde_json::Value>()
            .expect("valid JSON");
        assert_eq!(
            value["ok"], false,
            "a file passed to the directory-only command must report ok:false: {value}"
        );
        assert!(
            value["error"].as_str().unwrap().contains("a directory"),
            "error must name the expected shape: {value}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
