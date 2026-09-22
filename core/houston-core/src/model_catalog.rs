use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{ensure, Context, Result};
use houston_protocol as proto;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const CATALOG_URL: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const CACHE_FILE: &str = "model-prices.json";
// Usage and provider checks reuse the cache between scheduled revalidations.
const FRESH_MS: i64 = crate::updates::UPDATE_CHECK_INTERVAL.as_millis() as i64;
const RETRY_MS: i64 = 5 * 60 * 1000;
// The full multi-provider document is several MiB; bound both download and cache reads.
const MAX_BYTES: u64 = 20 * 1024 * 1024;
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ModelRate {
    pub input_cost_per_token: f64,
    pub output_cost_per_token: f64,
    pub cache_read_cost_per_token: f64,
    pub cache_creation_cost_per_token: f64,
}

#[derive(Debug, Clone, Copy)]
struct Model {
    rate: Option<ModelRate>,
    window: Option<u64>,
}

#[derive(Debug, Default, Clone)]
pub struct ModelTable {
    models: Arc<HashMap<String, Model>>,
}

impl ModelTable {
    pub fn from_document(document: &Value) -> Self {
        let mut models = HashMap::new();
        if let Some(entries) = document.as_object() {
            for (name, raw) in entries {
                let Some(entry) = raw.as_object() else {
                    continue;
                };
                let cost = |key: &str| {
                    entry
                        .get(key)
                        .and_then(Value::as_f64)
                        .filter(|value| value.is_finite() && *value >= 0.0)
                };
                let rate = cost("input_cost_per_token")
                    .zip(cost("output_cost_per_token"))
                    .map(|(input, output)| ModelRate {
                        input_cost_per_token: input,
                        output_cost_per_token: output,
                        cache_read_cost_per_token: cost("cache_read_input_token_cost")
                            .unwrap_or(input),
                        cache_creation_cost_per_token: cost("cache_creation_input_token_cost")
                            .unwrap_or(input),
                    });
                // max_tokens often means output capacity; adding output would inflate the window.
                let window = entry
                    .get("max_input_tokens")
                    .and_then(Value::as_u64)
                    .filter(|n| *n > 0);
                if rate.is_some() || window.is_some() {
                    models.insert(name.trim().to_ascii_lowercase(), Model { rate, window });
                }
            }
        }
        Self {
            models: Arc::new(models),
        }
    }

    pub fn priced_models(&self) -> usize {
        self.models
            .values()
            .filter(|model| model.rate.is_some())
            .count()
    }

    fn model(&self, requested: &str) -> Option<Model> {
        let name = requested.trim().to_ascii_lowercase();
        let bare = name.rsplit('/').next()?;
        if matches!(
            bare,
            "" | "<synthetic>" | "synthetic" | "opus" | "sonnet" | "haiku" | "fable"
        ) {
            return None;
        }
        let find = |key: &str| self.models.get(key).copied();
        // Keep provider-qualified records distinct; native entries win over aliases.
        let lookup = |key: &str| {
            find(key).or_else(|| match key.split_once('/') {
                Some(("anthropic" | "openai", native)) => find(native),
                Some(_) => None,
                None => {
                    find(&format!("anthropic/{key}")).or_else(|| find(&format!("openai/{key}")))
                }
            })
        };
        lookup(&name).or_else(|| {
            let base = name.strip_suffix("[1m]")?;
            lookup(base).filter(|model| model.window.is_some_and(|window| window >= 1_000_000))
        })
    }

    pub fn rate(&self, model: &str) -> Option<ModelRate> {
        self.model(model)?.rate
    }

    pub fn window(&self, model: &str) -> Option<u64> {
        self.model(model)?.window
    }
}

#[derive(Debug, Clone)]
pub struct CatalogSnapshot {
    pub table: ModelTable,
    pub pricing: proto::UsagePricing,
}

#[derive(Deserialize, Serialize)]
struct CachedCatalog {
    fetched_at_ms: i64,
    source: String,
    document: Value,
    #[serde(default)]
    etag: Option<String>,
}

enum CatalogResponse {
    Modified {
        document: Value,
        etag: Option<String>,
    },
    NotModified {
        etag: Option<String>,
    },
}

impl CachedCatalog {
    fn snapshot(&self) -> Result<CatalogSnapshot> {
        let table = validate(&self.document)?;
        Ok(CatalogSnapshot {
            pricing: proto::UsagePricing {
                status: proto::UsagePricingStatus::Cached,
                source: self.source.clone(),
                fetched_at_ms: Some(self.fetched_at_ms),
                known_models: table.priced_models() as u32,
                message: None,
            },
            table,
        })
    }
}

struct State {
    snapshot: CatalogSnapshot,
    attempted_at_ms: Option<i64>,
    generation: u64,
}

pub struct ModelCatalog {
    state_dir: PathBuf,
    state: Mutex<State>,
    refresh: Mutex<()>,
}

impl ModelCatalog {
    pub fn new(state_dir: &Path) -> Self {
        let snapshot = read_cache(state_dir)
            .map(|(_, snapshot)| snapshot)
            .unwrap_or_else(|| CatalogSnapshot {
                table: validate(
                    &serde_json::from_str(include_str!("model-catalog-fallback.json"))
                        .expect("valid bundled model JSON"),
                )
                .expect("valid bundled models"),
                pricing: proto::UsagePricing {
                    status: proto::UsagePricingStatus::Unavailable,
                    source: CATALOG_URL.into(),
                    fetched_at_ms: None,
                    known_models: 0,
                    message: Some("No cached model prices; context uses bundled limits.".into()),
                },
            });
        Self {
            state_dir: state_dir.to_path_buf(),
            state: Mutex::new(State {
                snapshot,
                attempted_at_ms: None,
                generation: 0,
            }),
            refresh: Mutex::new(()),
        }
    }

    pub fn window(&self, model: &str) -> Option<u64> {
        self.state
            .lock()
            .expect("model catalog lock")
            .snapshot
            .table
            .window(model)
    }

    /// Blocking IO; startup and Usage call this on the blocking pool, never in a hook.
    pub fn load(&self, automatic_updates: bool, force: bool) -> CatalogSnapshot {
        self.load_with(
            automatic_updates,
            force,
            || crate::hook_drop::now_ms() as i64,
            download,
        )
    }

    fn load_with(
        &self,
        automatic_updates: bool,
        force: bool,
        clock: impl FnOnce() -> i64,
        fetch: impl FnOnce(Option<&str>) -> Result<CatalogResponse>,
    ) -> CatalogSnapshot {
        let generation = self.state.lock().expect("model catalog lock").generation;
        let _refresh = self.refresh.lock().expect("catalog refresh lock");
        let now = clock();
        let cached = read_cache(&self.state_dir);
        let mut state = self.state.lock().expect("model catalog lock");
        if state.generation != generation {
            return state.snapshot.clone();
        }
        // Reuse the installed Usage cache, including one written before this daemon started.
        if let Some((_, cached_snapshot)) = &cached {
            if cached_snapshot.pricing.fetched_at_ms > state.snapshot.pricing.fetched_at_ms {
                state.snapshot = cached_snapshot.clone();
            }
        }
        if !force
            && (!automatic_updates
                || recent(state.snapshot.pricing.fetched_at_ms, now, FRESH_MS)
                || recent(state.attempted_at_ms, now, RETRY_MS))
        {
            let mut snapshot = state.snapshot.clone();
            if snapshot.pricing.fetched_at_ms.is_some() {
                snapshot.pricing.status = proto::UsagePricingStatus::Cached;
            }
            return snapshot;
        }
        state.attempted_at_ms = Some(now);
        drop(state);
        let validator = cached.as_ref().and_then(|(cache, _)| {
            (cache.source == CATALOG_URL)
                .then(|| cache.etag.clone())
                .flatten()
        });
        let result = fetch(validator.as_deref()).and_then(|response| {
            let cache = match response {
                CatalogResponse::Modified { document, etag } => CachedCatalog {
                    fetched_at_ms: now,
                    source: CATALOG_URL.into(),
                    document,
                    etag,
                },
                CatalogResponse::NotModified { etag } => {
                    ensure!(
                        validator.is_some(),
                        "catalog returned 304 without a cached validator"
                    );
                    let (mut cache, _) =
                        cached.context("catalog returned 304 without cached data")?;
                    cache.fetched_at_ms = now;
                    if etag.is_some() {
                        cache.etag = etag;
                    }
                    cache
                }
            };
            let mut snapshot = cache.snapshot()?;
            snapshot.pricing.status = proto::UsagePricingStatus::Fresh;
            snapshot.pricing.message = write_cache(&self.state_dir, &cache)
                .err()
                .map(|error| format!("model data fetched but not cached: {error:#}"));
            Ok(snapshot)
        });
        let mut state = self.state.lock().expect("model catalog lock");
        state.generation += 1;
        match result {
            Ok(snapshot) => state.snapshot = snapshot,
            Err(error) => {
                state.snapshot.pricing.status = if state.snapshot.pricing.fetched_at_ms.is_some() {
                    proto::UsagePricingStatus::Cached
                } else {
                    proto::UsagePricingStatus::Unavailable
                };
                state.snapshot.pricing.message =
                    Some(format!("Keeping local model data: {error:#}"));
            }
        }
        state.snapshot.clone()
    }
}

fn recent(timestamp: Option<i64>, now: i64, duration: i64) -> bool {
    timestamp.is_some_and(|timestamp| now >= timestamp && now.saturating_sub(timestamp) < duration)
}

fn validate(document: &Value) -> Result<ModelTable> {
    ensure!(
        document.is_object(),
        "model catalog must be a JSON object keyed by model id"
    );
    let table = ModelTable::from_document(document);
    ensure!(
        !table.models.is_empty(),
        "model catalog has no valid prices or context limits"
    );
    Ok(table)
}

pub fn cache_path(state_dir: &Path) -> PathBuf {
    state_dir.join("usage").join(CACHE_FILE)
}

fn read_cache(state_dir: &Path) -> Option<(CachedCatalog, CatalogSnapshot)> {
    let bytes = read_bounded(std::fs::File::open(cache_path(state_dir)).ok()?).ok()?;
    let cache: CachedCatalog = serde_json::from_slice(&bytes).ok()?;
    let snapshot = cache.snapshot().ok()?;
    Some((cache, snapshot))
}

fn write_cache(state_dir: &Path, cache: &CachedCatalog) -> Result<()> {
    let dir = state_dir.join("usage");
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    let bytes = serde_json::to_vec(cache)?;
    ensure!(
        bytes.len() as u64 <= MAX_BYTES,
        "model catalog cache exceeds {MAX_BYTES} bytes"
    );
    crate::hook_drop::write_atomic(&dir, CACHE_FILE, &bytes)
}

fn read_bounded(reader: impl Read) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= MAX_BYTES,
        "model catalog exceeds {MAX_BYTES} bytes"
    );
    Ok(bytes)
}

fn download(etag: Option<&str>) -> Result<CatalogResponse> {
    download_from(CATALOG_URL, etag)
}

fn download_from(url: &str, etag: Option<&str>) -> Result<CatalogResponse> {
    let client = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()?;
    let mut request = client.get(url);
    if let Some(etag) = etag {
        request = request.header(reqwest::header::IF_NONE_MATCH, etag);
    }
    let response = request.send()?.error_for_status()?;
    let etag = response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    if response.status() == reqwest::StatusCode::NOT_MODIFIED {
        return Ok(CatalogResponse::NotModified { etag });
    }
    ensure!(
        response
            .content_length()
            .is_none_or(|size| size <= MAX_BYTES),
        "model catalog exceeds {MAX_BYTES} bytes"
    );
    let document =
        serde_json::from_slice(&read_bounded(response)?).context("invalid model catalog JSON")?;
    Ok(CatalogResponse::Modified { document, etag })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn document(window: u64, input: f64) -> Value {
        json!({"claude-new-model": {
            "max_input_tokens": window, "max_tokens": 123, "max_output_tokens": 456,
            "input_cost_per_token": input, "output_cost_per_token": 0.000002
        }})
    }

    fn modified(document: Value) -> CatalogResponse {
        CatalogResponse::Modified {
            document,
            etag: None,
        }
    }

    fn serve_catalog(
        responses: Vec<(String, Option<&'static str>)>,
    ) -> (String, std::thread::JoinHandle<()>) {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            for (response, expected_etag) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(10)))
                    .unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut validator = None;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                    if let Some((name, value)) = line.split_once(':') {
                        if name.eq_ignore_ascii_case("if-none-match") {
                            validator = Some(value.trim().to_owned());
                        }
                    }
                }
                assert_eq!(validator.as_deref(), expected_etag);
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        (url, worker)
    }

    fn response(status: &str, etag: Option<&str>, body: &str) -> String {
        let etag = etag
            .map(|tag| format!("ETag: {tag}\r\n"))
            .unwrap_or_default();
        format!(
            "HTTP/1.1 {status}\r\n{etag}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    #[test]
    fn http_revalidation_survives_restart_and_failed_replacements() {
        let first = document(500_000, 0.000001).to_string();
        let second = document(1_000_000, 0.000003).to_string();
        let (url, server) = serve_catalog(vec![
            (response("200 OK", Some("W/\"v1\""), &first), None),
            (response("304 Not Modified", None, ""), Some("W/\"v1\"")),
            (
                response("200 OK", Some("\"invalid\""), "{}"),
                Some("W/\"v1\""),
            ),
            (
                response("503 Service Unavailable", None, "offline"),
                Some("W/\"v1\""),
            ),
            (
                response("200 OK", Some("\"v2\""), &second),
                Some("W/\"v1\""),
            ),
        ]);
        let dir = tempfile::tempdir().unwrap();
        let catalog = ModelCatalog::new(dir.path());
        catalog.load_with(true, true, || 100, |etag| download_from(&url, etag));
        let catalog = ModelCatalog::new(dir.path());
        let unchanged = catalog.load_with(
            true,
            false,
            || FRESH_MS + 100,
            |etag| download_from(&url, etag),
        );
        assert_eq!(unchanged.pricing.fetched_at_ms, Some(FRESH_MS + 100));
        assert_eq!(unchanged.pricing.status, proto::UsagePricingStatus::Fresh);
        assert_eq!(unchanged.table.window("claude-new-model"), Some(500_000));
        let valid_cache = std::fs::read(cache_path(dir.path())).unwrap();
        for now in [FRESH_MS + 200, FRESH_MS + 300] {
            let failed = catalog.load_with(true, true, || now, |etag| download_from(&url, etag));
            assert!(failed.pricing.message.is_some());
            assert_eq!(failed.table.window("claude-new-model"), Some(500_000));
            assert_eq!(std::fs::read(cache_path(dir.path())).unwrap(), valid_cache);
        }
        let changed = catalog.load_with(
            true,
            true,
            || FRESH_MS + 400,
            |etag| download_from(&url, etag),
        );
        assert_eq!(changed.table.window("claude-new-model"), Some(1_000_000));
        assert_eq!(
            changed
                .table
                .rate("claude-new-model")
                .unwrap()
                .input_cost_per_token,
            0.000003
        );
        let saved: Value =
            serde_json::from_slice(&std::fs::read(cache_path(dir.path())).unwrap()).unwrap();
        assert_eq!(saved["etag"], "\"v2\"");
        server.join().unwrap();
    }

    #[test]
    fn unsolicited_304_keeps_offline_fallback_without_marking_it_fresh() {
        let dir = tempfile::tempdir().unwrap();
        let catalog = ModelCatalog::new(dir.path());
        let result = catalog.load_with(
            true,
            false,
            || 100,
            |etag| {
                assert!(etag.is_none());
                Ok(CatalogResponse::NotModified { etag: None })
            },
        );
        assert_eq!(
            result.pricing.status,
            proto::UsagePricingStatus::Unavailable
        );
        assert_eq!(result.pricing.fetched_at_ms, None);
        assert_eq!(result.table.window("claude-sonnet-5"), Some(1_000_000));
        assert!(!cache_path(dir.path()).exists());
    }

    #[test]
    fn legacy_cache_without_etag_gets_an_unconditional_refresh() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("usage")).unwrap();
        std::fs::write(
            cache_path(dir.path()),
            json!({
                "fetched_at_ms": 1, "source": CATALOG_URL, "document": document(500_000, 0.000001)
            })
            .to_string(),
        )
        .unwrap();
        let catalog = ModelCatalog::new(dir.path());
        catalog.load_with(
            true,
            true,
            || 2,
            |etag| {
                assert!(etag.is_none());
                Ok(modified(document(600_000, 0.000002)))
            },
        );
        assert_eq!(catalog.window("claude-new-model"), Some(600_000));
    }

    #[test]
    fn one_refresh_updates_prices_and_context_and_persists_for_offline_restart() {
        let dir = tempfile::tempdir().unwrap();
        let catalog = ModelCatalog::new(dir.path());
        let snapshot = catalog.load_with(
            true,
            false,
            || 100,
            |_| Ok(modified(document(500_000, 0.000001))),
        );
        assert_eq!(snapshot.pricing.status, proto::UsagePricingStatus::Fresh);
        assert_eq!(
            snapshot
                .table
                .rate("claude-new-model")
                .unwrap()
                .input_cost_per_token,
            0.000001
        );
        assert_eq!(catalog.window("claude-new-model"), Some(500_000));
        let restarted = ModelCatalog::new(dir.path());
        let offline = restarted.load_with(false, false, || FRESH_MS + 1000, |_| panic!("offline"));
        assert_eq!(offline.pricing.status, proto::UsagePricingStatus::Cached);
        assert_eq!(offline.table.window("claude-new-model"), Some(500_000));
        assert_eq!(
            offline.table.rate("claude-new-model"),
            snapshot.table.rate("claude-new-model")
        );
        let cache: Value =
            serde_json::from_slice(&std::fs::read(cache_path(dir.path())).unwrap()).unwrap();
        assert_eq!(cache["document"], document(500_000, 0.000001));
    }

    #[test]
    fn six_hour_cache_expires_and_explicit_refresh_bypasses_age_and_disabled_checks() {
        let dir = tempfile::tempdir().unwrap();
        let catalog = ModelCatalog::new(dir.path());
        catalog.load_with(
            true,
            false,
            || 100,
            |_| Ok(modified(document(500_000, 0.000001))),
        );
        catalog.load_with(
            true,
            false,
            || 101,
            |_| panic!("fresh cache must be reused"),
        );
        catalog.load_with(
            false,
            false,
            || FRESH_MS + 200,
            |_| panic!("automatic updates disabled"),
        );
        let refreshed = catalog.load_with(
            false,
            true,
            || 200,
            |_| Ok(modified(document(1_000_000, 0.000003))),
        );
        assert_eq!(
            refreshed
                .table
                .rate("claude-new-model")
                .unwrap()
                .input_cost_per_token,
            0.000003
        );
        assert_eq!(catalog.window("claude-new-model"), Some(1_000_000));
        catalog.load_with(
            true,
            false,
            || 6 * 60 * 60 * 1000 + 201,
            |_| Ok(modified(document(800_000, 0.000004))),
        );
        assert_eq!(catalog.window("claude-new-model"), Some(800_000));
    }

    #[test]
    fn bad_refreshes_preserve_last_good_data_and_back_off() {
        let dir = tempfile::tempdir().unwrap();
        let catalog = ModelCatalog::new(dir.path());
        catalog.load_with(
            true,
            false,
            || 100,
            |_| Ok(modified(document(500_000, 0.000001))),
        );
        let original = std::fs::read(cache_path(dir.path())).unwrap();
        let failed =
            catalog.load_with(true, false, || FRESH_MS + 100, |_| anyhow::bail!("offline"));
        assert_eq!(failed.pricing.status, proto::UsagePricingStatus::Cached);
        assert!(failed.pricing.message.unwrap().contains("offline"));
        catalog.load_with(true, false, || FRESH_MS + 101, |_| panic!("retry backoff"));
        for bad in [
            json!([]),
            json!({}),
            json!({"bad": {"max_input_tokens": -1}}),
        ] {
            catalog.load_with(true, true, || FRESH_MS + 200, |_| Ok(modified(bad)));
            assert_eq!(catalog.window("claude-new-model"), Some(500_000));
            assert_eq!(std::fs::read(cache_path(dir.path())).unwrap(), original);
        }
        catalog.load_with(
            true,
            false,
            || FRESH_MS + RETRY_MS + 201,
            |_| Ok(modified(document(600_000, 0.000002))),
        );
        assert_eq!(catalog.window("claude-new-model"), Some(600_000));
    }

    #[test]
    fn context_does_not_require_prices_and_uses_input_capacity_only() {
        let table = ModelTable::from_document(&json!({
            "context-only": {"max_input_tokens": 200_000},
            "prices-only": {"input_cost_per_token": 1.0, "output_cost_per_token": 2.0, "max_tokens": 128_000},
            "both": {"max_input_tokens": 1_000_000, "max_output_tokens": 128_000, "max_tokens": 128_000},
            "invalid": {"input_cost_per_token": -1.0, "output_cost_per_token": 2.0, "max_input_tokens": 0}
        }));
        assert_eq!(table.window("context-only"), Some(200_000));
        assert!(table.rate("context-only").is_none());
        assert!(table.window("prices-only").is_none());
        assert_eq!(table.window("both[1m]"), Some(1_000_000));
        assert!(table.window("context-only[1m]").is_none());
        assert!(table.window("both[unknown]").is_none());
        assert!(table.rate("invalid").is_none());
        assert!(table.window("invalid").is_none());
    }

    #[test]
    fn provider_records_do_not_overwrite_native_models() {
        let table = ModelTable::from_document(&json!({
            "claude-sonnet-test": {"max_input_tokens": 1_000_000, "input_cost_per_token": 1.0, "output_cost_per_token": 2.0},
            "vertex_ai/claude-sonnet-test": {"max_input_tokens": 200_000, "input_cost_per_token": 3.0, "output_cost_per_token": 4.0},
            "anthropic/claude-other": {"max_input_tokens": 300_000},
            "sonnet": {"max_input_tokens": 200_000}
        }));
        assert_eq!(table.window(" CLAUDE-SONNET-TEST "), Some(1_000_000));
        assert_eq!(table.window("vertex_ai/claude-sonnet-test"), Some(200_000));
        assert_eq!(
            table
                .rate("claude-sonnet-test")
                .unwrap()
                .input_cost_per_token,
            1.0
        );
        assert_eq!(
            table
                .rate("vertex_ai/claude-sonnet-test")
                .unwrap()
                .input_cost_per_token,
            3.0
        );
        assert_eq!(table.window("claude-other"), Some(300_000));
        assert_eq!(
            table.window("anthropic/claude-sonnet-test"),
            Some(1_000_000)
        );
        assert!(table.window("bedrock/claude-sonnet-test").is_none());
        assert!(table.rate("unknown/claude-sonnet-test").is_none());
        assert!(table.window("sonnet").is_none());
    }

    #[test]
    fn bundled_context_stays_available_without_inventing_prices() {
        let dir = tempfile::tempdir().unwrap();
        let catalog = ModelCatalog::new(dir.path());
        let snapshot = catalog.load_with(false, false, || 100, |_| panic!("no request"));
        assert_eq!(
            snapshot.pricing.status,
            proto::UsagePricingStatus::Unavailable
        );
        assert_eq!(snapshot.pricing.known_models, 0);
        assert_eq!(catalog.window("claude-sonnet-5"), Some(1_000_000));
        assert!(snapshot.table.rate("claude-sonnet-5").is_none());
    }

    #[test]
    fn clock_rollback_does_not_leave_catalog_fresh_forever() {
        let dir = tempfile::tempdir().unwrap();
        let catalog = ModelCatalog::new(dir.path());
        catalog.load_with(
            true,
            false,
            || 1000,
            |_| Ok(modified(document(500_000, 1.0))),
        );
        catalog.load_with(true, false, || 10, |_| Ok(modified(document(600_000, 2.0))));
        assert_eq!(catalog.window("claude-new-model"), Some(600_000));
    }

    #[test]
    fn simultaneous_consumers_share_one_download_and_hooks_keep_the_old_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let catalog = Arc::new(ModelCatalog::new(dir.path()));
        let calls = AtomicUsize::new(0);
        let started = std::sync::Barrier::new(2);
        let release = std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            let first = scope.spawn(|| {
                catalog.load_with(
                    true,
                    false,
                    || 100,
                    |_| {
                        calls.fetch_add(1, Ordering::SeqCst);
                        started.wait();
                        release.wait();
                        Ok(modified(document(500_000, 1.0)))
                    },
                )
            });
            started.wait();
            assert_eq!(catalog.window("claude-sonnet-5"), Some(1_000_000));
            let second = scope.spawn(|| {
                catalog.load_with(
                    true,
                    false,
                    || 101,
                    |_| {
                        calls.fetch_add(1, Ordering::SeqCst);
                        Ok(modified(document(600_000, 2.0)))
                    },
                )
            });
            release.wait();
            assert_eq!(
                first.join().unwrap().table.window("claude-new-model"),
                Some(500_000)
            );
            assert_eq!(
                second.join().unwrap().table.window("claude-new-model"),
                Some(500_000)
            );
        });
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn oversized_and_corrupt_cache_files_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("usage")).unwrap();
        std::fs::write(cache_path(dir.path()), b"invalid JSON").unwrap();
        assert_eq!(
            ModelCatalog::new(dir.path()).window("claude-sonnet-5"),
            Some(1_000_000)
        );
        assert!(read_bounded(std::io::repeat(b' ').take(MAX_BYTES + 1)).is_err());
    }
}
