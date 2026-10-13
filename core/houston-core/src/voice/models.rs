use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use super::reuse::{reference_path, resolve_path};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy)]
pub struct ModelSpec {
    pub id: &'static str,
    pub display_name: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub size_bytes: u64,
    pub memory_gib: u64,
}

// SHA-256 and sizes are the upstream Hugging Face LFS metadata at the pinned revision.
// Memory figures are conservative working headroom guidance, not measured load requirements.
pub const CATALOG: &[ModelSpec] = &[
    ModelSpec {
        id: "ggml-tiny",
        display_name: "Tiny (multilingual)",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.bin",
        sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
        size_bytes: 77_691_713,
        memory_gib: 1,
    },
    ModelSpec {
        id: "ggml-base",
        display_name: "Base (multilingual)",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin",
        sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
        size_bytes: 147_951_465,
        memory_gib: 1,
    },
    ModelSpec {
        id: "ggml-small",
        display_name: "Small (multilingual)",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small.bin",
        sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
        size_bytes: 487_601_967,
        memory_gib: 2,
    },
    ModelSpec {
        id: "ggml-medium-q5_0",
        display_name: "Medium Q5_0 (multilingual)",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-medium-q5_0.bin",
        sha256: "19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f",
        size_bytes: 539_212_467,
        memory_gib: 3,
    },
    ModelSpec {
        id: "ggml-large-v3-turbo-q5_0",
        display_name: "Large v3 Turbo Q5_0 (multilingual)",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q5_0.bin",
        sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
        size_bytes: 574_041_195,
        memory_gib: 3,
    },
];

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
        find(id)?;
        self.cooldown_for_id(models_dir, id)
    }

    fn cooldown_for_id(&self, models_dir: &Path, id: &str) -> Option<Duration> {
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

pub fn final_model_path(models_dir: &Path, id: &str) -> PathBuf {
    models_dir.join(format!("{id}.bin"))
}

// Allow slow model transfers, but stop stalled peers and endless trickle responses.
const DOWNLOAD_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);

#[allow(clippy::too_many_arguments)]
async fn download_verified(
    client: &reqwest::Client,
    models_dir: &Path,
    id: &str,
    url: &str,
    expected_sha256: &str,
    published_size: u64,
    on_progress: impl FnMut(u64, u64),
) -> Result<PathBuf, ModelError> {
    download_with_limits(
        client,
        models_dir,
        id,
        url,
        expected_sha256,
        published_size,
        on_progress,
        DOWNLOAD_IDLE_TIMEOUT,
        DOWNLOAD_TIMEOUT,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn download_with_limits(
    client: &reqwest::Client,
    models_dir: &Path,
    id: &str,
    url: &str,
    expected_sha256: &str,
    published_size: u64,
    mut on_progress: impl FnMut(u64, u64),
    idle_timeout: Duration,
    whole_timeout: Duration,
) -> Result<PathBuf, ModelError> {
    let timeout_error = |stage: &'static str, limit| ModelError::Timeout {
        id: id.to_string(),
        stage,
        limit,
    };
    let transfer = async {
        std::fs::create_dir_all(models_dir).map_err(|source| ModelError::Io {
            path: models_dir.to_path_buf(),
            source,
        })?;
        let final_path = final_model_path(models_dir, id);
        let resp = tokio::time::timeout(idle_timeout, client.get(url).send())
            .await
            .map_err(|_| timeout_error("response headers", idle_timeout))?
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
        if let Some(actual) = resp.content_length() {
            if actual != published_size {
                return Err(ModelError::SizeMismatch {
                    id: id.to_string(),
                    expected: published_size,
                    actual,
                });
            }
        }

        // Exclusive random names and TempPath ownership prevent concurrent clobbering
        // and remove this transfer's partial file on errors, cancellation and unwinding.
        let temp = tempfile::Builder::new()
            .prefix("voice-")
            .suffix(".part")
            .tempfile_in(models_dir)
            .map_err(|source| ModelError::Io {
                path: models_dir.to_path_buf(),
                source,
            })?;
        let (file, temp_path) = temp.into_parts();
        let mut file = tokio::fs::File::from_std(file);
        let mut hasher = Sha256::new();
        let mut stream = resp.bytes_stream();
        let mut downloaded = 0u64;
        use tokio::io::AsyncWriteExt;
        while let Some(chunk) = tokio::time::timeout(idle_timeout, stream.next())
            .await
            .map_err(|_| timeout_error("response body idle", idle_timeout))?
        {
            let chunk = chunk.map_err(|source| ModelError::Network {
                url: url.to_string(),
                source,
            })?;
            let actual = downloaded.saturating_add(chunk.len() as u64);
            if actual > published_size {
                return Err(ModelError::SizeMismatch {
                    id: id.to_string(),
                    expected: published_size,
                    actual,
                });
            }
            file.write_all(&chunk)
                .await
                .map_err(|source| ModelError::Io {
                    path: temp_path.to_path_buf(),
                    source,
                })?;
            hasher.update(&chunk);
            downloaded = actual;
            on_progress(downloaded, published_size);
        }
        if downloaded != published_size {
            return Err(ModelError::SizeMismatch {
                id: id.to_string(),
                expected: published_size,
                actual: downloaded,
            });
        }
        file.flush().await.map_err(|source| ModelError::Io {
            path: temp_path.to_path_buf(),
            source,
        })?;
        drop(file);
        let actual = format!("{:x}", hasher.finalize());
        if !actual.eq_ignore_ascii_case(expected_sha256) {
            return Err(ModelError::HashMismatch {
                id: id.to_string(),
                expected: expected_sha256.to_string(),
                actual,
            });
        }
        temp_path
            .persist(&final_path)
            .map_err(|err| ModelError::Io {
                path: final_path.clone(),
                source: err.error,
            })?;
        Ok(final_path)
    };
    tokio::time::timeout(whole_timeout, transfer)
        .await
        .map_err(|_| timeout_error("whole request", whole_timeout))?
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelStatus {
    NotDownloaded,
    Downloaded { size_bytes: u64 },
}

pub fn status(models_dir: &Path, id: &str) -> ModelStatus {
    if find(id).is_none() {
        return ModelStatus::NotDownloaded;
    }
    match resolve_path(models_dir, id).and_then(|p| std::fs::metadata(p).ok()) {
        Some(meta) if meta.is_file() => ModelStatus::Downloaded {
            size_bytes: meta.len(),
        },
        _ => ModelStatus::NotDownloaded,
    }
}

pub fn delete(models_dir: &Path, id: &str) -> Result<u64, ModelError> {
    find(id).ok_or_else(|| ModelError::UnknownModel { id: id.to_string() })?;
    let reference = reference_path(models_dir, id);
    match std::fs::remove_file(&reference) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(source) => {
            return Err(ModelError::Io {
                path: reference,
                source,
            })
        }
    }
    let path = final_model_path(models_dir, id);
    match std::fs::symlink_metadata(&path) {
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
        .filter_map(
            |spec| match std::fs::metadata(final_model_path(models_dir, spec.id)) {
                Ok(meta) if meta.is_file() => Some(meta.len()),
                _ => None,
            },
        )
        .sum()
}

#[derive(Debug)]
pub enum ModelError {
    DownloadActive {
        id: String,
    },
    Timeout {
        id: String,
        stage: &'static str,
        limit: Duration,
    },
    SizeMismatch {
        id: String,
        expected: u64,
        actual: u64,
    },
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
            ModelError::DownloadActive { id } => write!(f, "model {id:?} download is active; wait for it to finish before deleting or starting another download"),
            ModelError::Timeout { id, stage, limit } => write!(f, "model {id:?} download exceeded the {stage} limit of {}ms; retry the download", limit.as_millis()),
            ModelError::SizeMismatch { id, expected, actual } => write!(f, "model {id:?} download size mismatch: expected {expected} bytes, got {actual} bytes"),
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
            std::fs::metadata(&path).unwrap().len(),
            payload.len() as u64
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
        let size = payload.len() as u64;
        let base = start_fixture_server(payload, true).await;
        let dir = tempfile::tempdir().unwrap();
        let client = reqwest::Client::new();

        let err = download_verified(
            &client,
            dir.path(),
            "fixture-model",
            &format!("{base}/model.bin"),
            &expected,
            size,
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
        assert!(
            !dir.path().join("fixture-model.bin").exists(),
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
        assert!(!dir.path().join("fixture-model.bin").exists());
    }

    #[test]
    fn delete_rejects_unknown_traversal_and_absolute_ids_before_filesystem_access() {
        let dir = tempfile::tempdir().unwrap();
        let models_dir = dir.path().join("models");
        let outside = dir.path().join("victim.bin");
        std::fs::write(&outside, b"keep").unwrap();
        let absolute_id = outside.with_extension("").to_str().unwrap().to_string();
        for id in ["../victim", absolute_id.as_str(), "unknown"] {
            assert!(matches!(
                delete(&models_dir, id),
                Err(ModelError::UnknownModel { .. })
            ));
            assert_eq!(status(&models_dir, id), ModelStatus::NotDownloaded);
            assert_eq!(std::fs::read(&outside).unwrap(), b"keep");
            assert!(!models_dir.exists());
        }
    }

    #[derive(Clone, Copy)]
    enum Connection {
        Idle,
        Trickle,
        Disconnect,
    }

    async fn raw_server(
        response: &'static [u8],
        connection: Connection,
    ) -> (String, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/model.bin", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 4096];
            assert!(socket.read(&mut request).await.unwrap() > 0);
            socket.write_all(response).await.unwrap();
            if matches!(connection, Connection::Trickle) {
                loop {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    if socket.write_all(b"1\r\nx\r\n").await.is_err() {
                        break;
                    }
                }
            } else if matches!(connection, Connection::Idle) {
                std::future::pending::<()>().await;
            }
        });
        (url, task)
    }

    fn assert_no_parts(dir: &Path) {
        assert!(std::fs::read_dir(dir).unwrap().all(|entry| entry
            .unwrap()
            .path()
            .extension()
            .is_none_or(|ext| ext != "part")));
    }

    #[tokio::test]
    async fn header_body_idle_and_whole_request_timeouts_cleanup_partial_files() {
        for (response, connection, stage) in [
            (&b""[..], Connection::Idle, "response headers"),
            (
                &b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n"[..],
                Connection::Idle,
                "response body idle",
            ),
            (
                &b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"[..],
                Connection::Trickle,
                "whole request",
            ),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let (url, task) = raw_server(response, connection).await;
            let err = download_with_limits(
                &reqwest::Client::new(),
                dir.path(),
                "fixture",
                &url,
                "irrelevant",
                1000,
                |_, _| {},
                Duration::from_millis(500),
                Duration::from_secs(2),
            )
            .await
            .unwrap_err();
            task.abort();
            let _ = task.await;
            assert!(
                matches!(err, ModelError::Timeout { stage: actual, .. } if actual == stage),
                "{err:?}"
            );
            assert_no_parts(dir.path());
            assert!(!dir.path().join("fixture.bin").exists());
        }
    }

    #[tokio::test]
    async fn advertised_and_streamed_size_mismatches_are_rejected_without_publication() {
        for (response, expected, actual) in [
            (
                &b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\ndata"[..],
                3,
                4,
            ),
            (
                &b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\ndata\r\n0\r\n\r\n"[..],
                3,
                4,
            ),
            (
                &b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nda\r\n0\r\n\r\n"[..],
                3,
                2,
            ),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let (url, task) = raw_server(response, Connection::Idle).await;
            let progress = Mutex::new(Vec::new());
            let err = download_verified(
                &reqwest::Client::new(),
                dir.path(),
                "fixture",
                &url,
                "irrelevant",
                expected,
                |done, _| progress.lock().unwrap().push(done),
            )
            .await
            .unwrap_err();
            task.abort();
            let _ = task.await;
            assert!(
                matches!(err, ModelError::SizeMismatch { expected: e, actual: a, .. }
                if e == expected && a == actual),
                "{err:?}"
            );
            assert!(progress
                .lock()
                .unwrap()
                .iter()
                .all(|done| *done <= expected));
            assert_no_parts(dir.path());
            assert!(!dir.path().join("fixture.bin").exists());
        }
    }

    #[tokio::test]
    async fn disconnected_body_and_panicking_progress_remove_their_partial_files() {
        let dir = tempfile::tempdir().unwrap();
        let (url, server) = raw_server(
            b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nx",
            Connection::Disconnect,
        )
        .await;
        let err = download_verified(
            &reqwest::Client::new(),
            dir.path(),
            "fixture",
            &url,
            "irrelevant",
            3,
            |_, _| {},
        )
        .await
        .unwrap_err();
        server.await.unwrap();
        assert!(matches!(err, ModelError::Network { .. }), "{err:?}");
        assert_no_parts(dir.path());
        assert!(!dir.path().join("fixture.bin").exists());

        let (url, server) = raw_server(
            b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc",
            Connection::Disconnect,
        )
        .await;
        let download_dir = dir.path().to_path_buf();
        let task = tokio::spawn(async move {
            download_verified(
                &reqwest::Client::new(),
                &download_dir,
                "fixture",
                &url,
                "irrelevant",
                3,
                |_, _| panic!("synthetic progress callback panic"),
            )
            .await
        });
        assert!(task.await.unwrap_err().is_panic());
        server.await.unwrap();
        assert_no_parts(dir.path());
        assert!(!dir.path().join("fixture.bin").exists());
    }

    #[tokio::test]
    async fn concurrent_transfers_have_exclusive_parts_and_abort_cleans_only_its_own() {
        let dir = tempfile::tempdir().unwrap();
        let (url, server) = raw_server(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n",
            Connection::Idle,
        )
        .await;
        let (progress_tx, progress_rx) = tokio::sync::oneshot::channel();
        let download_dir = dir.path().to_path_buf();
        let task = tokio::spawn(async move {
            let mut progress_tx = Some(progress_tx);
            download_verified(
                &reqwest::Client::new(),
                &download_dir,
                "fixture",
                &url,
                "irrelevant",
                3,
                |_, _| {
                    if let Some(tx) = progress_tx.take() {
                        let _ = tx.send(());
                    }
                },
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(3), progress_rx)
            .await
            .unwrap()
            .unwrap();
        let parts: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect();
        assert_eq!(parts.len(), 1);
        let payload = fixture_payload();
        let expected = fixture_sha256(&payload);
        let base = start_fixture_server(payload.clone(), false).await;
        download_verified(
            &reqwest::Client::new(),
            dir.path(),
            "fixture",
            &format!("{base}/model.bin"),
            &expected,
            payload.len() as u64,
            |_, _| {},
        )
        .await
        .unwrap();
        assert!(
            parts[0].exists(),
            "another transfer must not sweep an active part"
        );
        assert_eq!(
            std::fs::read(dir.path().join("fixture.bin")).unwrap(),
            payload
        );
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        server.abort();
        let _ = server.await;
        assert_no_parts(dir.path());
        assert_eq!(
            std::fs::read(dir.path().join("fixture.bin")).unwrap(),
            payload
        );
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
            manager.cooldown_for_id(models_dir, "x"),
            None,
            "no attempts yet: no cooldown"
        );
        for _ in 0..MAX_CONSECUTIVE_FAILURES - 1 {
            manager.record_failure(models_dir, "x");
        }
        assert_eq!(
            manager.cooldown_for_id(models_dir, "x"),
            None,
            "fewer than {MAX_CONSECUTIVE_FAILURES} failures must not cool down yet"
        );
        manager.record_failure(models_dir, "x");
        let remaining = manager
            .cooldown_for_id(models_dir, "x")
            .expect("MAX_CONSECUTIVE_FAILURES in a row must engage the cooldown");
        assert!(remaining <= COOLDOWN && remaining > Duration::ZERO);
        assert_eq!(
            manager.cooldown_remaining(models_dir, "x"),
            None,
            "public cooldown lookup must ignore IDs outside the catalog"
        );
    }

    #[test]
    fn the_cooldown_survives_a_new_manager_over_the_same_models_dir() {
        let dir = tempfile::tempdir().unwrap();
        let models_dir = dir.path();
        let first = Manager::new();
        for _ in 0..MAX_CONSECUTIVE_FAILURES {
            first.record_failure(models_dir, "x");
        }
        assert!(first.cooldown_for_id(models_dir, "x").is_some());

        let restarted = Manager::new();
        assert!(
            restarted.cooldown_for_id(models_dir, "x").is_some(),
            "a restarted daemon must not hand back a clean slate"
        );

        let other = tempfile::tempdir().unwrap();
        assert_eq!(restarted.cooldown_for_id(other.path(), "x"), None);
    }

    #[test]
    fn an_unparseable_ledger_reads_as_no_failures_rather_than_a_stuck_cooldown() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(FAILURES_FILE), "{ not json").unwrap();
        let manager = Manager::new();
        assert_eq!(manager.cooldown_for_id(dir.path(), "x"), None);
    }

    #[test]
    fn a_success_resets_the_failure_count() {
        let dir = tempfile::tempdir().unwrap();
        let models_dir = dir.path();
        let manager = Manager::new();
        for _ in 0..MAX_CONSECUTIVE_FAILURES {
            manager.record_failure(models_dir, "x");
        }
        assert!(manager.cooldown_for_id(models_dir, "x").is_some());
        manager.record_success(models_dir, "x");
        assert_eq!(
            manager.cooldown_for_id(models_dir, "x"),
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
