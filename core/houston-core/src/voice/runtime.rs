use std::path::Path;
#[cfg(unix)]
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use super::capture::{CaptureError, CaptureThread, CapturedUtterance};
use super::models;
#[cfg(unix)]
use super::whisper::{WhisperEngineError, WhisperTranscriber};

#[cfg(unix)]
struct CachedEngine {
    path: PathBuf,
    transcriber: Arc<WhisperTranscriber>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DownloadState {
    InFlight { progress: f32 },
    Failed { reason: String },
}

#[derive(Default)]
struct Inner {
    capture: Option<CaptureThread>,
    capture_device: Option<String>,
    listening: Option<u32>,
    #[cfg(unix)]
    engine: Option<CachedEngine>,
    downloads: std::collections::HashMap<String, DownloadState>,
    monitors: std::collections::HashSet<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MonitorTransition {
    Started,
    Stopped,
    Unchanged,
}

#[derive(Default)]
pub struct Runtime {
    inner: Arc<Mutex<Inner>>,
    pub models: models::Manager,
}

impl Runtime {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_open(&self) -> bool {
        self.lock().capture.is_some()
    }

    pub fn open_device_name(&self) -> Option<String> {
        self.lock()
            .capture
            .as_ref()
            .map(|c| c.device_name().to_string())
    }

    pub fn listening_for(&self) -> Option<u32> {
        self.lock().listening
    }

    pub fn set_monitor(&self, conn: u64, enabled: bool) -> MonitorTransition {
        let mut inner = self.lock();
        let was_empty = inner.monitors.is_empty();
        if enabled {
            inner.monitors.insert(conn);
        } else {
            inner.monitors.remove(&conn);
        }
        match (was_empty, inner.monitors.is_empty()) {
            (true, false) => MonitorTransition::Started,
            (false, true) => MonitorTransition::Stopped,
            _ => MonitorTransition::Unchanged,
        }
    }

    pub fn release_monitor(&self, conn: u64) -> MonitorTransition {
        self.set_monitor(conn, false)
    }

    pub fn is_monitoring(&self) -> bool {
        !self.lock().monitors.is_empty()
    }

    pub fn level(&self) -> Option<f32> {
        self.lock().capture.as_ref().map(|c| c.level())
    }

    pub fn ensure_open(&self, device: Option<&str>) -> Result<(), CaptureError> {
        let mut inner = self.lock();
        let same = inner.capture.is_some() && inner.capture_device.as_deref() == device;
        if same {
            return Ok(());
        }
        inner.capture = None;
        inner.capture_device = None;
        let capture = CaptureThread::open(device.map(str::to_string))?;
        inner.capture_device = device.map(str::to_string);
        inner.capture = Some(capture);
        Ok(())
    }

    pub fn close(&self) {
        let mut inner = self.lock();
        inner.listening = None;
        inner.capture_device = None;
        inner.capture = None;
    }

    pub fn arm(&self, session: u32) -> Result<(), CaptureError> {
        let mut inner = self.lock();
        let capture = inner.capture.as_ref().ok_or(CaptureError::NoInputDevice)?;
        capture.arm()?;
        inner.listening = Some(session);
        Ok(())
    }

    pub fn disarm(&self) -> Result<(Option<u32>, CapturedUtterance), CaptureError> {
        let mut inner = self.lock();
        let capture = inner.capture.as_ref().ok_or(CaptureError::NoInputDevice)?;
        let captured = capture.disarm()?;
        Ok((inner.listening.take(), captured))
    }

    #[cfg(unix)]
    pub fn local_engine(&self, path: &Path) -> Result<Arc<WhisperTranscriber>, WhisperEngineError> {
        {
            let inner = self.lock();
            if let Some(cached) = inner.engine.as_ref() {
                if cached.path == path {
                    return Ok(cached.transcriber.clone());
                }
            }
        }
        let loaded = Arc::new(WhisperTranscriber::load(path)?);
        let mut inner = self.lock();
        inner.engine = Some(CachedEngine {
            path: path.to_path_buf(),
            transcriber: loaded.clone(),
        });
        Ok(loaded)
    }

    #[cfg(not(unix))]
    pub fn local_engine(
        &self,
        _path: &Path,
    ) -> Result<Arc<LocalEngineUnavailable>, LocalEngineUnavailableError> {
        Err(LocalEngineUnavailableError)
    }

    #[cfg(unix)]
    pub fn forget_engine(&self) {
        self.lock().engine = None;
    }

    #[cfg(not(unix))]
    pub fn forget_engine(&self) {}

    pub fn download_in_flight(&self, id: &str) -> bool {
        matches!(
            self.lock().downloads.get(id),
            Some(DownloadState::InFlight { .. })
        )
    }

    pub fn claim_download(&self, id: &str) -> Result<DownloadLease, models::ModelError> {
        models::find(id).ok_or_else(|| models::ModelError::UnknownModel { id: id.to_string() })?;
        let mut inner = self.lock();
        if matches!(
            inner.downloads.get(id),
            Some(DownloadState::InFlight { .. })
        ) {
            return Err(models::ModelError::DownloadActive { id: id.to_string() });
        }
        inner
            .downloads
            .insert(id.to_string(), DownloadState::InFlight { progress: 0.0 });
        Ok(DownloadLease {
            inner: self.inner.clone(),
            id: id.to_string(),
            finished: false,
        })
    }

    pub fn delete_model(&self, models_dir: &Path, id: &str) -> Result<u64, models::ModelError> {
        models::find(id).ok_or_else(|| models::ModelError::UnknownModel { id: id.to_string() })?;
        // Hold admission through deletion; an active lease owns publication until it ends.
        let mut inner = self.lock();
        if matches!(
            inner.downloads.get(id),
            Some(DownloadState::InFlight { .. })
        ) {
            return Err(models::ModelError::DownloadActive { id: id.to_string() });
        }
        let freed = models::delete(models_dir, id)?;
        inner.downloads.remove(id);
        #[cfg(unix)]
        {
            inner.engine = None;
        }
        Ok(freed)
    }

    pub fn download_state(&self, id: &str) -> Option<DownloadState> {
        self.lock().downloads.get(id).cloned()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().expect("voice runtime lock")
    }
}

pub struct DownloadLease {
    inner: Arc<Mutex<Inner>>,
    id: String,
    finished: bool,
}

impl DownloadLease {
    pub fn progress(&self, progress: f32) {
        let mut inner = self.inner.lock().expect("voice runtime lock");
        inner.downloads.insert(
            self.id.clone(),
            DownloadState::InFlight {
                progress: progress.clamp(0.0, 1.0),
            },
        );
    }

    pub fn finish(mut self, failure: Option<String>) {
        self.end(failure);
        self.finished = true;
    }

    fn end(&self, failure: Option<String>) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        match failure {
            Some(reason) => {
                inner
                    .downloads
                    .insert(self.id.clone(), DownloadState::Failed { reason });
            }
            None => {
                inner.downloads.remove(&self.id);
            }
        }
    }
}

impl Drop for DownloadLease {
    fn drop(&mut self) {
        if !self.finished {
            self.end(Some(format!(
                "model {:?} download was interrupted; retry the download",
                self.id
            )));
        }
    }
}

#[cfg(not(unix))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalEngineUnavailableError;

#[cfg(not(unix))]
impl std::fmt::Display for LocalEngineUnavailableError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "the local whisper engine is not built on this platform (voice \
             dictation is Linux-only in this build; the local engine is \
             `cfg(unix)`-gated)"
        )
    }
}

#[cfg(not(unix))]
impl std::error::Error for LocalEngineUnavailableError {}

#[cfg(not(unix))]
#[derive(Debug)]
pub struct LocalEngineUnavailable;

#[cfg(not(unix))]
impl super::Transcriber for LocalEngineUnavailable {
    type Error = LocalEngineUnavailableError;

    fn transcribe(
        &self,
        _audio: &super::AudioBuffer,
        _request: &super::TranscribeRequest<'_>,
    ) -> Result<super::Transcript, Self::Error> {
        Err(LocalEngineUnavailableError)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_runtime_holds_no_device_and_no_target() {
        let rt = Runtime::new();
        assert!(!rt.is_open());
        assert_eq!(rt.listening_for(), None);
        assert_eq!(rt.open_device_name(), None);
    }

    #[test]
    fn arming_without_an_open_stream_is_a_named_refusal_not_a_panic() {
        let rt = Runtime::new();
        let err = rt.arm(7).expect_err("arming a closed runtime must fail");
        assert_eq!(err, CaptureError::NoInputDevice);
        assert_eq!(rt.listening_for(), None, "a failed arm sets no target");
    }

    #[test]
    fn disarming_without_an_open_stream_is_a_named_refusal() {
        let rt = Runtime::new();
        let err = rt
            .disarm()
            .expect_err("disarming a closed runtime must fail");
        assert_eq!(err, CaptureError::NoInputDevice);
    }

    #[test]
    fn closing_a_closed_runtime_is_a_no_op() {
        let rt = Runtime::new();
        rt.close();
        rt.close();
        assert!(!rt.is_open());
    }

    #[test]
    fn download_state_transitions_are_what_the_settings_page_reads() {
        let rt = Runtime::new();
        assert_eq!(rt.download_state("ggml-small"), None);
        assert!(!rt.download_in_flight("ggml-small"));

        let lease = rt.claim_download("ggml-small").unwrap();
        assert!(rt.download_in_flight("ggml-small"));
        lease.progress(0.5);
        assert_eq!(
            rt.download_state("ggml-small"),
            Some(DownloadState::InFlight { progress: 0.5 })
        );

        lease.finish(Some("sha-256 mismatch".to_string()));
        assert_eq!(
            rt.download_state("ggml-small"),
            Some(DownloadState::Failed {
                reason: "sha-256 mismatch".to_string()
            })
        );
        assert!(!rt.download_in_flight("ggml-small"));

        let lease = rt.claim_download("ggml-small").unwrap();
        assert_eq!(
            rt.download_state("ggml-small"),
            Some(DownloadState::InFlight { progress: 0.0 })
        );
        lease.finish(None);
        assert_eq!(
            rt.download_state("ggml-small"),
            None,
            "a success leaves nothing in memory: what is on disk is the answer"
        );
    }

    #[test]
    fn download_progress_is_clamped_to_the_zero_to_one_range() {
        let rt = Runtime::new();
        let lease = rt.claim_download("ggml-small").unwrap();
        lease.progress(4.2);
        assert_eq!(
            rt.download_state("ggml-small"),
            Some(DownloadState::InFlight { progress: 1.0 })
        );
        lease.progress(-1.0);
        assert_eq!(
            rt.download_state("ggml-small"),
            Some(DownloadState::InFlight { progress: 0.0 })
        );
    }

    #[test]
    fn admission_is_atomic_and_delete_cannot_clear_an_active_lease() {
        let rt = Arc::new(Runtime::new());
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let threads: Vec<_> = (0..2)
            .map(|_| {
                let rt = rt.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    rt.claim_download("ggml-small")
                })
            })
            .collect();
        barrier.wait();
        let claims: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert_eq!(claims.iter().filter(|c| c.is_ok()).count(), 1);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ggml-small.bin");
        std::fs::write(&path, b"installed").unwrap();
        assert!(matches!(
            rt.delete_model(dir.path(), "ggml-small"),
            Err(models::ModelError::DownloadActive { .. })
        ));
        assert!(rt.download_in_flight("ggml-small"));
        assert!(path.exists());
        drop(claims);
        assert!(!rt.download_in_flight("ggml-small"));
        assert_eq!(rt.delete_model(dir.path(), "ggml-small").unwrap(), 9);
    }

    #[tokio::test]
    async fn abort_before_poll_and_panic_release_admission_and_report_failure() {
        let rt = Runtime::new();
        let lease = rt.claim_download("ggml-small").unwrap();
        let task = tokio::spawn(async move {
            let _lease = lease;
            std::future::pending::<()>().await;
        });
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(!rt.download_in_flight("ggml-small"));
        assert!(matches!(
            rt.download_state("ggml-small"),
            Some(DownloadState::Failed { .. })
        ));
        let lease = rt.claim_download("ggml-small").unwrap();
        let task = tokio::spawn(async move {
            let _lease = lease;
            panic!("synthetic download worker panic");
        });
        assert!(task.await.unwrap_err().is_panic());
        assert!(!rt.download_in_flight("ggml-small"));
        assert!(rt.claim_download("ggml-small").is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn loading_a_missing_model_names_the_path_and_caches_nothing() {
        let rt = Runtime::new();
        let missing = Path::new("/nonexistent/ggml-not-here.bin");
        let err = rt
            .local_engine(missing)
            .expect_err("a missing model must not load");
        assert!(
            err.to_string().contains("ggml-not-here.bin"),
            "the offending path must be named: {err}"
        );
        assert!(
            rt.lock().engine.is_none(),
            "a failed load must not populate the cache"
        );
    }

    #[cfg(not(unix))]
    #[test]
    fn local_engine_is_a_named_refusal_on_this_platform() {
        let rt = Runtime::new();
        let err = rt
            .local_engine(Path::new("C:/ggml-small.bin"))
            .expect_err("a gated-out engine must refuse");
        assert!(
            err.to_string().contains("not built on this platform"),
            "the refusal must name the platform fact: {err}"
        );
    }

    #[test]
    fn the_meter_reports_only_the_edges_of_aggregate_interest() {
        let rt = Runtime::new();
        assert!(!rt.is_monitoring());

        assert_eq!(rt.set_monitor(1, true), MonitorTransition::Started);
        assert!(rt.is_monitoring());
        assert_eq!(rt.set_monitor(2, true), MonitorTransition::Unchanged);
        assert_eq!(rt.set_monitor(1, false), MonitorTransition::Unchanged);
        assert!(rt.is_monitoring(), "connection 2 is still watching");
        assert_eq!(rt.set_monitor(2, false), MonitorTransition::Stopped);
        assert!(!rt.is_monitoring());
    }

    #[test]
    fn a_repeated_enable_cannot_pin_the_microphone_open() {
        let rt = Runtime::new();
        assert_eq!(rt.set_monitor(7, true), MonitorTransition::Started);
        assert_eq!(rt.set_monitor(7, true), MonitorTransition::Unchanged);
        assert_eq!(rt.set_monitor(7, false), MonitorTransition::Stopped);
        assert!(!rt.is_monitoring());
    }

    #[test]
    fn a_disconnect_releases_the_meter_even_though_the_ui_never_said_stop() {
        let rt = Runtime::new();
        rt.set_monitor(3, true);
        assert_eq!(rt.release_monitor(3), MonitorTransition::Stopped);
        assert!(!rt.is_monitoring());
        assert_eq!(rt.release_monitor(99), MonitorTransition::Unchanged);
    }

    #[test]
    fn the_level_reads_as_absent_rather_than_zero_when_no_stream_is_open() {
        let rt = Runtime::new();
        assert_eq!(rt.level(), None);
    }
}
