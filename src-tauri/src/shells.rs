use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;
use tokio::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShellEntry {
    pub name: String,
    pub path: String,
}

#[derive(Default)]
pub struct ShellsCache(Mutex<Option<Vec<ShellEntry>>>);

impl ShellsCache {
    pub fn new() -> Self {
        Self::default()
    }
}

#[cfg_attr(windows, allow(dead_code))]
async fn read_and_filter_shells_at(path: &Path) -> Option<Vec<ShellEntry>> {
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(err) => {
            eprintln!(
                "houston-tauri: failed to read {} (expected a readable text file at that \
                 path): {err}; returning empty shell list",
                path.display()
            );
            return None;
        }
    };
    let text = String::from_utf8_lossy(&bytes);
    let mut out = Vec::new();
    for entry in parse_shells(&text) {
        if tokio::fs::metadata(&entry.path).await.is_ok() {
            out.push(entry);
        }
    }
    Some(out)
}

#[cfg_attr(windows, allow(dead_code))]
async fn cached_or<F, Fut>(cache: &ShellsCache, compute: F) -> Vec<ShellEntry>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Option<Vec<ShellEntry>>>,
{
    {
        let guard = cache.0.lock().await;
        if let Some(cached) = guard.as_ref() {
            return cached.clone();
        }
    }
    let result = compute().await;
    if let Some(entries) = &result {
        *cache.0.lock().await = Some(entries.clone());
    }
    result.unwrap_or_default()
}

pub async fn detect_available_shells(cache: &ShellsCache) -> Vec<ShellEntry> {
    #[cfg(windows)]
    {
        let _ = cache;
        Vec::new()
    }
    #[cfg(not(windows))]
    cached_or(cache, || {
        read_and_filter_shells_at(Path::new("/etc/shells"))
    })
    .await
}

pub fn parse_shells(text: &str) -> Vec<ShellEntry> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') || !line.starts_with('/') {
            continue;
        }
        let name = match Path::new(line).file_name().and_then(|n| n.to_str()) {
            Some(n) if !n.is_empty() => n.to_string(),
            _ => continue,
        };
        if !seen.insert(name.clone()) {
            continue;
        }
        out.push(ShellEntry {
            name,
            path: line.to_string(),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_comments_and_blank_lines() {
        let input = "# comment\n\n/bin/bash\n   \n/bin/zsh\n";
        let got = parse_shells(input);
        assert_eq!(
            got,
            vec![
                ShellEntry {
                    name: "bash".into(),
                    path: "/bin/bash".into()
                },
                ShellEntry {
                    name: "zsh".into(),
                    path: "/bin/zsh".into()
                },
            ]
        );
    }

    #[test]
    fn trims_surrounding_whitespace() {
        let input = "  /bin/bash  \n\t/bin/zsh\t\n";
        let got = parse_shells(input);
        assert_eq!(
            got,
            vec![
                ShellEntry {
                    name: "bash".into(),
                    path: "/bin/bash".into()
                },
                ShellEntry {
                    name: "zsh".into(),
                    path: "/bin/zsh".into()
                },
            ]
        );
    }

    #[test]
    fn skips_path_with_no_basename() {
        let input = "/\n/bin/bash\n";
        let got = parse_shells(input);
        assert_eq!(
            got,
            vec![ShellEntry {
                name: "bash".into(),
                path: "/bin/bash".into()
            }]
        );
    }

    #[test]
    fn handles_crlf_line_endings() {
        let input = "/bin/bash\r\n/bin/zsh\r\n";
        let got = parse_shells(input);
        assert_eq!(
            got,
            vec![
                ShellEntry {
                    name: "bash".into(),
                    path: "/bin/bash".into()
                },
                ShellEntry {
                    name: "zsh".into(),
                    path: "/bin/zsh".into()
                },
            ]
        );
    }

    #[test]
    fn dedupes_by_basename_first_occurrence_wins() {
        let input = "/bin/bash\n/usr/local/bin/bash\n";
        let got = parse_shells(input);
        assert_eq!(
            got,
            vec![ShellEntry {
                name: "bash".into(),
                path: "/bin/bash".into()
            }]
        );
    }

    #[test]
    fn ignores_lines_not_starting_with_slash() {
        let input = "bash\nrelative/path\n/bin/sh\n";
        let got = parse_shells(input);
        assert_eq!(
            got,
            vec![ShellEntry {
                name: "sh".into(),
                path: "/bin/sh".into()
            }]
        );
    }

    #[test]
    fn empty_input_yields_empty_list() {
        assert_eq!(parse_shells(""), Vec::new());
    }

    #[test]
    fn lossily_decoded_invalid_utf8_still_parses_other_entries() {
        let mut bytes = b"/bin/bash\n/bin/".to_vec();
        bytes.push(0xFF);
        bytes.extend_from_slice(b"sh\n/bin/zsh\n");
        let text = String::from_utf8_lossy(&bytes);
        let got = parse_shells(&text);
        assert_eq!(got[0].name, "bash");
        assert_eq!(got.last().unwrap().name, "zsh");
        assert!(got.iter().any(|e| e.name.contains('\u{FFFD}')));
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn read_and_filter_shells_at_drops_entries_that_do_not_exist_on_disk() {
        let dir = std::env::temp_dir().join(format!("tr-shells-filter-{}", std::process::id()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let shells_file = dir.join("shells");
        let real = std::env::current_exe().unwrap();
        let real_s = real.display().to_string();
        tokio::fs::write(&shells_file, format!("{real_s}\n/no/such/shell-xyz\n"))
            .await
            .unwrap();

        let got = read_and_filter_shells_at(&shells_file).await.unwrap();
        assert_eq!(got.len(), 1, "the bogus entry must be dropped: {got:?}");
        assert_eq!(got[0].path, real_s);
        assert_eq!(
            got[0].name,
            real.file_stem().unwrap().to_string_lossy(),
            "the display name derives from the binary's own basename"
        );

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn read_and_filter_shells_at_returns_none_on_an_unreadable_path() {
        let got = read_and_filter_shells_at(Path::new("/no/such/shells-file-xyz")).await;
        assert!(
            got.is_none(),
            "an unreadable path must return None, not Some(vec![])"
        );
    }

    #[tokio::test]
    async fn cached_or_computes_once_and_caches_the_result() {
        let cache = ShellsCache::new();
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let expected = vec![ShellEntry {
            name: "bash".into(),
            path: "/bin/bash".into(),
        }];

        for _ in 0..3 {
            let calls = calls.clone();
            let entries = expected.clone();
            let got = cached_or(&cache, move || {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                async move { Some(entries) }
            })
            .await;
            assert_eq!(got, expected);
        }
        assert_eq!(
            calls.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "compute() must run exactly once; later calls must hit the cache"
        );
    }

    #[tokio::test]
    async fn cached_or_does_not_cache_a_failed_compute_and_retries_next_call() {
        let cache = ShellsCache::new();
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let calls_1 = calls.clone();
        let got = cached_or(&cache, move || {
            calls_1.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async move { None }
        })
        .await;
        assert_eq!(got, Vec::<ShellEntry>::new());
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);

        let calls_2 = calls.clone();
        let got = cached_or(&cache, move || {
            calls_2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async move {
                Some(vec![ShellEntry {
                    name: "zsh".into(),
                    path: "/bin/zsh".into(),
                }])
            }
        })
        .await;
        assert_eq!(
            got,
            vec![ShellEntry {
                name: "zsh".into(),
                path: "/bin/zsh".into()
            }]
        );
        assert_eq!(
            calls.load(std::sync::atomic::Ordering::SeqCst),
            2,
            "a failed compute() must not be cached -- the retry must actually run compute() again"
        );
    }

    #[tauri::command]
    async fn detect_available_shells_test_command(
        cache: tauri::State<'_, ShellsCache>,
    ) -> Result<Vec<ShellEntry>, String> {
        Ok(detect_available_shells(&cache).await)
    }

    #[test]
    fn detect_available_shells_round_trips_through_the_ipc_boundary() {
        let app = tauri::test::mock_builder()
            .invoke_handler(tauri::generate_handler![
                detect_available_shells_test_command
            ])
            .manage(ShellsCache::new())
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
                cmd: "detect_available_shells_test_command".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: if cfg!(any(windows, target_os = "android")) {
                    "http://tauri.localhost"
                } else {
                    "tauri://localhost"
                }
                .parse()
                .unwrap(),
                body: tauri::ipc::InvokeBody::Json(serde_json::json!({})),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.into(),
            },
        );
        let value = response.expect("command must resolve");
        let entries: Vec<ShellEntry> = value.deserialize().expect("valid JSON array");
        assert!(entries.iter().all(|e| !e.name.is_empty()));
    }
}
