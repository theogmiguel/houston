use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use houston_protocol as proto;
use serde_json::Value;

use super::time::now_ms;

/// Rates are fetched and cached on disk rather than hard-coded: prices move
/// when models ship, and a table compiled into the binary would go stale
/// between releases. Named once so shown provenance cannot drift from the fetch.
pub const RATE_TABLE_URL: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/// A day-old table is exact for every model that existed yesterday, so the only
/// thing a tighter interval buys is a network call per page open; the explicit
/// "refresh rates" action covers the day a price actually moves.
pub const RATE_TABLE_TTL_MS: i64 = 24 * 60 * 60 * 1_000;

const FETCH_TIMEOUT_SECS: u64 = 10;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ModelRate {
    pub input_cost_per_token: f64,
    pub output_cost_per_token: f64,
    pub cache_read_cost_per_token: f64,
    pub cache_creation_cost_per_token: f64,
}

#[derive(Debug, Default, Clone)]
pub struct RateTable {
    rates: HashMap<String, ModelRate>,
}

impl RateTable {
    pub fn len(&self) -> usize {
        self.rates.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rates.is_empty()
    }

    pub fn from_document(document: &Value) -> Self {
        let mut rates = HashMap::new();
        let Some(entries) = document.as_object() else {
            return Self { rates };
        };
        for (name, raw) in entries {
            let Some(entry) = raw.as_object() else {
                continue;
            };
            let finite = |key: &str| {
                entry
                    .get(key)
                    .and_then(Value::as_f64)
                    .filter(|v| v.is_finite())
            };
            // Entries missing either an input or an output rate are dropped
            // whole: a half-priced model would silently under-report cost, worse
            // than reporting it as unpriced and saying so.
            let (Some(input), Some(output)) = (
                finite("input_cost_per_token"),
                finite("output_cost_per_token"),
            ) else {
                continue;
            };
            rates.insert(
                normalize_model_name(name),
                ModelRate {
                    input_cost_per_token: input,
                    output_cost_per_token: output,
                    cache_read_cost_per_token: finite("cache_read_input_token_cost")
                        .unwrap_or(input),
                    cache_creation_cost_per_token: finite("cache_creation_input_token_cost")
                        .unwrap_or(input),
                },
            );
        }
        Self { rates }
    }

    pub fn lookup(&self, model: &str) -> Option<ModelRate> {
        let normalized = normalize_model_name(model);
        if normalized.is_empty() || is_unpriceable(&normalized) {
            return None;
        }
        self.rates.get(&normalized).copied()
    }
}

pub fn normalize_model_name(model: &str) -> String {
    let trimmed = model.trim().to_ascii_lowercase();
    match trimmed.rfind('/') {
        Some(slash) => trimmed[slash + 1..].to_string(),
        None => trimmed,
    }
}

fn is_unpriceable(normalized: &str) -> bool {
    matches!(
        normalized,
        "<synthetic>" | "synthetic" | "opus" | "sonnet" | "haiku" | "fable"
    )
}

#[derive(Debug, Clone, Copy)]
pub struct PricedUsage {
    pub cost_usd: f64,
    pub cost_source: proto::UsageCostSource,
}

/// `reasoning_tokens` is deliberately not charged: it is already inside
/// `output_tokens`, so charging it again would overstate the cost.
pub fn price_usage(
    table: &RateTable,
    model: &str,
    totals: &proto::UsageTokenTotals,
    reported_cost_usd: Option<f64>,
) -> PricedUsage {
    if let Some(cost) = reported_cost_usd.filter(|c| c.is_finite()) {
        return PricedUsage {
            cost_usd: cost,
            cost_source: proto::UsageCostSource::ProviderReported,
        };
    }
    let Some(rate) = table.lookup(model) else {
        return PricedUsage {
            cost_usd: 0.0,
            cost_source: proto::UsageCostSource::Unpriced,
        };
    };
    PricedUsage {
        cost_usd: totals.uncached_input_tokens as f64 * rate.input_cost_per_token
            + totals.cached_input_tokens as f64 * rate.cache_read_cost_per_token
            + totals.cache_creation_tokens as f64 * rate.cache_creation_cost_per_token
            + totals.output_tokens as f64 * rate.output_cost_per_token,
        cost_source: proto::UsageCostSource::ModelPriced,
    }
}

pub fn cache_savings_usd(table: &RateTable, model: &str, totals: &proto::UsageTokenTotals) -> f64 {
    let Some(rate) = table.lookup(model) else {
        return 0.0;
    };
    totals.cached_input_tokens as f64 * (rate.input_cost_per_token - rate.cache_read_cost_per_token)
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct CachedTable {
    fetched_at_ms: i64,
    source: String,
    document: Value,
}

pub fn rate_table_path(state_dir: &Path) -> PathBuf {
    state_dir.join("usage").join("model-prices.json")
}

fn read_cached(path: &Path) -> Option<CachedTable> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_cached(path: &Path, cached: &CachedTable) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating usage cache directory {}", parent.display()))?;
    }
    let body = serde_json::to_vec(cached).context("serialising the rate table cache")?;
    let (dir, name) = match (path.parent(), path.file_name().and_then(|n| n.to_str())) {
        (Some(dir), Some(name)) => (dir, name),
        _ => anyhow::bail!("rate table cache path has no file name: {}", path.display()),
    };
    crate::hook_drop::write_atomic(dir, name, &body)
        .with_context(|| format!("writing the rate table cache at {}", path.display()))
}

fn fetch_document() -> Result<Value> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(FETCH_TIMEOUT_SECS))
        .build()
        .context("building the rate table HTTP client")?;
    let response = client
        .get(RATE_TABLE_URL)
        .send()
        .with_context(|| format!("fetching the model rate table from {RATE_TABLE_URL}"))?;
    let status = response.status();
    if !status.is_success() {
        anyhow::bail!("model rate table at {RATE_TABLE_URL} returned HTTP {status}");
    }
    response.json().context("parsing the model rate table")
}

pub fn load_rate_table(state_dir: &Path, force_refresh: bool) -> (RateTable, proto::UsagePricing) {
    let path = rate_table_path(state_dir);
    let cached = read_cached(&path);
    let now = now_ms();

    if !force_refresh {
        if let Some(hit) = cached
            .as_ref()
            .filter(|c| now.saturating_sub(c.fetched_at_ms) < RATE_TABLE_TTL_MS)
        {
            let table = RateTable::from_document(&hit.document);
            let pricing = proto::UsagePricing {
                status: proto::UsagePricingStatus::Cached,
                source: hit.source.clone(),
                fetched_at_ms: Some(hit.fetched_at_ms),
                known_models: table.len() as u32,
                message: None,
            };
            return (table, pricing);
        }
    }

    match fetch_document() {
        Ok(document) => {
            let table = RateTable::from_document(&document);
            let entry = CachedTable {
                fetched_at_ms: now,
                source: RATE_TABLE_URL.to_string(),
                document,
            };
            let write_note = write_cached(&path, &entry)
                .err()
                .map(|e| format!("rates fetched but not cached: {e:#}"));
            (
                table.clone(),
                proto::UsagePricing {
                    status: proto::UsagePricingStatus::Fresh,
                    source: RATE_TABLE_URL.to_string(),
                    fetched_at_ms: Some(now),
                    known_models: table.len() as u32,
                    message: write_note,
                },
            )
        }
        Err(e) => match cached {
            Some(hit) => {
                let table = RateTable::from_document(&hit.document);
                let known_models = table.len() as u32;
                (
                    table,
                    proto::UsagePricing {
                        status: proto::UsagePricingStatus::Cached,
                        source: hit.source,
                        fetched_at_ms: Some(hit.fetched_at_ms),
                        known_models,
                        message: Some(format!("serving the stored rate table: {e:#}")),
                    },
                )
            }
            None => (
                RateTable::default(),
                proto::UsagePricing {
                    status: proto::UsagePricingStatus::Unavailable,
                    source: RATE_TABLE_URL.to_string(),
                    fetched_at_ms: None,
                    known_models: 0,
                    message: Some(format!(
                        "no rate table available, so every model is reported unpriced: {e:#}"
                    )),
                },
            ),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn table() -> RateTable {
        RateTable::from_document(&json!({
            "claude-opus-5": {
                "input_cost_per_token": 0.000015,
                "output_cost_per_token": 0.000075,
                "cache_read_input_token_cost": 0.0000015,
                "cache_creation_input_token_cost": 0.00001875
            },
            "anthropic/claude-sonnet-5": {
                "input_cost_per_token": 0.000003,
                "output_cost_per_token": 0.000015
            },
            "embed-only": { "input_cost_per_token": 0.0000001 }
        }))
    }

    #[test]
    fn half_priced_entries_are_dropped_rather_than_half_counted() {
        let t = table();
        assert_eq!(
            t.len(),
            2,
            "embed-only has no output rate and must not load"
        );
        assert!(t.lookup("embed-only").is_none());
    }

    #[test]
    fn provider_prefixes_and_casing_normalise_to_one_key() {
        let t = table();
        assert!(t.lookup("claude-sonnet-5").is_some());
        assert!(t.lookup("anthropic/claude-sonnet-5").is_some());
        assert!(t.lookup("Claude-Sonnet-5").is_some());
    }

    #[test]
    fn cached_input_falls_back_to_the_input_rate_not_to_free() {
        let rate = table().lookup("claude-sonnet-5").expect("rate present");
        assert_eq!(rate.cache_read_cost_per_token, rate.input_cost_per_token);
        assert_eq!(
            rate.cache_creation_cost_per_token,
            rate.input_cost_per_token
        );
    }

    #[test]
    fn ambiguous_family_names_are_unpriced_rather_than_guessed() {
        let t = RateTable::from_document(&json!({
            "opus": { "input_cost_per_token": 1.0, "output_cost_per_token": 1.0 }
        }));
        assert!(
            t.lookup("opus").is_none(),
            "a bare family name spans generations and must not be priced"
        );
        assert!(t.lookup("<synthetic>").is_none());
    }

    #[test]
    fn prices_each_token_class_at_its_own_rate() {
        let totals = proto::UsageTokenTotals {
            uncached_input_tokens: 1_000,
            cached_input_tokens: 10_000,
            cache_creation_tokens: 2_000,
            output_tokens: 500,
            reasoning_tokens: 100,
        };
        let priced = price_usage(&table(), "claude-opus-5", &totals, None);
        assert_eq!(priced.cost_source, proto::UsageCostSource::ModelPriced);
        let expected =
            1_000.0 * 0.000015 + 10_000.0 * 0.0000015 + 2_000.0 * 0.00001875 + 500.0 * 0.000075;
        assert!((priced.cost_usd - expected).abs() < 1e-12);
    }

    #[test]
    fn a_reported_cost_always_wins_over_the_table() {
        let priced = price_usage(
            &table(),
            "claude-opus-5",
            &proto::UsageTokenTotals::default(),
            Some(0.42),
        );
        assert_eq!(priced.cost_usd, 0.42);
        assert_eq!(priced.cost_source, proto::UsageCostSource::ProviderReported);
    }

    #[test]
    fn an_unknown_model_is_unpriced_not_free() {
        let priced = price_usage(
            &table(),
            "some-model-that-shipped-yesterday",
            &proto::UsageTokenTotals {
                output_tokens: 1_000_000,
                ..Default::default()
            },
            None,
        );
        assert_eq!(priced.cost_source, proto::UsageCostSource::Unpriced);
        assert_eq!(priced.cost_usd, 0.0);
    }

    #[test]
    fn cache_savings_is_the_discount_not_the_spend() {
        let totals = proto::UsageTokenTotals {
            cached_input_tokens: 10_000,
            ..Default::default()
        };
        let saved = cache_savings_usd(&table(), "claude-opus-5", &totals);
        assert!((saved - 10_000.0 * (0.000015 - 0.0000015)).abs() < 1e-12);
        assert_eq!(cache_savings_usd(&table(), "unknown", &totals), 0.0);
    }

    #[test]
    fn a_missing_table_yields_unavailable_and_prices_nothing() {
        let empty = RateTable::default();
        assert!(empty.is_empty());
        let priced = price_usage(
            &empty,
            "claude-opus-5",
            &proto::UsageTokenTotals::default(),
            None,
        );
        assert_eq!(priced.cost_source, proto::UsageCostSource::Unpriced);
    }
}
