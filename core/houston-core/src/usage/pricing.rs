use houston_protocol as proto;

use crate::model_catalog::ModelTable;

#[derive(Debug, Clone, Copy)]
pub struct PricedUsage {
    pub cost_usd: f64,
    pub cost_source: proto::UsageCostSource,
}

/// `reasoning_tokens` is deliberately not charged: it is already inside
/// `output_tokens`, so charging it again would overstate the cost.
pub fn price_usage(
    table: &ModelTable,
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
    let Some(rate) = table.rate(model) else {
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

pub fn cache_savings_usd(table: &ModelTable, model: &str, totals: &proto::UsageTokenTotals) -> f64 {
    let Some(rate) = table.rate(model) else {
        return 0.0;
    };
    totals.cached_input_tokens as f64 * (rate.input_cost_per_token - rate.cache_read_cost_per_token)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn table() -> ModelTable {
        ModelTable::from_document(&json!({
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
            t.priced_models(),
            2,
            "embed-only has no output rate and must not load"
        );
        assert!(t.rate("embed-only").is_none());
    }

    #[test]
    fn provider_prefixes_and_casing_normalise_to_one_key() {
        let t = table();
        assert!(t.rate("claude-sonnet-5").is_some());
        assert!(t.rate("anthropic/claude-sonnet-5").is_some());
        assert!(t.rate("Claude-Sonnet-5").is_some());
    }

    #[test]
    fn cached_input_falls_back_to_the_input_rate_not_to_free() {
        let rate = table().rate("claude-sonnet-5").expect("rate present");
        assert_eq!(rate.cache_read_cost_per_token, rate.input_cost_per_token);
        assert_eq!(
            rate.cache_creation_cost_per_token,
            rate.input_cost_per_token
        );
    }

    #[test]
    fn ambiguous_family_names_are_unpriced_rather_than_guessed() {
        let t = ModelTable::from_document(&json!({
            "opus": { "input_cost_per_token": 1.0, "output_cost_per_token": 1.0 }
        }));
        assert!(
            t.rate("opus").is_none(),
            "a bare family name spans generations and must not be priced"
        );
        assert!(t.rate("<synthetic>").is_none());
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
        let empty = ModelTable::default();
        assert!(empty.priced_models() == 0);
        let priced = price_usage(
            &empty,
            "claude-opus-5",
            &proto::UsageTokenTotals::default(),
            None,
        );
        assert_eq!(priced.cost_source, proto::UsageCostSource::Unpriced);
    }
}
