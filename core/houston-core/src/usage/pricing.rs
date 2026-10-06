use houston_protocol as proto;

use crate::model_catalog::{ModelRate, ModelTable, SpeedRate};

#[derive(Debug, Clone, Copy)]
pub struct PricedUsage {
    pub cost_usd: f64,
    pub cost_source: proto::UsageCostSource,
    pub category_cost_usd: proto::UsageCategoryCost,
    pub fast_cost_usd: f64,
    pub ultrafast_cost_usd: f64,
    pub speed_premium_usd: f64,
    pub speed_rate_available: bool,
}

/// `reasoning_tokens` is deliberately not charged: it is already inside
/// `output_tokens`, so charging it again would overstate the cost.
pub fn price_usage(
    table: &ModelTable,
    model: &str,
    totals: &proto::UsageTokenTotals,
    reported_cost_usd: Option<f64>,
    speed: super::transcripts::UsageSpeed,
) -> PricedUsage {
    let Some(rate) = table.rate(model) else {
        let reported = reported_cost_usd.filter(|c| c.is_finite());
        return PricedUsage {
            cost_usd: reported.unwrap_or(0.0),
            cost_source: if reported.is_some() {
                proto::UsageCostSource::ProviderReported
            } else {
                proto::UsageCostSource::Unpriced
            },
            category_cost_usd: proto::UsageCategoryCost {
                other_usd: reported.unwrap_or(0.0),
                ..proto::UsageCategoryCost::default()
            },
            fast_cost_usd: if speed == super::transcripts::UsageSpeed::Fast {
                reported.unwrap_or(0.0)
            } else {
                0.0
            },
            ultrafast_cost_usd: if speed == super::transcripts::UsageSpeed::Ultrafast {
                reported.unwrap_or(0.0)
            } else {
                0.0
            },
            speed_premium_usd: 0.0,
            speed_rate_available: !matches!(speed, super::transcripts::UsageSpeed::Standard),
        };
    };
    let standard_categories = category_cost(totals, &rate.into());
    let standard_cost = category_total(standard_categories);
    let reported = reported_cost_usd.filter(|c| c.is_finite());
    let tier = match speed {
        super::transcripts::UsageSpeed::Standard => Some(SpeedRate::from(rate)),
        super::transcripts::UsageSpeed::Fast => rate.priority.or_else(|| {
            rate.fast_multiplier
                .map(|multiplier| multiply(SpeedRate::from(rate), multiplier))
        }),
        super::transcripts::UsageSpeed::Ultrafast => rate.ultrafast,
    };
    let speed_rate_available =
        matches!(speed, super::transcripts::UsageSpeed::Standard) || tier.is_some();
    let tier_categories = tier.map(|tier| category_cost(totals, &tier));
    let priced_categories = scale_categories(
        tier_categories.unwrap_or(standard_categories),
        reported.unwrap_or_else(|| category_total(tier_categories.unwrap_or(standard_categories))),
    );
    let cost_usd = reported.unwrap_or_else(|| category_total(priced_categories));
    let priced_categories = if category_total(priced_categories) == 0.0 && cost_usd > 0.0 {
        proto::UsageCategoryCost {
            other_usd: cost_usd,
            ..priced_categories
        }
    } else {
        priced_categories
    };
    let standard_estimate = standard_cost;
    let tier_estimate = tier_categories
        .map(category_total)
        .unwrap_or(standard_estimate);
    let premium = if speed_rate_available {
        (tier_estimate - standard_estimate).max(0.0)
    } else {
        0.0
    };
    PricedUsage {
        cost_usd,
        cost_source: if reported.is_some() {
            proto::UsageCostSource::ProviderReported
        } else {
            proto::UsageCostSource::ModelPriced
        },
        category_cost_usd: priced_categories,
        fast_cost_usd: if speed == super::transcripts::UsageSpeed::Fast {
            cost_usd
        } else {
            0.0
        },
        ultrafast_cost_usd: if speed == super::transcripts::UsageSpeed::Ultrafast {
            cost_usd
        } else {
            0.0
        },
        speed_premium_usd: premium,
        speed_rate_available,
    }
}

fn category_cost(totals: &proto::UsageTokenTotals, rate: &SpeedRate) -> proto::UsageCategoryCost {
    proto::UsageCategoryCost {
        input_usd: totals.uncached_input_tokens as f64 * rate.input_cost_per_token,
        cache_read_usd: totals.cached_input_tokens as f64 * rate.cache_read_cost_per_token,
        cache_write_usd: totals.cache_creation_tokens as f64 * rate.cache_creation_cost_per_token,
        output_usd: totals.output_tokens as f64 * rate.output_cost_per_token,
        ..proto::UsageCategoryCost::default()
    }
}

fn category_total(cost: proto::UsageCategoryCost) -> f64 {
    cost.input_usd + cost.cache_read_usd + cost.cache_write_usd + cost.output_usd + cost.other_usd
}

fn scale_categories(cost: proto::UsageCategoryCost, total: f64) -> proto::UsageCategoryCost {
    let estimate = category_total(cost);
    if estimate <= 0.0 {
        return cost;
    }
    let scale = total / estimate;
    proto::UsageCategoryCost {
        input_usd: cost.input_usd * scale,
        cache_read_usd: cost.cache_read_usd * scale,
        cache_write_usd: cost.cache_write_usd * scale,
        output_usd: cost.output_usd * scale,
        other_usd: cost.other_usd * scale,
    }
}

fn multiply(rate: SpeedRate, by: f64) -> SpeedRate {
    SpeedRate {
        input_cost_per_token: rate.input_cost_per_token * by,
        output_cost_per_token: rate.output_cost_per_token * by,
        cache_read_cost_per_token: rate.cache_read_cost_per_token * by,
        cache_creation_cost_per_token: rate.cache_creation_cost_per_token * by,
    }
}

impl From<ModelRate> for SpeedRate {
    fn from(rate: ModelRate) -> Self {
        Self {
            input_cost_per_token: rate.input_cost_per_token,
            output_cost_per_token: rate.output_cost_per_token,
            cache_read_cost_per_token: rate.cache_read_cost_per_token,
            cache_creation_cost_per_token: rate.cache_creation_cost_per_token,
        }
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
        let priced = price_usage(
            &table(),
            "claude-opus-5",
            &totals,
            None,
            super::super::transcripts::UsageSpeed::Standard,
        );
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
            super::super::transcripts::UsageSpeed::Standard,
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
            super::super::transcripts::UsageSpeed::Standard,
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
            super::super::transcripts::UsageSpeed::Standard,
        );
        assert_eq!(priced.cost_source, proto::UsageCostSource::Unpriced);
    }
}
