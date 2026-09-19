use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use futures_util::StreamExt;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy)]
pub struct ModelSpec {
    pub id: &'static str,
    pub display_name: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub size_bytes: u64,
}

pub const CATALOG: &[ModelSpec] = &[ModelSpec {
    id: "ggml-small",
    display_name: "Small (multilingual)",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
    sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    size_bytes: 487_601_967,
}];

pub fn find(id: &str) -> Option<&'static ModelSpec> {
    CATALOG.iter().find(|m| m.id == id)
}

const MAX_CONSECUTIVE_FAILURES: u32 = 3;

const COOLDOWN: Duration = Duration::from_secs(5 * 60);

#[derive(Default, Clone, serde::Serialize, serde::Deserialize)]
struct FailureState {
    consecutive: u32,
    #[serde(default)]
    last_failure_at: Option<i64>,
}

const FAILURES_FILE: &str = ".download-failures.json";

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Default)]
pub struct Manager {
    lock: Mutex<()>,
}

type Ledger = std::collections::HashMap<String, FailureState>;

impl Manager {
    pub fn new() -> Self {
        Self::default()
    }

    fn ledger_path(models_dir: &Path) -> PathBuf {
        models_dir.join(FAILURES_FILE)
    }

    fn read_ledger(models_dir: &Path) -> Ledger {
        std::fs::read_to_string(Self::ledger_path(models_dir))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    fn write_ledger(models_dir: &Path, ledger: &Ledger) {
        if std::fs::create_dir_all(models_dir).is_err() {
            return;
        }
        if let Ok(text) = serde_json::to_string_pretty(ledger) {
            let _ = std::fs::write(Self::ledger_path(models_dir), text);
        }
    }

    pub fn cooldown_remaining(&self, models_dir: &Path, id: &str) -> Option<Duration> {
        let _guard = self.lock.lock().expect("model download failures lock");
        let ledger = Self::read_ledger(models_dir);
        let state = ledger.get(id)?;
        if state.consecutive < MAX_CONSECUTIVE_FAILURES {
            return None;
        }
        let elapsed_ms = now_ms().saturating_sub(state.last_failure_at?).max(0) as u64;
        COOLDOWN
            .checked_sub(Duration::from_millis(elapsed_ms))
            .filter(|d| !d.is_zero())
    }

    fn record_failure(&self, models_dir: &Path, id: &str) {
        let _guard = self.lock.lock().expect("model download failures lock");
        let mut ledger = Self::read_ledger(models_dir);
        let state = ledger.entry(id.to_string()).or_default();
        state.consecutive += 1;
        state.last_failure_at = Some(now_ms());
        Self::write_ledger(models_dir, &ledger);
    }

    fn record_success(&self, models_dir: &Path, id: &str) {
        let _guard = self.lock.lock().expect("model download failures lock");
        let mut ledger = Self::read_ledger(models_dir);
        if ledger.remove(id).is_some() {
            Self::write_ledger(models_dir, &ledger);
        }
    }

    pub async fn download(
        &self,
        client: &reqwest::Client,
        models_dir: &Path,
        id: &str,
    ) -> Result<PathBuf, ModelError> {
        self.download_with_progress(client, models_dir, id, |_, _| {})
            .await
    }

    pub async fn download_with_progress(
        &self,
        client: &reqwest::Client,
        models_dir: &Path,
        id: &str,
        on_progress: impl FnMut(u64, u64),
    ) -> Result<PathBuf, ModelError> {
        let spec = find(id).ok_or_else(|| ModelError::UnknownModel { id: id.to_string() })?;
        if let Some(remaining) = self.cooldown_remaining(models_dir, id) {
            return Err(ModelError::CoolingDown {
                id: id.to_string(),
                remaining,
            });
        }
        match download_verified(
            client,
            models_dir,
            id,
            spec.url,
            spec.sha256,
            spec.size_bytes,
            on_progress,
        )
        .await
        {
            Ok(path) => {
                self.record_success(models_dir, id);
                Ok(path)
            }
            Err(err) => {
                self.record_failure(models_dir, id);
                Err(err)
            }
        }
    }
}

fn final_model_path(models_dir: &Path, id: &str) -> PathBuf {
    models_dir.join(format!("{id}.bin"))
}

#[allow(clippy::too_many_arguments)]
async fn download_verified(
    client: &reqwest::Client,
    models_dir: &Path,
    id: &str,
    url: &str,
    expected_sha256: &str,
    published_size: u64,
    mut on_progress: impl FnMut(u64, u64),
) -> Result<PathBuf, ModelError> {
    std::fs::create_dir_all(models_dir).map_err(|source| ModelError::Io {
        path: models_dir.to_path_buf(),
        source,
    })?;
    sweep_stale_temp_files(models_dir)?;

    let temp_path = models_dir.join(format!("{id}.{}.part", std::process::id()));
    let final_path = final_model_path(models_dir, id);

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|source| ModelError::Network {
            url: url.to_string(),
            source,
        })?;
    if !resp.status().is_success() {
        return Err(ModelError::Http {
            url: url.to_string(),
            status: resp.status().as_u16(),
        });
    }

    let mut file = tokio::fs::File::create(&temp_path)
        .await
        .map_err(|source| ModelError::Io {
            path: temp_path.clone(),
            source,
        })?;
    let mut hasher = Sha256::new();
    let mut stream = resp.bytes_stream();
    {
        use tokio::io::AsyncWriteExt;
        let mut downloaded: u64 = 0;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|source| ModelError::Network {
                url: url.to_string(),
                source,
            })?;
            hasher.update(&chunk);
            file.write_all(&chunk)
                .await
                .map_err(|source| ModelError::Io {
                    path: temp_path.clone(),
                    source,
                })?;
            downloaded += chunk.len() as u64;
            on_progress(downloaded, published_size);
        }
        file.flush().await.map_err(|source| ModelError::Io {
            path: temp_path.clone(),
            source,
        })?;
    }
    drop(file);

    let actual = format!("{:x}", hasher.finalize());
    if !actual.eq_ignore_ascii_case(expected_sha256) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(ModelError::HashMismatch {
            id: id.to_string(),
            expected: expected_sha256.to_string(),
            actual,
        });
    }

    std::fs::rename(&temp_path, &final_path).map_err(|source| ModelError::Io {
        path: final_path.clone(),
        source,
    })?;
    Ok(final_path)
}

pub fn sweep_stale_temp_files(models_dir: &Path) -> Result<u64, ModelError> {
    let mut removed = 0u64;
    let entries = match std::fs::read_dir(models_dir) {
        Ok(e) => e,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(source) => {
            return Err(ModelError::Io {
                path: models_dir.to_path_buf(),
                source,
            })
        }
    };
    for entry in entries {
        let entry = entry.map_err(|source| ModelError::Io {
            path: models_dir.to_path_buf(),
            source,
        })?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("part")
            && std::fs::remove_file(&path).is_ok()
        {
            removed += 1;
        }
    }
    Ok(removed)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelStatus {
    NotDownloaded,
    Downloaded { size_bytes: u64 },
}

pub fn status(models_dir: &Path, id: &str) -> ModelStatus {
    match std::fs::metadata(final_model_path(models_dir, id)) {
        Ok(meta) => ModelStatus::Downloaded {
            size_bytes: meta.len(),
        },
        Err(_) => ModelStatus::NotDownloaded,
    }
}

pub fn delete(models_dir: &Path, id: &str) -> Result<u64, ModelError> {
    let path = final_model_path(models_dir, id);
    match std::fs::metadata(&path) {
        Ok(meta) => {
            let freed = meta.len();
            std::fs::remove_file(&path).map_err(|source| ModelError::Io {
                path: path.clone(),
                source,
            })?;
            Ok(freed)
        }
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(source) => Err(ModelError::Io { path, source }),
    }
}

pub fn disk_usage(models_dir: &Path) -> u64 {
    CATALOG
        .iter()
        .filter_map(|spec| match status(models_dir, spec.id) {
            ModelStatus::Downloaded { size_bytes } => Some(size_bytes),
            ModelStatus::NotDownloaded => None,
        })
        .sum()
}

#[derive(Debug)]
pub enum ModelError {
    UnknownModel {
        id: String,
    },
    CoolingDown {
        id: String,
        remaining: Duration,
    },
    Network {
        url: String,
        source: reqwest::Error,
    },
    Http {
        url: String,
        status: u16,
    },
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    HashMismatch {
        id: String,
        expected: String,
        actual: String,
    },
}

impl fmt::Display for ModelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ModelError::UnknownModel { id } => {
                let known: Vec<&str> = CATALOG.iter().map(|m| m.id).collect();
                write!(
                    f,
                    "model {id:?} is not in the catalog (known: {})",
                    known.join(", ")
                )
            }
            ModelError::CoolingDown { id, remaining } => write!(
                f,
                "model {id:?} download is cooling down after {MAX_CONSECUTIVE_FAILURES} \
                 repeated failures ({}s remaining) — wait, or check the network",
                remaining.as_secs()
            ),
            ModelError::Network { url, source } => {
                write!(f, "downloading {url} failed: {source}")
            }
            ModelError::Http { url, status } => {
                write!(f, "downloading {url} failed: HTTP {status}")
            }
            ModelError::Io { path, source } => write!(f, "{}: {source}", path.display()),
            ModelError::HashMismatch {
                id,
                expected,
                actual,
            } => write!(
                f,
                "downloaded model {id:?} failed SHA-256 verification: expected {expected}, got \
                 {actual} — the download was corrupted or tampered with; re-download"
            ),
        }
    }
}

impl std::error::Error for ModelError {}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::State;
    use axum::response::IntoResponse;
    use axum::routing::get;
    use std::net::SocketAddr;
    use std::sync::Arc;

    #[derive(Clone)]
    struct Fixture {
        bytes: Arc<Vec<u8>>,
        corrupt: bool,
    }

    async fn serve_fixture(State(fixture): State<Fixture>) -> impl IntoResponse {
        if fixture.corrupt {
            let mut corrupted = (*fixture.bytes).clone();
            if let Some(first) = corrupted.first_mut() {
                *first ^= 0xFF;
            }
            corrupted
        } else {
            (*fixture.bytes).clone()
        }
    }

    async fn serve_404() -> axum::http::StatusCode {
        axum::http::StatusCode::NOT_FOUND
    }

    async fn start_fixture_server(bytes: Vec<u8>, corrupt: bool) -> String {
        let fixture = Fixture {
            bytes: Arc::new(bytes),
            corrupt,
        };
        let app = axum::Router::new()
            .route("/model.bin", get(serve_fixture))
            .route("/missing.bin", get(serve_404))
            .with_state(fixture);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{addr}")
    }

    fn fixture_payload() -> Vec<u8> {
        (0..65_536u32).map(|i| (i % 251) as u8).collect()
    }

    fn fixture_sha256(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        format!("{:x}", hasher.finalize())
    }

    #[tokio::test]
    async fn download_verified_streams_hashes_and_installs_a_verified_model() {
        let payload = fixture_payload();
        let expected = fixture_sha256(&payload);
        let base = start_fixture_server(payload.clone(), false).await;
        let dir = tempfile::tempdir().unwrap();
        let client = reqwest::Client::new();
        let progress: Mutex<Vec<(u64, u64)>> = Mutex::new(Vec::new());

        let path = download_verified(
            &client,
            dir.path(),
            "fixture-model",
            &format!("{base}/model.bin"),
            &expected,
            payload.len() as u64,
            |done, total| progress.lock().unwrap().push((done, total)),
        )
        .await
        .expect("a byte-identical, hash-matching download must succeed");

        assert_eq!(path, dir.path().join("fixture-model.bin"));
        let on_disk = std::fs::read(&path).unwrap();
        assert_eq!(
            on_disk, payload,
            "installed file must be byte-identical to the source"
        );
        assert!(
            std::fs::read_dir(dir.path())
                .unwrap()
                .filter_map(|e| e.ok())
                .all(|e| e.path().extension().is_none_or(|ext| ext != "part")),
            "no temp file may survive a successful download"
        );
        assert_eq!(
            status(dir.path(), "fixture-model"),
            ModelStatus::Downloaded {
                size_bytes: payload.len() as u64
            }
        );
        let seen = progress.lock().unwrap();
        assert!(
            !seen.is_empty(),
            "the progress hook must be called at least once"
        );
        assert_eq!(
            seen.last().copied(),
            Some((payload.len() as u64, payload.len() as u64)),
            "the last progress report must be the whole payload: {seen:?}"
        );
    }

    #[tokio::test]
    async fn a_hash_mismatch_is_refused_and_leaves_no_installed_file() {
        let payload = fixture_payload();
        let expected = fixture_sha256(&payload);
        let base = start_fixture_server(payload, true).await;
        let dir = tempfile::tempdir().unwrap();
        let client = reqwest::Client::new();

        let err = download_verified(
            &client,
            dir.path(),
            "fixture-model",
            &format!("{base}/model.bin"),
            &expected,
            0,
            |_, _| {},
        )
        .await
        .expect_err("a corrupted download must fail verification");

        match &err {
            ModelError::HashMismatch {
                id,
                expected: e,
                actual,
            } => {
                assert_eq!(id, "fixture-model");
                assert_eq!(e, &expected);
                assert_ne!(actual, e, "the corrupted payload's digest must differ");
            }
            other => panic!("expected HashMismatch, got {other:?}"),
        }
        assert_eq!(
            status(dir.path(), "fixture-model"),
            ModelStatus::NotDownloaded,
            "a hash-mismatched download must never be installed"
        );
        assert!(
            std::fs::read_dir(dir.path())
                .unwrap()
                .filter_map(|e| e.ok())
                .all(|e| e.path().extension().is_none_or(|ext| ext != "part")),
            "the corrupt temp file must be cleaned up, never left as debris"
        );
    }

    #[tokio::test]
    async fn a_404_is_a_named_http_error_not_a_panic_or_a_fake_install() {
        let base = start_fixture_server(fixture_payload(), false).await;
        let dir = tempfile::tempdir().unwrap();
        let client = reqwest::Client::new();

        let err = download_verified(
            &client,
            dir.path(),
            "fixture-model",
            &format!("{base}/missing.bin"),
            "irrelevant",
            0,
            |_, _| {},
        )
        .await
        .expect_err("a 404 must not be treated as success");

        match &err {
            ModelError::Http { status, url } => {
                assert_eq!(*status, 404);
                assert!(url.contains("missing.bin"));
            }
            other => panic!("expected Http, got {other:?}"),
        }
        assert_eq!(
            status(dir.path(), "fixture-model"),
            ModelStatus::NotDownloaded
        );
    }

    #[tokio::test]
    async fn sweep_stale_temp_files_removes_part_files_but_not_installed_models() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("orphan.123.part"), b"leftover").unwrap();
        std::fs::write(dir.path().join("ggml-small.bin"), b"a real installed model").unwrap();

        let removed = sweep_stale_temp_files(dir.path()).unwrap();

        assert_eq!(removed, 1);
        assert!(!dir.path().join("orphan.123.part").exists());
        assert!(
            dir.path().join("ggml-small.bin").exists(),
            "sweeping temp files must never touch an installed model"
        );
    }

    #[test]
    fn sweep_on_a_directory_that_does_not_exist_yet_is_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let never_created = dir.path().join("models");
        assert_eq!(sweep_stale_temp_files(&never_created).unwrap(), 0);
    }

    #[test]
    fn delete_of_a_never_downloaded_model_is_a_successful_no_op() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            delete(dir.path(), "ggml-small").unwrap(),
            0,
            "deleting an absent model is success (0 bytes freed), never an error"
        );
    }

    #[test]
    fn delete_removes_the_file_and_reports_the_bytes_it_freed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ggml-small.bin");
        std::fs::write(&path, vec![0u8; 4096]).unwrap();

        let freed = delete(dir.path(), "ggml-small").unwrap();

        assert_eq!(freed, 4096);
        assert!(!path.exists());
    }

    #[test]
    fn status_and_disk_usage_reflect_what_is_actually_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(status(dir.path(), "ggml-small"), ModelStatus::NotDownloaded);
        assert_eq!(disk_usage(dir.path()), 0);

        std::fs::write(dir.path().join("ggml-small.bin"), vec![0u8; 1000]).unwrap();

        assert_eq!(
            status(dir.path(), "ggml-small"),
            ModelStatus::Downloaded { size_bytes: 1000 }
        );
        assert_eq!(disk_usage(dir.path()), 1000);
    }

    #[test]
    fn unknown_model_error_names_the_id_and_the_known_catalog() {
        let err = ModelError::UnknownModel {
            id: "not-a-real-model".to_string(),
        };
        let msg = err.to_string();
        assert!(msg.contains("not-a-real-model"), "{msg}");
        assert!(msg.contains("ggml-small"), "must name what IS known: {msg}");
    }

    #[tokio::test]
    async fn manager_download_of_an_unknown_id_never_touches_the_network() {
        let manager = Manager::new();
        let dir = tempfile::tempdir().unwrap();
        let client = reqwest::Client::new();
        let err = manager
            .download(&client, dir.path(), "not-a-real-model")
            .await
            .expect_err("an id outside the catalog must be refused before any request");
        assert!(matches!(err, ModelError::UnknownModel { .. }));
    }

    #[test]
    fn cooldown_engages_after_max_consecutive_failures_and_not_before() {
        let dir = tempfile::tempdir().unwrap();
        let models_dir = dir.path();
        let manager = Manager::new();
        assert_eq!(
            manager.cooldown_remaining(models_dir, "x"),
            None,
            "no attempts yet: no cooldown"
        );
        for _ in 0..MAX_CONSECUTIVE_FAILURES - 1 {
            manager.record_failure(models_dir, "x");
        }
        assert_eq!(
            manager.cooldown_remaining(models_dir, "x"),
            None,
            "fewer than {MAX_CONSECUTIVE_FAILURES} failures must not cool down yet"
        );
        manager.record_failure(models_dir, "x");
        let remaining = manager
            .cooldown_remaining(models_dir, "x")
            .expect("MAX_CONSECUTIVE_FAILURES in a row must engage the cooldown");
        assert!(remaining <= COOLDOWN && remaining > Duration::ZERO);
    }

    #[test]
    fn the_cooldown_survives_a_new_manager_over_the_same_models_dir() {
        let dir = tempfile::tempdir().unwrap();
        let models_dir = dir.path();
        let first = Manager::new();
        for _ in 0..MAX_CONSECUTIVE_FAILURES {
            first.record_failure(models_dir, "x");
        }
        assert!(first.cooldown_remaining(models_dir, "x").is_some());

        let restarted = Manager::new();
        assert!(
            restarted.cooldown_remaining(models_dir, "x").is_some(),
            "a restarted daemon must not hand back a clean slate"
        );

        let other = tempfile::tempdir().unwrap();
        assert_eq!(restarted.cooldown_remaining(other.path(), "x"), None);
    }

    #[test]
    fn an_unparseable_ledger_reads_as_no_failures_rather_than_a_stuck_cooldown() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(FAILURES_FILE), "{ not json").unwrap();
        let manager = Manager::new();
        assert_eq!(manager.cooldown_remaining(dir.path(), "x"), None);
    }

    #[test]
    fn a_success_resets_the_failure_count() {
        let dir = tempfile::tempdir().unwrap();
        let models_dir = dir.path();
        let manager = Manager::new();
        for _ in 0..MAX_CONSECUTIVE_FAILURES {
            manager.record_failure(models_dir, "x");
        }
        assert!(manager.cooldown_remaining(models_dir, "x").is_some());
        manager.record_success(models_dir, "x");
        assert_eq!(
            manager.cooldown_remaining(models_dir, "x"),
            None,
            "a subsequent success must clear the cooldown, not just decay it"
        );
    }

    #[test]
    fn cooling_down_message_names_the_model_and_remaining_seconds() {
        let err = ModelError::CoolingDown {
            id: "ggml-small".to_string(),
            remaining: Duration::from_secs(42),
        };
        let msg = err.to_string();
        assert!(msg.contains("ggml-small"), "{msg}");
        assert!(msg.contains("42"), "{msg}");
    }
}
