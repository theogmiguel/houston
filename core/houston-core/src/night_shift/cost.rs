//! A run's cost: pane-hours accrued while it runs, plus the token totals the
//! providers' own session logs report once it has ended. A provider with no
//! usage source keeps `None`, never a zero that reads as "used nothing".
use houston_protocol as proto;

/// Sums usage buckets into one total per provider, in first-seen order.
pub fn totals_by_provider(
    buckets: &[proto::UsageBucket],
) -> Vec<(proto::AgentKind, proto::UsageTokenTotals)> {
    let mut out: Vec<(proto::AgentKind, proto::UsageTokenTotals)> = Vec::new();
    for bucket in buckets {
        let provider = bucket.provider.agent_kind();
        match out.iter_mut().find(|(seen, _)| *seen == provider) {
            Some((_, totals)) => totals.add(&bucket.totals),
            None => out.push((provider, bucket.totals)),
        }
    }
    out
}

/// Adds each provider's totals to the run's cost, creating the line for a
/// provider that used tokens but never accrued pane-hours.
pub fn add_tokens(
    cost: &mut proto::NightCost,
    totals: &[(proto::AgentKind, proto::UsageTokenTotals)],
) {
    for (provider, tokens) in totals {
        match cost
            .per_provider
            .iter_mut()
            .find(|line| line.provider == *provider)
        {
            Some(line) => line.tokens = Some(*tokens),
            None => cost.per_provider.push(proto::NightCostLine {
                provider: *provider,
                panes: 0,
                pane_hours: 0.0,
                tokens: Some(*tokens),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bucket(provider: proto::UsageProvider, uncached: u64, output: u64) -> proto::UsageBucket {
        proto::UsageBucket {
            hour_start_ms: 0,
            provider,
            model: "fixture".into(),
            totals: proto::UsageTokenTotals {
                uncached_input_tokens: uncached,
                output_tokens: output,
                ..Default::default()
            },
            cost_usd: 0.0,
            cache_savings_usd: 0.0,
            cost_source: proto::UsageCostSource::Unpriced,
            records: 1,
            unpriced_records: 1,
            sessions: 1,
            workspace_path: None,
            category_cost_usd: proto::UsageCategoryCost::default(),
            fast_cost_usd: 0.0,
            ultrafast_cost_usd: 0.0,
            speed_premium_usd: 0.0,
            speed_rate_available: false,
        }
    }

    #[test]
    fn a_provider_with_tokens_but_no_pane_hours_gets_a_line() {
        let mut cost = proto::NightCost {
            pane_hours: 2.0,
            panes: 1,
            per_provider: vec![proto::NightCostLine {
                provider: proto::AgentKind::Claude,
                panes: 1,
                pane_hours: 2.0,
                tokens: None,
            }],
        };
        let buckets = vec![
            bucket(proto::UsageProvider::Claude, 10, 20),
            bucket(proto::UsageProvider::Claude, 30, 40),
            bucket(proto::UsageProvider::Codex, 7, 8),
        ];
        add_tokens(&mut cost, &totals_by_provider(&buckets));

        let claude = cost
            .per_provider
            .iter()
            .find(|l| l.provider == proto::AgentKind::Claude)
            .expect("the pane-hours line stays");
        assert_eq!(claude.pane_hours, 2.0);
        let tokens = claude.tokens.as_ref().expect("Claude's totals");
        assert_eq!(tokens.uncached_input_tokens, 40);
        assert_eq!(tokens.output_tokens, 60);

        let codex = cost
            .per_provider
            .iter()
            .find(|l| l.provider == proto::AgentKind::Codex)
            .expect("tokens alone create the line");
        assert_eq!(codex.panes, 0);
        assert_eq!(codex.pane_hours, 0.0);
        assert_eq!(codex.tokens.as_ref().map(|t| t.total()), Some(15));
    }

    #[test]
    fn a_provider_without_a_usage_source_keeps_none() {
        let mut cost = proto::NightCost {
            pane_hours: 1.0,
            panes: 1,
            per_provider: vec![proto::NightCostLine {
                provider: proto::AgentKind::Zcode,
                panes: 1,
                pane_hours: 1.0,
                tokens: None,
            }],
        };
        add_tokens(
            &mut cost,
            &totals_by_provider(&[bucket(proto::UsageProvider::Claude, 1, 2)]),
        );
        let zcode = cost
            .per_provider
            .iter()
            .find(|l| l.provider == proto::AgentKind::Zcode)
            .unwrap();
        assert!(
            zcode.tokens.is_none(),
            "ZCode exposes no tokens; it must not read as zero"
        );
    }

    #[test]
    fn an_old_cost_json_without_tokens_still_loads() {
        let old = r#"{"pane_hours":1.5,"panes":2,"per_provider":[
            {"provider":"claude","panes":2,"pane_hours":1.5}
        ]}"#;
        let cost: proto::NightCost = serde_json::from_str(old).expect("a stored cost loads");
        assert!(cost.per_provider[0].tokens.is_none());
    }
}
