use std::fmt;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rtrb::{Consumer, Producer, RingBuffer};

pub const TARGET_SAMPLE_RATE: u32 = 16_000;

pub const RMS_FLOOR: f32 = houston_protocol::DEFAULT_RMS_FLOOR;

pub const MIN_UTTERANCE_SECS: f32 = 0.3;

pub const RING_CAPACITY_SAMPLES: usize = 5 * TARGET_SAMPLE_RATE as usize;

pub const STREAM_SILENT_TIMEOUT: Duration = Duration::from_secs(5);

pub fn new_ring() -> (Producer<f32>, Consumer<f32>) {
    RingBuffer::<f32>::new(RING_CAPACITY_SAMPLES)
}

pub fn push_frame(producer: &mut Producer<f32>, frame: &[f32], dropped: &AtomicU64) -> u64 {
    let mut dropped_this_call = 0u64;
    for &sample in frame {
        if producer.push(sample).is_err() {
            dropped_this_call += 1;
        }
    }
    if dropped_this_call > 0 {
        dropped.fetch_add(dropped_this_call, Ordering::Relaxed);
    }
    dropped_this_call
}

pub fn overrun_message(cumulative_dropped: u64) -> String {
    format!("Audio ring buffer full; dropped samples in callback (cumulative_dropped={cumulative_dropped})")
}

pub fn downmix(interleaved: &[f32], channels: u16) -> Vec<f32> {
    let channels = channels.max(1) as usize;
    if channels == 1 {
        return interleaved.to_vec();
    }
    interleaved
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
        .collect()
}

pub fn resample_linear(input: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if from_rate == to_rate || input.is_empty() {
        return input.to_vec();
    }
    let ratio = from_rate as f64 / to_rate as f64;
    let out_len = ((input.len() as f64) / ratio).round() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src_pos = i as f64 * ratio;
        let idx = src_pos.floor() as usize;
        let frac = (src_pos - idx as f64) as f32;
        let a = input[idx.min(input.len() - 1)];
        let b = input[(idx + 1).min(input.len() - 1)];
        out.push(a + (b - a) * frac);
    }
    out
}

pub fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_sq: f64 = samples.iter().map(|&s| (s as f64) * (s as f64)).sum();
    ((sum_sq / samples.len() as f64).sqrt()) as f32
}

#[derive(Debug, Clone, PartialEq)]
pub enum CaptureError {
    TooQuiet {
        rms: f32,
        floor: f32,
    },
    TooShort {
        secs: f32,
        floor: f32,
    },
    StreamDead {
        device: String,
        silent_for: Duration,
    },
    NoInputDevice,
    DeviceUnavailable {
        device: String,
        reason: String,
    },
}

impl fmt::Display for CaptureError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CaptureError::TooQuiet { rms, floor } => write!(
                f,
                "Audio too quiet (RMS: {rms:.4}, floor: {floor:.4}), skipping transcription."
            ),
            CaptureError::TooShort { secs, floor } => write!(
                f,
                "Audio too short ({secs:.2}s < {floor:.2}s), skipping transcription."
            ),
            CaptureError::StreamDead { device, silent_for } => write!(
                f,
                "audio input device {device:?} has produced no callback in {:.1}s — treating the \
                 stream as dead (not auto-recovering; re-enable dictation to reopen it)",
                silent_for.as_secs_f32()
            ),
            CaptureError::NoInputDevice => write!(
                f,
                "no audio input device is available (host reported no default input device)"
            ),
            CaptureError::DeviceUnavailable { device, reason } => {
                write!(
                    f,
                    "audio input device {device:?} could not be opened: {reason}"
                )
            }
        }
    }
}

impl std::error::Error for CaptureError {}

pub fn gate(samples: &[f32], sample_rate: u32, rms_floor: f32) -> Result<(), CaptureError> {
    let secs = samples.len() as f32 / sample_rate as f32;
    if secs < MIN_UTTERANCE_SECS {
        return Err(CaptureError::TooShort {
            secs,
            floor: MIN_UTTERANCE_SECS,
        });
    }
    let measured = rms(samples);
    if measured < rms_floor {
        return Err(CaptureError::TooQuiet {
            rms: measured,
            floor: rms_floor,
        });
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceInfo {
    pub id: String,
    pub label: String,
    pub is_default: bool,
}

fn device_id(device: &cpal::Device) -> Option<String> {
    use cpal::traits::DeviceTrait;
    device.id().ok().map(|id| id.to_string())
}

pub fn list_devices() -> Result<Vec<DeviceInfo>, CaptureError> {
    use cpal::traits::HostTrait;

    let host = cpal::default_host();
    let default_id = host.default_input_device().as_ref().and_then(device_id);
    let devices = host
        .input_devices()
        .map_err(|e| CaptureError::DeviceUnavailable {
            device: "<enumeration>".to_string(),
            reason: e.to_string(),
        })?;
    let mut out = Vec::new();
    for device in devices {
        let Some(id) = device_id(&device) else {
            continue;
        };
        let is_default = default_id.as_deref() == Some(id.as_str());
        out.push(DeviceInfo {
            label: device.to_string(),
            id,
            is_default,
        });
    }
    Ok(out)
}

pub struct Capture {
    _stream: cpal::Stream,
    consumer: Consumer<f32>,
    dropped: Arc<AtomicU64>,
    last_callback: Arc<Mutex<Instant>>,
    device_name: String,
}

impl Capture {
    pub fn open() -> Result<Self, CaptureError> {
        Self::open_device(None)
    }

    pub fn open_device(selected: Option<&str>) -> Result<Self, CaptureError> {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

        let host = cpal::default_host();
        let device = match selected {
            None => host
                .default_input_device()
                .ok_or(CaptureError::NoInputDevice)?,
            Some(id) => host
                .input_devices()
                .map_err(|e| CaptureError::DeviceUnavailable {
                    device: id.to_string(),
                    reason: e.to_string(),
                })?
                .find(|d| device_id(d).as_deref() == Some(id))
                .ok_or_else(|| CaptureError::DeviceUnavailable {
                    device: id.to_string(),
                    reason: "no input device with this id is present any more (it was unplugged, \
                             renamed, or belongs to another audio host)"
                        .to_string(),
                })?,
        };
        let device_name = device.to_string();
        let supported =
            device
                .default_input_config()
                .map_err(|e| CaptureError::DeviceUnavailable {
                    device: device_name.clone(),
                    reason: e.to_string(),
                })?;
        let sample_format = supported.sample_format();
        let config: cpal::StreamConfig = supported.config();
        let source_rate = config.sample_rate;
        let channels = config.channels;

        let (mut producer, consumer) = new_ring();
        let dropped = Arc::new(AtomicU64::new(0));
        let last_callback = Arc::new(Mutex::new(Instant::now()));

        let dropped_cb = dropped.clone();
        let last_callback_cb = last_callback.clone();
        let device_name_cb = device_name.clone();
        let data_callback = move |data: &cpal::Data, _: &cpal::InputCallbackInfo| {
            *last_callback_cb.lock().expect("capture last_callback lock") = Instant::now();
            let mono = match sample_format {
                cpal::SampleFormat::F32 => data
                    .as_slice::<f32>()
                    .map(|s| downmix(s, channels))
                    .unwrap_or_default(),
                cpal::SampleFormat::I16 => data
                    .as_slice::<i16>()
                    .map(|s| {
                        let f: Vec<f32> = s.iter().map(|&v| v as f32 / i16::MAX as f32).collect();
                        downmix(&f, channels)
                    })
                    .unwrap_or_default(),
                cpal::SampleFormat::U16 => data
                    .as_slice::<u16>()
                    .map(|s| {
                        let f: Vec<f32> = s
                            .iter()
                            .map(|&v| (v as f32 - 32_768.0) / 32_768.0)
                            .collect();
                        downmix(&f, channels)
                    })
                    .unwrap_or_default(),
                other => {
                    tracing::warn!(
                        device = %device_name_cb,
                        format = ?other,
                        "voice capture: unsupported cpal sample format, dropping this callback's frame"
                    );
                    Vec::new()
                }
            };
            let resampled = resample_linear(&mono, source_rate, TARGET_SAMPLE_RATE);
            let n = push_frame(&mut producer, &resampled, &dropped_cb);
            if n > 0 {
                tracing::warn!(
                    device = %device_name_cb,
                    "{}",
                    overrun_message(dropped_cb.load(Ordering::Relaxed))
                );
            }
        };
        let error_device_name = device_name.clone();
        let error_callback = move |err: cpal::Error| {
            tracing::warn!(device = %error_device_name, error = %err, "voice capture: stream error");
        };

        let stream = device
            .build_input_stream_raw(config, sample_format, data_callback, error_callback, None)
            .map_err(|e| CaptureError::DeviceUnavailable {
                device: device_name.clone(),
                reason: e.to_string(),
            })?;
        stream.play().map_err(|e| CaptureError::DeviceUnavailable {
            device: device_name.clone(),
            reason: e.to_string(),
        })?;

        Ok(Capture {
            _stream: stream,
            consumer,
            dropped,
            last_callback,
            device_name,
        })
    }

    pub fn drain(&mut self) -> Vec<f32> {
        let mut out = Vec::with_capacity(self.consumer.slots());
        while let Ok(sample) = self.consumer.pop() {
            out.push(sample);
        }
        out
    }

    pub fn dropped_count(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    pub fn health_check(&self) -> Result<(), CaptureError> {
        let last = *self
            .last_callback
            .lock()
            .expect("capture last_callback lock");
        let silent_for = last.elapsed();
        if silent_for > STREAM_SILENT_TIMEOUT {
            return Err(CaptureError::StreamDead {
                device: self.device_name.clone(),
                silent_for,
            });
        }
        Ok(())
    }

    pub fn device_name(&self) -> &str {
        &self.device_name
    }
}

const DRAIN_INTERVAL: Duration = Duration::from_millis(20);

pub const MAX_UTTERANCE_SECS: f32 = 300.0;

const MAX_UTTERANCE_SAMPLES: usize = (MAX_UTTERANCE_SECS as usize) * TARGET_SAMPLE_RATE as usize;

#[derive(Debug, Clone, PartialEq)]
pub struct CapturedUtterance {
    pub samples: Vec<f32>,
    pub dropped: u64,
    pub truncated: bool,
    pub health: Result<(), CaptureError>,
}

enum CaptureCommand {
    Arm,
    Disarm(std::sync::mpsc::Sender<CapturedUtterance>),
}

pub struct CaptureThread {
    tx: std::sync::mpsc::Sender<CaptureCommand>,
    device_name: String,
    join: Option<std::thread::JoinHandle<()>>,
    level: Arc<AtomicU32>,
}

impl CaptureThread {
    pub fn open(selected: Option<String>) -> Result<Self, CaptureError> {
        let (cmd_tx, cmd_rx) = std::sync::mpsc::channel::<CaptureCommand>();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<String, CaptureError>>();
        let level = Arc::new(AtomicU32::new(0));
        let loop_level = Arc::clone(&level);
        let join = std::thread::Builder::new()
            .name("tr-voice-capture".to_string())
            .spawn(move || {
                let mut capture = match Capture::open_device(selected.as_deref()) {
                    Ok(c) => {
                        let _ = ready_tx.send(Ok(c.device_name().to_string()));
                        c
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                        return;
                    }
                };
                run_capture_loop(&mut capture, cmd_rx, &loop_level);
            })
            .map_err(|e| CaptureError::DeviceUnavailable {
                device: "<capture thread>".to_string(),
                reason: format!("spawning the capture thread failed: {e}"),
            })?;
        match ready_rx.recv() {
            Ok(Ok(device_name)) => Ok(CaptureThread {
                tx: cmd_tx,
                device_name,
                join: Some(join),
                level,
            }),
            Ok(Err(e)) => Err(e),
            Err(_) => Err(CaptureError::DeviceUnavailable {
                device: "<capture thread>".to_string(),
                reason: "the capture thread exited before reporting whether the device opened"
                    .to_string(),
            }),
        }
    }

    pub fn device_name(&self) -> &str {
        &self.device_name
    }

    pub fn level(&self) -> f32 {
        f32::from_bits(self.level.load(Ordering::Relaxed))
    }

    pub fn arm(&self) -> Result<(), CaptureError> {
        self.tx
            .send(CaptureCommand::Arm)
            .map_err(|_| self.thread_gone())
    }

    pub fn disarm(&self) -> Result<CapturedUtterance, CaptureError> {
        let (tx, rx) = std::sync::mpsc::channel();
        self.tx
            .send(CaptureCommand::Disarm(tx))
            .map_err(|_| self.thread_gone())?;
        rx.recv().map_err(|_| self.thread_gone())
    }

    fn thread_gone(&self) -> CaptureError {
        CaptureError::DeviceUnavailable {
            device: self.device_name.clone(),
            reason: "the capture thread is no longer running (the stream was closed)".to_string(),
        }
    }
}

impl Drop for CaptureThread {
    fn drop(&mut self) {
        if let Some(join) = self.join.take() {
            drop(std::mem::replace(
                &mut self.tx,
                std::sync::mpsc::channel().0,
            ));
            let _ = join.join();
        }
    }
}

fn run_capture_loop(
    capture: &mut Capture,
    rx: std::sync::mpsc::Receiver<CaptureCommand>,
    level: &Arc<AtomicU32>,
) {
    let mut armed = false;
    let mut buf: Vec<f32> = Vec::new();
    let mut truncated = false;
    loop {
        match rx.recv_timeout(DRAIN_INTERVAL) {
            Ok(CaptureCommand::Arm) => {
                armed = true;
                truncated = false;
                buf.clear();
            }
            Ok(CaptureCommand::Disarm(reply)) => {
                let tail = capture.drain();
                if armed && !truncated {
                    buf.extend_from_slice(&tail);
                }
                armed = false;
                let _ = reply.send(CapturedUtterance {
                    samples: std::mem::take(&mut buf),
                    dropped: capture.dropped_count(),
                    truncated,
                    health: capture.health_check(),
                });
                truncated = false;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
        }
        let chunk = capture.drain();
        if !chunk.is_empty() {
            level.store(rms(&chunk).to_bits(), Ordering::Relaxed);
        }
        if armed && !truncated {
            if buf.len() + chunk.len() > MAX_UTTERANCE_SAMPLES {
                let room = MAX_UTTERANCE_SAMPLES.saturating_sub(buf.len());
                buf.extend_from_slice(&chunk[..room.min(chunk.len())]);
                truncated = true;
                tracing::warn!(
                    cap_secs = MAX_UTTERANCE_SECS,
                    "voice capture: utterance hit the {MAX_UTTERANCE_SECS}s cap; \
                     recording stopped and what was captured will be transcribed"
                );
            } else {
                buf.extend_from_slice(&chunk);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine_wave(freq_hz: f32, amplitude: f32, secs: f32) -> Vec<f32> {
        let n = (secs * TARGET_SAMPLE_RATE as f32) as usize;
        (0..n)
            .map(|i| {
                let t = i as f32 / TARGET_SAMPLE_RATE as f32;
                amplitude * (2.0 * std::f32::consts::PI * freq_hz * t).sin()
            })
            .collect()
    }

    fn silence(secs: f32) -> Vec<f32> {
        vec![0.0; (secs * TARGET_SAMPLE_RATE as f32) as usize]
    }

    #[test]
    fn gate_rejects_audio_shorter_than_the_floor() {
        let samples = sine_wave(220.0, 0.5, 0.1);
        let err = gate(&samples, TARGET_SAMPLE_RATE, RMS_FLOOR).unwrap_err();
        match err {
            CaptureError::TooShort { secs, floor } => {
                assert!(
                    (secs - 0.1).abs() < 0.01,
                    "names the measured length: {secs}"
                );
                assert_eq!(floor, MIN_UTTERANCE_SECS, "names the floor");
            }
            other => panic!("expected TooShort, got {other:?}"),
        }
    }

    #[test]
    fn too_short_message_matches_section_11_shape() {
        let err = CaptureError::TooShort {
            secs: 0.12,
            floor: MIN_UTTERANCE_SECS,
        };
        let msg = err.to_string();
        assert!(msg.contains("0.12"), "names the measured value: {msg}");
        assert!(msg.contains("0.30"), "names the floor: {msg}");
        assert!(msg.starts_with("Audio too short"), "{msg}");
    }

    #[test]
    fn gate_rejects_audio_quieter_than_the_rms_floor() {
        let samples = sine_wave(220.0, RMS_FLOOR / 10.0, 1.0);
        let err = gate(&samples, TARGET_SAMPLE_RATE, RMS_FLOOR).unwrap_err();
        match err {
            CaptureError::TooQuiet { rms, floor } => {
                assert!(
                    rms < floor,
                    "measured RMS {rms} must be under the floor {floor}"
                );
                assert!(
                    rms > 0.0,
                    "a real (if quiet) signal, not literal silence: {rms}"
                );
            }
            other => panic!("expected TooQuiet, got {other:?}"),
        }
    }

    #[test]
    fn gate_honors_a_caller_supplied_floor_over_the_default() {
        let samples = sine_wave(220.0, RMS_FLOOR / 2.0, 1.0);
        let measured = rms(&samples);
        assert!(
            measured < RMS_FLOOR,
            "fixture must sit under the default floor: {measured} vs {RMS_FLOOR}"
        );

        let raised = gate(&samples, TARGET_SAMPLE_RATE, RMS_FLOOR).unwrap_err();
        assert!(
            matches!(raised, CaptureError::TooQuiet { floor, .. } if floor == RMS_FLOOR),
            "the default floor must still reject it: {raised:?}"
        );

        gate(&samples, TARGET_SAMPLE_RATE, measured / 2.0)
            .expect("a floor below the measured level must accept the same audio");
    }

    #[test]
    fn gate_rejects_literal_silence() {
        let samples = silence(1.0);
        assert!(matches!(
            gate(&samples, TARGET_SAMPLE_RATE, RMS_FLOOR),
            Err(CaptureError::TooQuiet { .. })
        ));
    }

    #[test]
    fn too_quiet_message_matches_section_11_shape() {
        let err = CaptureError::TooQuiet {
            rms: 0.003,
            floor: RMS_FLOOR,
        };
        let msg = err.to_string();
        assert!(msg.contains("0.0030"), "names the measured RMS: {msg}");
        assert!(msg.starts_with("Audio too quiet"), "{msg}");
    }

    #[test]
    fn gate_accepts_a_loud_enough_long_enough_utterance() {
        let samples = sine_wave(220.0, 0.5, 1.0);
        gate(&samples, TARGET_SAMPLE_RATE, RMS_FLOOR)
            .expect("a normal-amplitude 1s tone must pass the gate");
    }

    #[test]
    fn gate_boundary_is_inclusive_at_exactly_the_length_floor() {
        let n = (MIN_UTTERANCE_SECS * TARGET_SAMPLE_RATE as f32) as usize;
        let samples: Vec<f32> = sine_wave(220.0, 0.5, MIN_UTTERANCE_SECS)
            .into_iter()
            .take(n)
            .collect();
        assert!(!matches!(
            gate(&samples, TARGET_SAMPLE_RATE, RMS_FLOOR),
            Err(CaptureError::TooShort { .. })
        ));
    }

    #[test]
    fn push_frame_delivers_every_sample_when_the_ring_has_room() {
        let (mut producer, mut consumer) = RingBuffer::<f32>::new(1024);
        let dropped = AtomicU64::new(0);
        let frame = sine_wave(220.0, 0.5, 0.01);
        let n_dropped = push_frame(&mut producer, &frame, &dropped);
        assert_eq!(n_dropped, 0);
        assert_eq!(dropped.load(Ordering::Relaxed), 0);
        let mut drained = Vec::new();
        while let Ok(s) = consumer.pop() {
            drained.push(s);
        }
        assert_eq!(drained, frame);
    }

    #[test]
    fn push_frame_counts_and_survives_overrun_without_panicking() {
        let (mut producer, consumer) = RingBuffer::<f32>::new(10);
        let dropped = AtomicU64::new(0);
        let frame: Vec<f32> = (0..30).map(|i| i as f32).collect();
        let n_dropped = push_frame(&mut producer, &frame, &dropped);
        assert_eq!(
            n_dropped, 20,
            "20 of 30 samples must be dropped (capacity 10)"
        );
        assert_eq!(dropped.load(Ordering::Relaxed), 20);
        assert_eq!(
            consumer.slots(),
            10,
            "the ring itself must hold exactly its capacity"
        );
        let n_dropped_2 = push_frame(&mut producer, &frame, &dropped);
        assert_eq!(
            n_dropped_2, 30,
            "ring is already full, so this whole frame drops"
        );
        assert_eq!(dropped.load(Ordering::Relaxed), 50, "cumulative: 20 + 30");
    }

    #[test]
    fn overrun_message_names_the_cumulative_dropped_count() {
        let msg = overrun_message(1234);
        assert_eq!(
            msg,
            "Audio ring buffer full; dropped samples in callback (cumulative_dropped=1234)"
        );
    }

    #[test]
    fn downmix_mono_is_a_no_op() {
        let samples = vec![0.1, -0.2, 0.3];
        assert_eq!(downmix(&samples, 1), samples);
    }

    #[test]
    fn downmix_stereo_averages_left_and_right() {
        let interleaved = vec![1.0, -1.0, 0.5, 0.5];
        assert_eq!(downmix(&interleaved, 2), vec![0.0, 0.5]);
    }

    #[test]
    fn resample_is_a_no_op_when_rates_already_match() {
        let samples = sine_wave(220.0, 0.5, 0.1);
        assert_eq!(
            resample_linear(&samples, TARGET_SAMPLE_RATE, TARGET_SAMPLE_RATE),
            samples
        );
    }

    #[test]
    fn resample_downsamples_48k_to_16k_to_roughly_a_third_the_length() {
        let samples = sine_wave(220.0, 0.5, 1.0);
        let out = resample_linear(&samples, 48_000, TARGET_SAMPLE_RATE);
        let expected_len = samples.len() / 3;
        assert!(
            (out.len() as i64 - expected_len as i64).abs() <= 1,
            "48kHz -> 16kHz must land within 1 sample of a 3x reduction: got {} expected ~{}",
            out.len(),
            expected_len
        );
    }

    #[test]
    fn resample_preserves_amplitude_within_interpolation_error() {
        let samples = vec![0.7f32; 1000];
        let out = resample_linear(&samples, 44_100, TARGET_SAMPLE_RATE);
        for &s in &out {
            assert!(
                (s - 0.7).abs() < 1e-5,
                "constant signal must resample flat: got {s}"
            );
        }
    }

    #[test]
    fn rms_of_a_constant_signal_is_its_absolute_value() {
        assert!((rms(&[0.5, 0.5, 0.5, 0.5]) - 0.5).abs() < 1e-6);
        assert!((rms(&[-0.5, -0.5]) - 0.5).abs() < 1e-6);
    }

    #[test]
    fn rms_of_empty_is_zero() {
        assert_eq!(rms(&[]), 0.0);
    }

    #[test]
    fn stream_dead_message_names_the_device_and_duration() {
        let err = CaptureError::StreamDead {
            device: "USB Mic".to_string(),
            silent_for: Duration::from_secs(7),
        };
        let msg = err.to_string();
        assert!(msg.contains("USB Mic"), "names the device: {msg}");
        assert!(msg.contains("7.0"), "names the elapsed time: {msg}");
    }

    #[test]
    fn synthetic_capture_session_round_trips_through_ring_resample_and_gate() {
        let native_rate = 48_000u32;
        let secs = 1.0f32;
        let stereo: Vec<f32> = {
            let n = (secs * native_rate as f32) as usize;
            let mono: Vec<f32> = (0..n)
                .map(|i| {
                    let t = i as f32 / native_rate as f32;
                    0.6 * (2.0 * std::f32::consts::PI * 220.0 * t).sin()
                })
                .collect();
            mono.into_iter().flat_map(|s| [s, s]).collect()
        };
        let mono = downmix(&stereo, 2);
        let resampled = resample_linear(&mono, native_rate, TARGET_SAMPLE_RATE);

        let (mut producer, mut consumer) = new_ring();
        let dropped = AtomicU64::new(0);
        for chunk in resampled.chunks(512) {
            let n = push_frame(&mut producer, chunk, &dropped);
            assert_eq!(
                n, 0,
                "ring is sized for 5s; a 1s utterance must never overrun"
            );
        }
        assert_eq!(dropped.load(Ordering::Relaxed), 0);

        let mut drained = Vec::new();
        while let Ok(s) = consumer.pop() {
            drained.push(s);
        }
        assert!(
            (drained.len() as i64 - (TARGET_SAMPLE_RATE as f32 * secs) as i64).abs() <= 2,
            "drained length must match ~{}s at {} Hz: got {}",
            secs,
            TARGET_SAMPLE_RATE,
            drained.len()
        );
        gate(&drained, TARGET_SAMPLE_RATE, RMS_FLOOR)
            .expect("a real-amplitude 1s tone must clear the gate");
    }
}
