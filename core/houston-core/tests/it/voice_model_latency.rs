#![cfg(unix)]

use std::path::PathBuf;
use std::time::Instant;

use houston_core::voice::{
    models, reuse, whisper::WhisperTranscriber, AudioBuffer, TranscribeRequest, Transcriber,
};
use sha2::{Digest, Sha256};

#[test]
#[ignore = "requires explicitly supplied catalogue models and a fixed 16 kHz mono PCM16 WAV; run on an idle Linux host"]
fn catalogue_latency_fixed_language_and_auto() {
    let model_dir = PathBuf::from(
        std::env::var_os("HOUSTON_VOICE_BENCH_MODELS")
            .expect("set HOUSTON_VOICE_BENCH_MODELS to the directory of verified ggml-*.bin files"),
    );
    let clip_path = PathBuf::from(
        std::env::var_os("HOUSTON_VOICE_BENCH_CLIP")
            .expect("set HOUSTON_VOICE_BENCH_CLIP to the fixed English WAV clip"),
    );
    assert!(
        clip_path.metadata().unwrap().len() <= 10 * 1024 * 1024,
        "benchmark WAV must not exceed 10 MiB"
    );
    let clip_hash = format!("{:x}", Sha256::digest(std::fs::read(&clip_path).unwrap()));
    let mut reader = hound::WavReader::open(&clip_path).unwrap();
    let spec = reader.spec();
    assert_eq!(spec.channels, 1, "benchmark requires mono audio");
    assert_eq!(spec.sample_rate, 16_000, "benchmark requires 16 kHz audio");
    assert_eq!(spec.bits_per_sample, 16, "benchmark requires PCM16 audio");
    assert_eq!(spec.sample_format, hound::SampleFormat::Int);
    assert!(
        (1..=300 * 16_000).contains(&reader.duration()),
        "clip must contain between 1 sample and 300 seconds"
    );
    let samples = reader
        .samples::<i16>()
        .map(|sample| f32::from(sample.unwrap()) / 32768.0)
        .collect();
    let audio = AudioBuffer {
        samples,
        sample_rate: 16_000,
    };
    let seconds = audio.samples.len() as f64 / f64::from(audio.sample_rate);
    println!(
        "clip={} sha256={clip_hash} seconds={seconds:.3} logical_cpus={}",
        clip_path.display(),
        std::thread::available_parallelism().map_or(1, |n| n.get())
    );
    println!("model\tload_ms\tfixed_en_ms\tauto_ms");
    for model in models::CATALOG {
        let path = model_dir.join(format!("{}.bin", model.id));
        reuse::verify_file(&path, model)
            .expect("benchmark never downloads and accepts only catalogue SHA-256 matches");
        let start = Instant::now();
        let engine = WhisperTranscriber::load(&path).unwrap();
        let load_ms = start.elapsed().as_secs_f64() * 1000.0;
        let mut measured = Vec::new();
        for language in [Some("en"), None] {
            let request = TranscribeRequest {
                language,
                translate: false,
                prompt: "",
            };
            let start = Instant::now();
            let transcript = engine.transcribe(&audio, &request).unwrap();
            measured.push(start.elapsed().as_secs_f64() * 1000.0);
            assert!(
                !transcript.text.trim().is_empty(),
                "{} produced no transcript",
                model.id
            );
        }
        println!(
            "{}\t{load_ms:.3}\t{:.3}\t{:.3}",
            model.id, measured[0], measured[1]
        );
        println!("guidance={} {}", model.id, reuse::guidance(model));
    }
}
