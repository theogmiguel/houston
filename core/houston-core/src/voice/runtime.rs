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
    inner: Mutex<Inner>,
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

    pub fn download_begin(&self, id: &str) {
        self.lock()
            .downloads
            .insert(id.to_string(), DownloadState::InFlight { progress: 0.0 });
    }

    pub fn download_progress(&self, id: &str, progress: f32) {
        self.lock().downloads.insert(
            id.to_string(),
            DownloadState::InFlight {
                progress: progress.clamp(0.0, 1.0),
            },
        );
    }

    pub fn download_end(&self, id: &str, failure: Option<String>) {
        let mut inner = self.lock();
        match failure {
            Some(reason) => {
                inner
                    .downloads
                    .insert(id.to_string(), DownloadState::Failed { reason });
            }
            None => {
                inner.downloads.remove(id);
            }
        }
    }

    pub fn download_forget(&self, id: &str) {
        self.lock().downloads.remove(id);
    }

    pub fn download_state(&self, id: &str) -> Option<DownloadState> {
        self.lock().downloads.get(id).cloned()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().expect("voice runtime lock")
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

        rt.download_begin("ggml-small");
        assert!(rt.download_in_flight("ggml-small"));
        rt.download_progress("ggml-small", 0.5);
        assert_eq!(
            rt.download_state("ggml-small"),
            Some(DownloadState::InFlight { progress: 0.5 })
        );

        rt.download_end("ggml-small", Some("sha-256 mismatch".to_string()));
        assert_eq!(
            rt.download_state("ggml-small"),
            Some(DownloadState::Failed {
                reason: "sha-256 mismatch".to_string()
            })
        );
        assert!(!rt.download_in_flight("ggml-small"));

        rt.download_begin("ggml-small");
        assert_eq!(
            rt.download_state("ggml-small"),
            Some(DownloadState::InFlight { progress: 0.0 })
        );
        rt.download_end("ggml-small", None);
        assert_eq!(
            rt.download_state("ggml-small"),
            None,
            "a success leaves nothing in memory: what is on disk is the answer"
        );
    }

    #[test]
    fn download_progress_is_clamped_to_the_zero_to_one_range() {
        let rt = Runtime::new();
        rt.download_progress("ggml-small", 4.2);
        assert_eq!(
            rt.download_state("ggml-small"),
            Some(DownloadState::InFlight { progress: 1.0 })
        );
        rt.download_progress("ggml-small", -1.0);
        assert_eq!(
            rt.download_state("ggml-small"),
            Some(DownloadState::InFlight { progress: 0.0 })
        );
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
