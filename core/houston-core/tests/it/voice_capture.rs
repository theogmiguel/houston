use houston_core::voice::capture::{
    self, downmix, gate, new_ring, overrun_message, push_frame, resample_linear, CaptureError,
    RING_CAPACITY_SAMPLES, RMS_FLOOR, TARGET_SAMPLE_RATE,
};
use std::sync::atomic::{AtomicU64, Ordering};

fn synthetic_stereo_tone(freq_hz: f32, amplitude: f32, secs: f32, native_rate: u32) -> Vec<f32> {
    let n = (secs * native_rate as f32) as usize;
    (0..n)
        .flat_map(|i| {
            let t = i as f32 / native_rate as f32;
            let s = amplitude * (2.0 * std::f32::consts::PI * freq_hz * t).sin();
            [s, s]
        })
        .collect()
}

#[test]
fn a_full_synthetic_capture_session_survives_the_public_api_round_trip() {
    let native_rate = 44_100u32;
    let secs = 1.2f32;
    let stereo = synthetic_stereo_tone(220.0, 0.5, secs, native_rate);

    let mono = downmix(&stereo, 2);
    let resampled = resample_linear(&mono, native_rate, TARGET_SAMPLE_RATE);

    let (mut producer, mut consumer) = new_ring();
    let dropped = AtomicU64::new(0);
    for chunk in resampled.chunks(480) {
        let n = push_frame(&mut producer, chunk, &dropped);
        assert_eq!(n, 0, "a >1s utterance must never overrun a 5s ring buffer");
    }
    assert_eq!(dropped.load(Ordering::Relaxed), 0);

    let mut drained = Vec::new();
    while let Ok(s) = consumer.pop() {
        drained.push(s);
    }
    let expected = (TARGET_SAMPLE_RATE as f32 * secs) as usize;
    assert!(
        (drained.len() as i64 - expected as i64).abs() <= 2,
        "drained sample count must track the resampled length: got {}, expected ~{expected}",
        drained.len()
    );

    gate(&drained, TARGET_SAMPLE_RATE, RMS_FLOOR)
        .expect("a real-amplitude utterance must clear the public gate() API");
}

#[test]
fn public_gate_api_reports_every_section_11_row_it_owns() {
    let short = vec![0.5f32; (TARGET_SAMPLE_RATE as f32 * 0.1) as usize];
    match gate(&short, TARGET_SAMPLE_RATE, RMS_FLOOR) {
        Err(CaptureError::TooShort { secs, floor }) => {
            assert!(secs < floor);
        }
        other => panic!("expected TooShort, got {other:?}"),
    }

    let quiet = vec![0.0001f32; TARGET_SAMPLE_RATE as usize];
    match gate(&quiet, TARGET_SAMPLE_RATE, RMS_FLOOR) {
        Err(CaptureError::TooQuiet { rms, floor }) => {
            assert!(rms < floor);
        }
        other => panic!("expected TooQuiet, got {other:?}"),
    }

    let (mut producer, _consumer) = new_ring();
    let dropped = AtomicU64::new(0);
    let flood: Vec<f32> = vec![1.0; RING_CAPACITY_SAMPLES + 1000];
    let n = push_frame(&mut producer, &flood, &dropped);
    assert_eq!(
        n, 1000,
        "exactly the overflow past capacity must be dropped"
    );
    assert_eq!(dropped.load(Ordering::Relaxed), 1000);
    let msg = overrun_message(dropped.load(Ordering::Relaxed));
    assert!(
        msg.contains("1000"),
        "the overrun message must name the cumulative dropped count: {msg}"
    );
}

#[test]
fn capture_open_is_never_exercised_here_by_design() {
    let _ = capture::STREAM_SILENT_TIMEOUT;
}
