use std::fmt;
use std::path::{Path, PathBuf};

use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use super::{AudioBuffer, TranscribeRequest, Transcriber, Transcript};

/// Whisper's encoder covers a fixed 30 s window of 1500 frames; a short clip is
/// otherwise encoded with 30 s of padding.
const WINDOW_SECS: f32 = 30.0;
const WINDOW_FRAMES: i32 = 1500;
/// Frames kept beyond the clip so its last word is not cut at the window edge.
const AUDIO_CTX_MARGIN: i32 = 64;
/// Hyperthreads and efficiency cores slow the encoder down past this point: on a
/// 12-thread i7-1355U, 5 s of speech took 2.2 s at 6 threads and 3.1 s at 8.
const MAX_THREADS: usize = 6;

/// The encoder window for a clip: sized to the clip below 30 s, the full window
/// otherwise (longer audio is decoded window by window).
fn audio_ctx_for(samples: usize, sample_rate: u32) -> i32 {
    let secs = samples as f32 / sample_rate as f32;
    if secs >= WINDOW_SECS {
        return WINDOW_FRAMES;
    }
    ((secs / WINDOW_SECS * WINDOW_FRAMES as f32).ceil() as i32 + AUDIO_CTX_MARGIN)
        .min(WINDOW_FRAMES)
}

/// Whether an auto-language transcription first primes the encoder window: whisper.cpp
/// detects the language before applying `audio_ctx`, so detection encodes the full 30 s
/// window (5 s of speech on an i7-1355U: 10 s unprimed, 4.5 s primed, 2 s with a language).
fn primes_detection(language: Option<&str>, audio_ctx: i32) -> bool {
    language.is_none() && audio_ctx < WINDOW_FRAMES
}

/// Audio fed to the priming pass: whisper.cpp needs at least 100 ms, and a short
/// prefix keeps the pass to one window encode and one decoded token.
const PRIME_SAMPLES: usize = 16_000;

/// One thread per physical core, up to `MAX_THREADS`; whisper.cpp defaults to 4.
fn thread_count(available: usize) -> i32 {
    (available / 2).clamp(1, MAX_THREADS) as i32
}

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
        let audio_ctx = audio_ctx_for(audio.samples.len(), audio.sample_rate);
        let threads = thread_count(std::thread::available_parallelism().map_or(1, |n| n.get()));
        params.set_audio_ctx(audio_ctx);
        params.set_n_threads(threads);

        if primes_detection(request.language, audio_ctx) {
            let mut prime = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
            prime.set_language(Some("en"));
            prime.set_audio_ctx(audio_ctx);
            prime.set_n_threads(threads);
            prime.set_no_context(true);
            prime.set_single_segment(true);
            prime.set_max_tokens(1);
            prime.set_print_progress(false);
            prime.set_print_special(false);
            prime.set_print_realtime(false);
            prime.set_print_timestamps(false);
            let prefix = &audio.samples[..audio.samples.len().min(PRIME_SAMPLES)];
            state
                .full(prime, prefix)
                .map_err(WhisperEngineError::Transcribe)?;
        }

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
    Verification(String),
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
            WhisperEngineError::Verification(message) => f.write_str(message),
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
    fn a_short_clip_gets_an_encoder_window_sized_to_it() {
        // 5 s of 16 kHz audio: 250 frames plus the margin, not the full 1500.
        assert_eq!(audio_ctx_for(5 * 16_000, 16_000), 250 + AUDIO_CTX_MARGIN);
        assert_eq!(audio_ctx_for(29 * 16_000, 16_000), WINDOW_FRAMES);
        assert_eq!(audio_ctx_for(30 * 16_000, 16_000), WINDOW_FRAMES);
        assert_eq!(audio_ctx_for(120 * 16_000, 16_000), WINDOW_FRAMES);
    }

    #[test]
    fn only_an_auto_language_short_clip_primes_detection() {
        assert!(primes_detection(None, 314));
        assert!(!primes_detection(Some("pt"), 314));
        assert!(!primes_detection(None, WINDOW_FRAMES));
    }

    #[test]
    fn thread_count_uses_physical_cores_up_to_the_measured_cap() {
        assert_eq!(thread_count(1), 1);
        assert_eq!(thread_count(4), 2);
        assert_eq!(thread_count(12), 6);
        assert_eq!(thread_count(32), MAX_THREADS as i32);
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
