pub mod capture;
pub mod cloud;
pub mod models;
pub mod runtime;
#[cfg(unix)]
pub mod whisper;

#[derive(Debug, Clone)]
pub struct AudioBuffer {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

#[derive(Debug, Clone, Copy)]
pub struct TranscribeRequest<'a> {
    pub language: Option<&'a str>,
    pub translate: bool,
    pub prompt: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transcript {
    pub text: String,
    pub translated: bool,
}

pub trait Transcriber {
    type Error: std::error::Error;

    fn transcribe(
        &self,
        audio: &AudioBuffer,
        request: &TranscribeRequest<'_>,
    ) -> Result<Transcript, Self::Error>;
}
