use std::fmt;
use std::path::{Path, PathBuf};

use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use super::{AudioBuffer, TranscribeRequest, Transcriber, Transcript};

#[derive(Debug)]
pub struct WhisperTranscriber {
    ctx: WhisperContext,
}

impl WhisperTranscriber {
    pub fn load(model_path: &Path) -> Result<Self, WhisperEngineError> {
        let mut params = WhisperContextParameters::default();
        params.use_gpu(false);
        let ctx = WhisperContext::new_with_params(model_path, params).map_err(|source| {
            WhisperEngineError::LoadModel {
                path: model_path.to_path_buf(),
                source,
            }
        })?;
        Ok(Self { ctx })
    }

    fn transcribe_impl(
        &self,
        audio: &AudioBuffer,
        request: &TranscribeRequest<'_>,
    ) -> Result<Transcript, WhisperEngineError> {
        debug_assert_eq!(
            audio.sample_rate,
            super::capture::TARGET_SAMPLE_RATE,
            "whisper.rs assumes capture.rs already resampled to {} Hz; got {} Hz",
            super::capture::TARGET_SAMPLE_RATE,
            audio.sample_rate
        );
        let mut state = self
            .ctx
            .create_state()
            .map_err(WhisperEngineError::CreateState)?;

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_translate(request.translate);
        params.set_language(request.language);
        if !request.prompt.is_empty() {
            params.set_initial_prompt(request.prompt);
        }
        params.set_no_context(true);
        params.set_print_progress(false);
        params.set_print_special(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_single_segment(false);

        state
            .full(params, &audio.samples)
            .map_err(WhisperEngineError::Transcribe)?;

        let n_segments = state.full_n_segments();
        let mut text = String::new();
        for i in 0..n_segments {
            if let Some(segment) = state.get_segment(i) {
                if let Ok(s) = segment.to_str_lossy() {
                    text.push_str(&s);
                }
            }
        }
        let text = text.trim().to_string();
        if text.is_empty() {
            return Err(WhisperEngineError::Empty);
        }
        Ok(Transcript {
            text,
            translated: request.translate,
        })
    }
}

impl Transcriber for WhisperTranscriber {
    type Error = WhisperEngineError;

    fn transcribe(
        &self,
        audio: &AudioBuffer,
        request: &TranscribeRequest<'_>,
    ) -> Result<Transcript, WhisperEngineError> {
        self.transcribe_impl(audio, request)
    }
}

#[derive(Debug)]
pub enum WhisperEngineError {
    LoadModel {
        path: PathBuf,
        source: whisper_rs::WhisperError,
    },
    CreateState(whisper_rs::WhisperError),
    Transcribe(whisper_rs::WhisperError),
    Empty,
}

impl fmt::Display for WhisperEngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WhisperEngineError::LoadModel { path, source } => {
                write!(f, "loading whisper model {}: {source}", path.display())
            }
            WhisperEngineError::CreateState(source) => {
                write!(f, "starting a whisper transcription state: {source}")
            }
            WhisperEngineError::Transcribe(source) => {
                write!(f, "whisper transcription failed: {source}")
            }
            WhisperEngineError::Empty => write!(f, "No speech detected."),
        }
    }
}

impl std::error::Error for WhisperEngineError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loading_a_missing_model_names_the_path_not_just_whisper_cpps_own_error() {
        let missing = Path::new("/nonexistent/ggml-does-not-exist.bin");
        let err = WhisperTranscriber::load(missing)
            .expect_err("a missing model file must refuse to load");
        let msg = err.to_string();
        assert!(
            msg.contains("ggml-does-not-exist.bin"),
            "the offending path must be named, not just whisper.cpp's own generic error: {msg}"
        );
    }

    #[test]
    fn empty_transcript_message_matches_section_11() {
        assert_eq!(WhisperEngineError::Empty.to_string(), "No speech detected.");
    }

    #[test]
    fn full_params_construction_does_not_panic_for_every_request_shape() {
        for translate in [false, true] {
            for language in [None, Some("pt"), Some("en")] {
                for prompt in ["", "Houston, Claude, pane, workspace"] {
                    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
                    params.set_translate(translate);
                    params.set_language(language);
                    if !prompt.is_empty() {
                        params.set_initial_prompt(prompt);
                    }
                    params.set_no_context(true);
                    params.set_print_progress(false);
                    params.set_print_special(false);
                    params.set_print_realtime(false);
                    params.set_print_timestamps(false);
                    params.set_single_segment(false);
                }
            }
        }
    }
}
