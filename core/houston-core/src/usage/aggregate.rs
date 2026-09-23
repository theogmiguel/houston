use std::collections::{HashMap, HashSet};

use houston_protocol as proto;

use super::pricing::{cache_savings_usd, price_usage};
use super::time::floor_hour_ms;
use super::transcripts::UsageRecord;
use crate::model_catalog::ModelTable;

#[derive(Debug, PartialEq, Eq, Hash, Clone)]
struct BucketKey {
    hour_start_ms: i64,
    provider: proto::UsageProvider,
    model: String,
}

#[derive(Debug, Default)]
struct MutableBucket {
    totals: proto::UsageTokenTotals,
    cost_usd: f64,
    cache_savings_usd: f64,
    records: u32,
    unpriced_records: u32,
    provider_reported_records: u32,
    sessions: HashSet<String>,
}

/// De-duplication is GLOBAL across the scan, never per file: resuming or forking
/// a session copies the parent's records verbatim, so one `dedupe_key`
/// legitimately appears in several files and a per-file pass would miss them.
pub struct Aggregator {
    buckets: HashMap<BucketKey, MutableBucket>,
    seen: HashSet<u64>,
    since_ms: i64,
    until_ms: i64,
    rates: ModelTable,
    duplicates_dropped: u64,
    out_of_window: u64,
}

#[derive(Debug)]
pub struct AggregateResult {
    pub buckets: Vec<proto::UsageBucket>,
    pub duplicates_dropped: u64,
    pub out_of_window: u64,
}

impl Aggregator {
    pub fn new(since_ms: i64, until_ms: i64, rates: ModelTable) -> Self {
        Self {
            buckets: HashMap::new(),
            seen: HashSet::new(),
            since_ms,
            until_ms,
            rates,
            duplicates_dropped: 0,
            out_of_window: 0,
        }
    }

    pub fn add(&mut self, record: &UsageRecord) -> bool {
        if let Some(key) = record.dedupe_key {
            if !self.seen.insert(key) {
                self.duplicates_dropped += 1;
                return false;
            }
        }

        // Half-open, matching the request: an instant exactly at `until_ms`
        // belongs to the next window, so adjacency never double-counts a turn.
        if record.timestamp_ms < self.since_ms || record.timestamp_ms >= self.until_ms {
            self.out_of_window += 1;
            return false;
        }

        let key = BucketKey {
            hour_start_ms: floor_hour_ms(record.timestamp_ms),
            provider: record.provider,
            model: record.model.clone(),
        };
        let priced = price_usage(
            &self.rates,
            &record.model,
            &record.totals,
            record.reported_cost_usd,
        );
        let savings = cache_savings_usd(&self.rates, &record.model, &record.totals);

        let bucket = self.buckets.entry(key).or_default();
        bucket.totals.add(&record.totals);
        bucket.cost_usd += priced.cost_usd;
        bucket.cache_savings_usd += savings;
        bucket.records += 1;
        match priced.cost_source {
            proto::UsageCostSource::Unpriced => bucket.unpriced_records += 1,
            proto::UsageCostSource::ProviderReported => bucket.provider_reported_records += 1,
            proto::UsageCostSource::ModelPriced => {}
        }
        if !record.session_id.is_empty() {
            bucket.sessions.insert(record.session_id.clone());
        }
        true
    }

    pub fn finish(self) -> AggregateResult {
        let mut buckets: Vec<proto::UsageBucket> = self
            .buckets
            .into_iter()
            .map(|(key, bucket)| proto::UsageBucket {
                hour_start_ms: key.hour_start_ms,
                provider: key.provider,
                model: key.model,
                totals: bucket.totals,
                cost_usd: bucket.cost_usd,
                cache_savings_usd: bucket.cache_savings_usd,
                cost_source: resolve_cost_source(&bucket),
                records: bucket.records,
                unpriced_records: bucket.unpriced_records,
                sessions: bucket.sessions.len() as u32,
            })
            .collect();
        buckets.sort_by(|a, b| {
            a.hour_start_ms
                .cmp(&b.hour_start_ms)
                .then_with(|| provider_slug(a.provider).cmp(provider_slug(b.provider)))
                .then_with(|| a.model.cmp(&b.model))
        });
        AggregateResult {
            buckets,
            duplicates_dropped: self.duplicates_dropped,
            out_of_window: self.out_of_window,
        }
    }
}

fn provider_slug(provider: proto::UsageProvider) -> &'static str {
    match provider {
        proto::UsageProvider::Claude => "claude",
        proto::UsageProvider::Codex => "codex",
    }
}

/// The WEAKEST provenance in a bucket wins when its records differ, so the
/// section never overstates how good its number is.
fn resolve_cost_source(bucket: &MutableBucket) -> proto::UsageCostSource {
    if bucket.unpriced_records == bucket.records {
        proto::UsageCostSource::Unpriced
    } else if bucket.provider_reported_records == bucket.records {
        proto::UsageCostSource::ProviderReported
    } else {
        proto::UsageCostSource::ModelPriced
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const HOUR: i64 = 3_600_000;

    fn rates() -> ModelTable {
        ModelTable::from_document(&json!({
            "claude-opus-5": {
                "input_cost_per_token": 0.00001,
                "output_cost_per_token": 0.0001,
                "cache_read_input_token_cost": 0.000001,
                "cache_creation_input_token_cost": 0.0000125
            }
        }))
    }

    fn record(ts: i64, dedupe: Option<u64>, session: &str, output: u64) -> UsageRecord {
        UsageRecord {
            provider: proto::UsageProvider::Claude,
            timestamp_ms: ts,
            model: "claude-opus-5".into(),
            session_id: session.into(),
            totals: proto::UsageTokenTotals {
                uncached_input_tokens: 100,
                cached_input_tokens: 1_000,
                cache_creation_tokens: 0,
                output_tokens: output,
                reasoning_tokens: 0,
            },
            reported_cost_usd: None,
            dedupe_key: dedupe,
        }
    }

    #[test]
    fn repeated_dedupe_keys_are_counted_once_across_files() {
        let mut agg = Aggregator::new(0, 10 * HOUR, rates());
        assert!(agg.add(&record(HOUR, Some(1), "s1", 50)));
        assert!(!agg.add(&record(HOUR, Some(1), "s1", 50)));
        assert!(!agg.add(&record(HOUR, Some(1), "s2", 50)));
        let out = agg.finish();
        assert_eq!(out.duplicates_dropped, 2);
        assert_eq!(out.buckets.len(), 1);
        assert_eq!(out.buckets[0].records, 1);
        assert_eq!(out.buckets[0].totals.output_tokens, 50);
    }

    #[test]
    fn records_with_no_dedupe_key_are_all_kept() {
        let mut agg = Aggregator::new(0, 10 * HOUR, rates());
        assert!(agg.add(&record(HOUR, None, "s1", 50)));
        assert!(agg.add(&record(HOUR, None, "s1", 50)));
        let out = agg.finish();
        assert_eq!(out.duplicates_dropped, 0);
        assert_eq!(out.buckets[0].records, 2);
    }

    #[test]
    fn the_window_is_half_open_so_adjacent_windows_never_share_a_turn() {
        let mut agg = Aggregator::new(HOUR, 2 * HOUR, rates());
        assert!(!agg.add(&record(HOUR - 1, Some(2), "s", 1)));
        assert!(agg.add(&record(HOUR, Some(3), "s", 1)));
        assert!(agg.add(&record(2 * HOUR - 1, Some(4), "s", 1)));
        assert!(!agg.add(&record(2 * HOUR, Some(5), "s", 1)));
        let out = agg.finish();
        assert_eq!(out.out_of_window, 2);
        assert_eq!(out.buckets.len(), 1);
        assert_eq!(out.buckets[0].records, 2);
    }

    #[test]
    fn a_dropped_duplicate_is_not_also_counted_out_of_window() {
        let mut agg = Aggregator::new(0, HOUR, rates());
        agg.add(&record(10, Some(6), "s", 1));
        agg.add(&record(5 * HOUR, Some(6), "s", 1));
        let out = agg.finish();
        assert_eq!(out.duplicates_dropped, 1);
        assert_eq!(out.out_of_window, 0);
    }

    #[test]
    fn buckets_split_on_the_hour_and_on_the_model() {
        let mut agg = Aggregator::new(0, 10 * HOUR, rates());
        agg.add(&record(HOUR, Some(2), "s", 1));
        agg.add(&record(HOUR + HOUR - 1, Some(3), "s", 1));
        agg.add(&record(2 * HOUR, Some(4), "s", 1));
        let mut other = record(HOUR, Some(5), "s", 1);
        other.model = "claude-sonnet-5".into();
        agg.add(&other);
        let out = agg.finish();
        assert_eq!(out.buckets.len(), 3);
        assert_eq!(out.buckets[0].hour_start_ms, HOUR);
        assert_eq!(out.buckets[0].model, "claude-opus-5");
        assert_eq!(out.buckets[0].records, 2);
        assert_eq!(out.buckets[1].model, "claude-sonnet-5");
        assert_eq!(out.buckets[2].hour_start_ms, 2 * HOUR);
    }

    #[test]
    fn sessions_are_counted_distinctly_per_bucket() {
        let mut agg = Aggregator::new(0, 10 * HOUR, rates());
        agg.add(&record(HOUR, Some(2), "s1", 1));
        agg.add(&record(HOUR, Some(3), "s1", 1));
        agg.add(&record(HOUR, Some(4), "s2", 1));
        agg.add(&record(HOUR, Some(5), "", 1));
        let out = agg.finish();
        assert_eq!(
            out.buckets[0].sessions, 2,
            "an empty session id is not a session"
        );
    }

    #[test]
    fn the_weakest_provenance_in_a_bucket_wins() {
        let mut agg = Aggregator::new(0, 10 * HOUR, rates());
        let mut priced = record(HOUR, Some(2), "s", 1);
        priced.reported_cost_usd = Some(1.0);
        agg.add(&priced);
        agg.add(&record(HOUR, Some(3), "s", 1));
        let out = agg.finish();
        assert_eq!(
            out.buckets[0].cost_source,
            proto::UsageCostSource::ModelPriced
        );

        let mut all_reported = Aggregator::new(0, 10 * HOUR, rates());
        all_reported.add(&priced);
        assert_eq!(
            all_reported.finish().buckets[0].cost_source,
            proto::UsageCostSource::ProviderReported
        );

        let mut unknown = record(HOUR, Some(4), "s", 1);
        unknown.model = "shipped-yesterday".into();
        let mut all_unpriced = Aggregator::new(0, 10 * HOUR, rates());
        all_unpriced.add(&unknown);
        let out = all_unpriced.finish();
        assert_eq!(out.buckets[0].cost_source, proto::UsageCostSource::Unpriced);
        assert_eq!(out.buckets[0].unpriced_records, 1);
        assert_eq!(
            out.buckets[0].totals.output_tokens, 1,
            "an unpriced record still contributes its tokens"
        );
    }

    #[test]
    fn cost_and_savings_accumulate_per_bucket() {
        let mut agg = Aggregator::new(0, 10 * HOUR, rates());
        agg.add(&record(HOUR, Some(2), "s", 100));
        agg.add(&record(HOUR, Some(3), "s", 100));
        let out = agg.finish();
        let per_record = 100.0 * 0.00001 + 1_000.0 * 0.000001 + 100.0 * 0.0001;
        assert!((out.buckets[0].cost_usd - 2.0 * per_record).abs() < 1e-12);
        let per_saving = 1_000.0 * (0.00001 - 0.000001);
        assert!((out.buckets[0].cache_savings_usd - 2.0 * per_saving).abs() < 1e-12);
    }
}
