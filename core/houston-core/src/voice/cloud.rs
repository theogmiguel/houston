use std::fmt;
use std::io::Cursor;
use std::time::Duration;

use zeroize::Zeroizing;

use super::{AudioBuffer, TranscribeRequest, Transcriber, Transcript};

const SERVICE: &str = "houston-voice";
const KEY_ENTRY: &str = "groq-api-key";

const BASE_URL: &str = "https://api.groq.com/openai/v1";
const MODEL: &str = "whisper-large-v3";

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

pub struct Secret(Zeroizing<String>);

impl Secret {
    pub fn new(s: String) -> Self {
        Secret(Zeroizing::new(s))
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

fn entry() -> Result<keyring::Entry, CloudError> {
    keyring::Entry::new(SERVICE, KEY_ENTRY)
        .map_err(|source| CloudError::Keychain(source.to_string()))
}

pub fn store_key(secret: &Secret) -> Result<(), CloudError> {
    if secret.is_empty() {
        return Err(CloudError::EmptyKey);
    }
    entry()?
        .set_password(secret.expose())
        .map_err(|e| CloudError::Keychain(e.to_string()))?;
    verify_persisted(load_key()?.as_ref(), secret)
}

fn verify_persisted(stored: Option<&Secret>, expected: &Secret) -> Result<(), CloudError> {
    match stored {
        Some(s) if s.expose() == expected.expose() => Ok(()),
        Some(_) => Err(CloudError::NotPersisted {
            what: "read back as a different value".to_string(),
        }),
        None => Err(CloudError::NotPersisted {
            what: "read back as absent".to_string(),
        }),
    }
}

pub fn keyring_error() -> Option<String> {
    let probe = keyring::Entry::new(SERVICE, "__tr_probe__")
        .map_err(|e| e.to_string())
        .and_then(|e| match e.get_password() {
            Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        });
    probe.err()
}

pub fn load_key() -> Result<Option<Secret>, CloudError> {
    match entry()?.get_password() {
        Ok(p) => Ok(Some(Secret::new(p))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(CloudError::Keychain(e.to_string())),
    }
}

pub fn delete_key() -> Result<(), CloudError> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(CloudError::Keychain(e.to_string())),
    }
}

pub fn has_key() -> bool {
    matches!(load_key(), Ok(Some(_)))
}

pub enum KeyAvailability {
    Present,
    Absent,
    Unreadable(String),
}

pub fn key_availability() -> KeyAvailability {
    availability_of(load_key())
}

fn availability_of(loaded: Result<Option<Secret>, CloudError>) -> KeyAvailability {
    match loaded {
        Ok(Some(_)) => KeyAvailability::Present,
        Ok(None) => KeyAvailability::Absent,
        Err(e) => KeyAvailability::Unreadable(e.to_string()),
    }
}

fn encode_wav(audio: &AudioBuffer) -> Result<Vec<u8>, CloudError> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: audio.sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut cursor = Cursor::new(Vec::new());
    {
        let mut writer = hound::WavWriter::new(&mut cursor, spec).map_err(CloudError::Wav)?;
        for &sample in &audio.samples {
            let clamped = sample.clamp(-1.0, 1.0);
            let pcm16 = (clamped * i16::MAX as f32) as i16;
            writer.write_sample(pcm16).map_err(CloudError::Wav)?;
        }
        writer.finalize().map_err(CloudError::Wav)?;
    }
    Ok(cursor.into_inner())
}

#[derive(serde::Deserialize)]
struct GroqTranscriptionResponse {
    text: String,
}

pub struct GroqTranscriber {
    client: reqwest::blocking::Client,
    base_url: String,
    key: Secret,
}

impl GroqTranscriber {
    pub fn new(key: Secret) -> Result<Self, CloudError> {
        Self::with_base_url(key, BASE_URL.to_string())
    }

    pub fn with_base_url(key: Secret, base_url: String) -> Result<Self, CloudError> {
        let client = reqwest::blocking::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(CloudError::Build)?;
        Ok(Self {
            client,
            base_url,
            key,
        })
    }

    fn transcribe_impl(
        &self,
        audio: &AudioBuffer,
        request: &TranscribeRequest<'_>,
    ) -> Result<Transcript, CloudError> {
        if self.key.is_empty() {
            return Err(CloudError::NoApiKey);
        }
        let wav = encode_wav(audio)?;
        let endpoint = if request.translate {
            "audio/translations"
        } else {
            "audio/transcriptions"
        };
        let url = format!("{}/{endpoint}", self.base_url);

        let file_part = reqwest::blocking::multipart::Part::bytes(wav)
            .file_name("utterance.wav")
            .mime_str("audio/wav")
            .map_err(CloudError::Build)?;
        let mut form = reqwest::blocking::multipart::Form::new()
            .part("file", file_part)
            .text("model", MODEL)
            .text("response_format", "json");
        if !request.prompt.is_empty() {
            form = form.text("prompt", request.prompt.to_string());
        }
        if !request.translate {
            if let Some(lang) = request.language {
                form = form.text("language", lang.to_string());
            }
        }

        let resp = self
            .client
            .post(&url)
            .bearer_auth(self.key.expose())
            .multipart(form)
            .send()
            .map_err(|source| CloudError::Network {
                url: url.clone(),
                source,
            })?;

        let status = resp.status();
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Err(CloudError::KeyRejected {
                status: status.as_u16(),
            });
        }
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            let retry_after = resp
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<u64>().ok())
                .map(Duration::from_secs);
            return Err(CloudError::RateLimited { retry_after });
        }
        if !status.is_success() {
            let body = resp.text().unwrap_or_default();
            let truncated: String = body.chars().take(500).collect();
            return Err(CloudError::ServerError {
                status: status.as_u16(),
                body: truncated,
            });
        }

        let parsed: GroqTranscriptionResponse = resp
            .json()
            .map_err(|source| CloudError::Network { url, source })?;
        let text = parsed.text.trim().to_string();
        if text.is_empty() {
            return Err(CloudError::Empty);
        }
        Ok(Transcript {
            text,
            translated: request.translate,
        })
    }
}

impl Transcriber for GroqTranscriber {
    type Error = CloudError;

    fn transcribe(
        &self,
        audio: &AudioBuffer,
        request: &TranscribeRequest<'_>,
    ) -> Result<Transcript, CloudError> {
        self.transcribe_impl(audio, request)
    }
}

#[derive(Debug)]
pub enum CloudError {
    NoApiKey,
    EmptyKey,
    Keychain(String),
    NotPersisted { what: String },
    Build(reqwest::Error),
    Wav(hound::Error),
    Network { url: String, source: reqwest::Error },
    KeyRejected { status: u16 },
    RateLimited { retry_after: Option<Duration> },
    ServerError { status: u16, body: String },
    Empty,
}

impl fmt::Display for CloudError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CloudError::NoApiKey => write!(
                f,
                "no Groq API key is stored — add one in Settings before using the cloud voice engine"
            ),
            CloudError::EmptyKey => write!(
                f,
                "refusing to store an empty Groq API key — clear the stored key instead if that \
                 is what you meant"
            ),
            CloudError::Keychain(msg) => {
                write!(f, "reaching the system keychain for the Groq API key failed: {msg}")
            }
            CloudError::NotPersisted { what } => write!(
                f,
                "the system keychain accepted the Groq API key and then {what} — the key was NOT \
                 saved. On Linux this usually means the login keyring is locked or missing and \
                 secrets are going to a session-only store that is wiped at logout; unlock it \
                 (Seahorse › Passwords › Login) and set the key again"
            ),
            CloudError::Build(err) => write!(f, "building the Groq HTTP client failed: {err}"),
            CloudError::Wav(err) => {
                write!(f, "encoding captured audio as WAV for upload failed: {err}")
            }
            CloudError::Network { url, source } => {
                write!(f, "reaching Groq's transcription API ({url}) failed: {source}")
            }
            CloudError::KeyRejected { status } => write!(
                f,
                "Groq rejected the stored API key (HTTP {status}) — check or replace it in Settings"
            ),
            CloudError::RateLimited { retry_after } => match retry_after {
                Some(d) => write!(f, "Groq rate-limited this request; retry after {}s", d.as_secs()),
                None => write!(f, "Groq rate-limited this request; retry later"),
            },
            CloudError::ServerError { status, body } => {
                write!(f, "Groq's transcription API returned HTTP {status}: {body}")
            }
            CloudError::Empty => write!(f, "No speech detected."),
        }
    }
}

impl std::error::Error for CloudError {}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::{Multipart, State};
    use axum::http::StatusCode;
    use axum::response::{IntoResponse, Response};
    use axum::routing::post;
    use std::sync::{Arc, Mutex};

    fn use_mock_keychain() {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            let _ = keyring::Entry::new("__tr_mock_priming__", "__tr_mock_priming__");
            keyring_core::set_default_store(
                keyring_core::mock::Store::new().expect("building the mock credential store"),
            );
        });
    }

    #[test]
    fn the_mock_store_survives_entry_creation() {
        let _guard = KEY_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        use_mock_keychain();
        let _ = entry().expect("creating an entry");
        let store = keyring_core::get_default_store().expect("a default store is set");
        let dbg = format!("{store:?}");
        assert!(
            dbg.contains("Mock store"),
            "the default store after Entry::new must still be the mock, got: {dbg}"
        );
    }

    static KEY_SERIAL: Mutex<()> = Mutex::new(());

    #[test]
    fn a_stored_key_round_trips_and_can_be_removed() {
        let _guard = KEY_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        use_mock_keychain();
        let _ = delete_key();

        assert!(!has_key(), "no key stored yet");
        assert!(load_key().expect("a missing key is Ok(None)").is_none());

        store_key(&Secret::new("gsk-round-trip".to_string())).expect("storing a key");
        assert!(has_key(), "the badge must read 'Key set' after a store");
        let loaded = load_key().expect("reading back").expect("a key was stored");
        assert_eq!(loaded.expose(), "gsk-round-trip");

        store_key(&Secret::new("gsk-second".to_string())).expect("replacing the key");
        assert_eq!(load_key().unwrap().unwrap().expose(), "gsk-second");

        delete_key().expect("the way out must work");
        assert!(!has_key(), "removal must actually clear the badge");
        assert!(load_key().unwrap().is_none());

        delete_key().expect("deleting an absent key is success, not an error");
    }

    #[test]
    fn an_empty_key_is_refused_and_never_written() {
        let _guard = KEY_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        use_mock_keychain();
        let _ = delete_key();

        let err = store_key(&Secret::new(String::new())).expect_err("empty must be refused");
        assert!(matches!(err, CloudError::EmptyKey), "{err}");
        assert!(!has_key(), "a refused store must leave nothing behind");
    }

    #[test]
    fn a_write_the_keychain_did_not_keep_is_a_failure_not_a_success() {
        let key = Secret::new("gsk-vanishing".to_string());

        let err = verify_persisted(None, &key).expect_err("a lost write must not read as success");
        assert!(matches!(err, CloudError::NotPersisted { .. }), "{err}");
        assert!(
            err.to_string().contains("was NOT"),
            "the message must say the key is not saved, not merely hint: {err}"
        );

        let other = Secret::new("gsk-someone-elses".to_string());
        let err = verify_persisted(Some(&other), &key).expect_err("a changed value is not a store");
        assert!(matches!(err, CloudError::NotPersisted { .. }), "{err}");

        for e in [
            verify_persisted(None, &key).unwrap_err(),
            verify_persisted(Some(&other), &key).unwrap_err(),
        ] {
            let msg = e.to_string();
            assert!(
                !msg.contains("gsk-vanishing"),
                "the key leaked into an error: {msg}"
            );
            assert!(
                !msg.contains("gsk-someone-elses"),
                "a stored value leaked: {msg}"
            );
        }

        verify_persisted(Some(&Secret::new("gsk-vanishing".to_string())), &key)
            .expect("a value that read back identical is a stored key");
    }

    #[test]
    fn an_unreadable_keychain_is_not_reported_as_an_absent_key() {
        let unreadable = availability_of(Err(CloudError::Keychain(
            "the name org.freedesktop.secrets was not provided".to_string(),
        )));
        match unreadable {
            KeyAvailability::Unreadable(why) => assert!(
                why.contains("org.freedesktop.secrets"),
                "the refusal must carry the store's own reason, got: {why}"
            ),
            KeyAvailability::Absent => {
                panic!("a keychain fault must never be reported as 'no key stored'")
            }
            KeyAvailability::Present => panic!("an error is not a key"),
        }

        assert!(
            matches!(availability_of(Ok(None)), KeyAvailability::Absent),
            "a reachable keychain with nothing in it IS an absent key"
        );
        assert!(
            matches!(
                availability_of(Ok(Some(Secret::new("gsk-here".to_string())))),
                KeyAvailability::Present
            ),
            "a stored key is present"
        );
    }

    #[test]
    fn key_availability_tracks_the_real_store() {
        let _guard = KEY_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        use_mock_keychain();
        let _ = delete_key();
        assert!(matches!(key_availability(), KeyAvailability::Absent));

        store_key(&Secret::new("gsk-stored".to_string())).expect("store");
        assert!(matches!(key_availability(), KeyAvailability::Present));

        delete_key().expect("cleanup");
        assert!(matches!(key_availability(), KeyAvailability::Absent));
    }

    #[test]
    fn a_reachable_keychain_reports_no_error_to_explain_an_empty_badge() {
        let _guard = KEY_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        use_mock_keychain();
        let _ = delete_key();

        assert!(!has_key(), "nothing stored");
        assert_eq!(
            keyring_error(),
            None,
            "a reachable keychain must not invent a fault — an empty badge is then the truth"
        );
    }

    fn silent_audio(secs: f32) -> AudioBuffer {
        AudioBuffer {
            samples: vec![0.0; (secs * super::super::capture::TARGET_SAMPLE_RATE as f32) as usize],
            sample_rate: super::super::capture::TARGET_SAMPLE_RATE,
        }
    }

    #[derive(Clone, Default)]
    struct FixtureState {
        response: Arc<Mutex<FixtureResponse>>,
        last_request_path: Arc<Mutex<Option<String>>>,
        last_form_fields: Arc<Mutex<Vec<(String, String)>>>,
    }

    #[derive(Clone)]
    enum FixtureResponse {
        Text(String),
        Status(u16),
        RateLimited { retry_after_secs: Option<u64> },
    }

    impl Default for FixtureResponse {
        fn default() -> Self {
            FixtureResponse::Text(r#"{"text": "hello world"}"#.to_string())
        }
    }

    async fn fixture_handler(
        axum::extract::Path(kind): axum::extract::Path<String>,
        State(state): State<FixtureState>,
        mut multipart: Multipart,
    ) -> Response {
        *state.last_request_path.lock().unwrap() = Some(kind);
        let mut fields = Vec::new();
        while let Some(field) = multipart.next_field().await.unwrap() {
            let name = field.name().unwrap_or("").to_string();
            if name == "file" {
                let _ = field.bytes().await.unwrap();
                fields.push((name, "<binary>".to_string()));
            } else {
                let value = field.text().await.unwrap_or_default();
                fields.push((name, value));
            }
        }
        *state.last_form_fields.lock().unwrap() = fields;

        match state.response.lock().unwrap().clone() {
            FixtureResponse::Text(body) => {
                (StatusCode::OK, [("content-type", "application/json")], body).into_response()
            }
            FixtureResponse::Status(code) => StatusCode::from_u16(code).unwrap().into_response(),
            FixtureResponse::RateLimited { retry_after_secs } => {
                let mut resp = StatusCode::TOO_MANY_REQUESTS.into_response();
                if let Some(secs) = retry_after_secs {
                    resp.headers_mut().insert(
                        axum::http::header::RETRY_AFTER,
                        secs.to_string().parse().unwrap(),
                    );
                }
                resp
            }
        }
    }

    async fn start_fixture_server(state: FixtureState) -> String {
        let app = axum::Router::new()
            .route("/audio/{kind}", post(fixture_handler))
            .with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{addr}")
    }

    fn start_fixture_server_blocking(state: FixtureState) -> String {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(async move {
                let base = start_fixture_server(state).await;
                tx.send(base).unwrap();
                std::future::pending::<()>().await;
            });
        });
        rx.recv().unwrap()
    }

    #[test]
    fn transcribe_hits_the_transcriptions_endpoint_when_not_translating() {
        let state = FixtureState::default();
        let base = start_fixture_server_blocking(state.clone());
        let transcriber =
            GroqTranscriber::with_base_url(Secret::new("test-key".into()), base).unwrap();

        let result = transcriber
            .transcribe(
                &silent_audio(1.0),
                &TranscribeRequest {
                    language: Some("pt"),
                    translate: false,
                    prompt: "Houston, Claude, pane",
                },
            )
            .expect("fixture returns a successful transcript");

        assert_eq!(result.text, "hello world");
        assert!(!result.translated);
        assert_eq!(
            state.last_request_path.lock().unwrap().as_deref(),
            Some("transcriptions")
        );
        let fields = state.last_form_fields.lock().unwrap().clone();
        assert!(fields
            .iter()
            .any(|(k, v)| k == "model" && v == "whisper-large-v3"));
        assert!(fields.iter().any(|(k, v)| k == "language" && v == "pt"));
        assert!(fields
            .iter()
            .any(|(k, v)| k == "prompt" && v == "Houston, Claude, pane"));
    }

    #[test]
    fn translate_mode_hits_the_translations_endpoint_and_omits_language() {
        let state = FixtureState::default();
        let base = start_fixture_server_blocking(state.clone());
        let transcriber =
            GroqTranscriber::with_base_url(Secret::new("test-key".into()), base).unwrap();

        let result = transcriber
            .transcribe(
                &silent_audio(1.0),
                &TranscribeRequest {
                    language: Some("pt"),
                    translate: true,
                    prompt: "",
                },
            )
            .unwrap();

        assert!(
            result.translated,
            "translated must reflect what was ASKED, matching the request"
        );
        assert_eq!(
            state.last_request_path.lock().unwrap().as_deref(),
            Some("translations"),
            "output_mode: English must select the /audio/translations endpoint (§2, §6), not a request field"
        );
        let fields = state.last_form_fields.lock().unwrap().clone();
        assert!(
            !fields.iter().any(|(k, _)| k == "language"),
            "the translations endpoint doesn't take a language field and none must be sent"
        );
    }

    #[test]
    fn a_401_is_reported_as_key_rejected_naming_the_status() {
        let state = FixtureState {
            response: Arc::new(Mutex::new(FixtureResponse::Status(401))),
            ..Default::default()
        };
        let base = start_fixture_server_blocking(state);
        let transcriber =
            GroqTranscriber::with_base_url(Secret::new("bad-key".into()), base).unwrap();

        let err = transcriber
            .transcribe(
                &silent_audio(1.0),
                &TranscribeRequest {
                    language: None,
                    translate: false,
                    prompt: "",
                },
            )
            .expect_err("a 401 must not be treated as success");

        match &err {
            CloudError::KeyRejected { status } => assert_eq!(*status, 401),
            other => panic!("expected KeyRejected, got {other:?}"),
        }
        assert!(err.to_string().contains("401"));
    }

    #[test]
    fn a_429_is_reported_as_rate_limited_with_retry_after() {
        let state = FixtureState {
            response: Arc::new(Mutex::new(FixtureResponse::RateLimited {
                retry_after_secs: Some(17),
            })),
            ..Default::default()
        };
        let base = start_fixture_server_blocking(state);
        let transcriber =
            GroqTranscriber::with_base_url(Secret::new("test-key".into()), base).unwrap();

        let err = transcriber
            .transcribe(
                &silent_audio(1.0),
                &TranscribeRequest {
                    language: None,
                    translate: false,
                    prompt: "",
                },
            )
            .expect_err("a 429 must not be treated as success");

        match &err {
            CloudError::RateLimited { retry_after } => {
                assert_eq!(*retry_after, Some(Duration::from_secs(17)));
            }
            other => panic!("expected RateLimited, got {other:?}"),
        }
    }

    #[test]
    fn a_500_is_a_named_server_error_with_a_bounded_body() {
        let state = FixtureState {
            response: Arc::new(Mutex::new(FixtureResponse::Status(500))),
            ..Default::default()
        };
        let base = start_fixture_server_blocking(state);
        let transcriber =
            GroqTranscriber::with_base_url(Secret::new("test-key".into()), base).unwrap();

        let err = transcriber
            .transcribe(
                &silent_audio(1.0),
                &TranscribeRequest {
                    language: None,
                    translate: false,
                    prompt: "",
                },
            )
            .expect_err("a 500 must not be treated as success");

        match &err {
            CloudError::ServerError { status, .. } => assert_eq!(*status, 500),
            other => panic!("expected ServerError, got {other:?}"),
        }
    }

    #[test]
    fn empty_transcript_text_is_reported_as_empty_not_a_blank_success() {
        let state = FixtureState {
            response: Arc::new(Mutex::new(FixtureResponse::Text(
                r#"{"text": "   "}"#.to_string(),
            ))),
            ..Default::default()
        };
        let base = start_fixture_server_blocking(state);
        let transcriber =
            GroqTranscriber::with_base_url(Secret::new("test-key".into()), base).unwrap();

        let err = transcriber
            .transcribe(
                &silent_audio(1.0),
                &TranscribeRequest {
                    language: None,
                    translate: false,
                    prompt: "",
                },
            )
            .expect_err("whitespace-only text must not read as a real transcript");
        assert!(matches!(err, CloudError::Empty));
    }

    #[test]
    fn no_stored_key_refuses_before_any_network_call() {
        let transcriber = GroqTranscriber::with_base_url(
            Secret::new(String::new()),
            "http://127.0.0.1:1".to_string(),
        )
        .unwrap();
        let err = transcriber
            .transcribe(
                &silent_audio(1.0),
                &TranscribeRequest {
                    language: None,
                    translate: false,
                    prompt: "",
                },
            )
            .expect_err("an empty key must refuse locally, never attempt a connection");
        assert!(matches!(err, CloudError::NoApiKey));
    }

    #[test]
    fn encode_wav_round_trips_sample_count_and_rate() {
        let audio = AudioBuffer {
            samples: vec![0.5, -0.5, 0.25, -0.25],
            sample_rate: 16_000,
        };
        let bytes = encode_wav(&audio).unwrap();
        let mut reader = hound::WavReader::new(Cursor::new(bytes)).unwrap();
        assert_eq!(reader.spec().sample_rate, 16_000);
        assert_eq!(reader.spec().channels, 1);
        let samples: Vec<i16> = reader.samples::<i16>().map(|s| s.unwrap()).collect();
        assert_eq!(samples.len(), 4);
    }

    #[test]
    fn key_rejected_and_rate_limited_messages_name_the_specifics() {
        assert!(CloudError::KeyRejected { status: 403 }
            .to_string()
            .contains("403"));
        assert_eq!(
            CloudError::RateLimited {
                retry_after: Some(Duration::from_secs(5))
            }
            .to_string(),
            "Groq rate-limited this request; retry after 5s"
        );
        assert_eq!(
            CloudError::RateLimited { retry_after: None }.to_string(),
            "Groq rate-limited this request; retry later"
        );
    }

    #[test]
    fn a_secret_cannot_be_formatted_into_a_log() {
        let s = Secret::new("hunter2".into());
        assert_eq!(s.expose(), "hunter2");
        assert!(!s.is_empty());
    }

    #[test]
    fn store_key_refuses_an_empty_secret() {
        let err = store_key(&Secret::new(String::new())).unwrap_err();
        assert!(matches!(err, CloudError::EmptyKey));
    }
}
