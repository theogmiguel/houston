import React from 'react'
import { UsageSection, type UsageSummaryMsg } from '../src/components/UsageSection'
import type { UsageActivityDay } from '../src/houston/generated/UsageActivityDay'
import type { UsageBucket } from '../src/houston/generated/UsageBucket'

const NOW = Date.UTC(2025, 9, 3, 21)
const DAY = 86_400_000
const DAILY_COST: Record<'claude' | 'codex', number[]> = {
  claude: [260, 310, 280, 320, 310, 360, 231.4],
  codex: [35, 45, 55, 45, 65, 90, 79.9]
}
const DAILY_TOKENS: Record<'claude' | 'codex', number[]> = {
  claude: [500, 610, 540, 680, 590, 700, 480].map((value) => value * 1_000_000),
  codex: [60, 68, 72, 64, 78, 84, 86].map((value) => value * 1_000_000)
}

function fixtureBuckets(): UsageBucket[] {
  const rows: UsageBucket[] = []
  for (const provider of ['claude', 'codex'] as const) {
    DAILY_COST[provider].forEach((cost, index) => {
      const tokens = DAILY_TOKENS[provider][index]
        const models = provider === 'claude'
          ? [{ name: 'claude-opus-5-5', share: 1812.3 / 2071.4, tokenShare: 2.9 / 4.1 }, { name: 'claude-sonnet-5-5', share: 259.1 / 2071.4, tokenShare: 1.2 / 4.1 }]
          : [{ name: 'gpt-5.5-codex', share: 402.1 / 414.9, tokenShare: 498 / 512 }, { name: 'gpt-5.5-codex-mini', share: 12.8 / 414.9, tokenShare: 14 / 512 }]
        models.forEach((model) => {
          const rowCost = cost * model.share
          const rowTokens = Math.round(tokens * model.tokenShare)
          rows.push({
            hour_start_ms: NOW - (6 - index) * DAY,
            provider,
            model: model.name,
            totals: {
              uncached_input_tokens: Math.round(rowTokens * (61 / 4608.8)),
              cached_input_tokens: Math.round(rowTokens * (4300 / 4608.8)),
              cache_creation_tokens: Math.round(rowTokens * (238 / 4608.8)),
              output_tokens: Math.round(rowTokens * (9.8 / 4608.8)),
              reasoning_tokens: 0
            },
            cost_usd: rowCost,
            cache_savings_usd: rowCost * (18240.55 / 2486.3),
            cost_source: 'model_priced',
            records: 24,
            unpriced_records: 0,
            sessions: provider === 'claude' ? 172 : 42,
            workspace_path: null,
            category_cost_usd: {
              input_usd: rowCost * (112.4 / 2486.3),
              cache_read_usd: rowCost * (1021.7 / 2486.3),
              cache_write_usd: rowCost * (846.2 / 2486.3),
              output_usd: rowCost * (506 / 2486.3),
              other_usd: 0
            },
            fast_cost_usd: rowCost * (41.2 / 2486.3),
            ultrafast_cost_usd: rowCost * (144 / 2486.3),
            speed_premium_usd: rowCost * (121.4 / 2486.3),
            speed_rate_available: true
          })
        })
    })
  }
  return rows
}

function fixtureSummary(): UsageSummaryMsg {
  const since = NOW - 6 * DAY
  return {
    type: 'usage_summary',
    since_ms: since,
    until_ms: NOW,
    read_at_ms: NOW,
    buckets: fixtureBuckets(),
    sources: [
      { provider: 'codex', path: '~/.codex/sessions', profile_name: null, status: 'ok', scanned_files: 42, skipped_files: 0, failed_files: 0, distinct_sessions: 42, message: null },
      { provider: 'claude', path: '~/.claude/projects', profile_name: null, status: 'ok', scanned_files: 172, skipped_files: 0, failed_files: 0, distinct_sessions: 172, message: null }
    ],
    pricing: { status: 'cached', source: 'LiteLLM', fetched_at_ms: NOW, known_models: 1681, message: null },
    untracked_agents: ['antigravity', 'opencode', 'cursor', 'grok'],
    scan_duration_ms: 940
  }
}

function fixtureActivity(): UsageActivityDay[] {
  const values = Array.from({ length: 180 }, (_, index) => 100 + ((index * 37) % 420))
  const scale = 20_591 / values.reduce((sum, value) => sum + value, 0)
  const start = new Date(NOW)
  start.setDate(start.getDate() - 179)
  return values.map((value, index) => {
    const date = new Date(start)
    date.setDate(date.getDate() + index)
    const cost = index === values.length - 1 ? 20_591 - values.slice(0, -1).reduce((sum, amount) => sum + Math.round(amount * scale * 100) / 100, 0) : Math.round(value * scale * 100) / 100
    const totals = { uncached_input_tokens: 20_000_000, cached_input_tokens: 30_000_000, cache_creation_tokens: 4_000_000, output_tokens: 8_000_000, reasoning_tokens: 0 }
    return { day: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`, cost_usd: cost, totals }
  })
}

export function UsagePageStory(): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 bg-[var(--content-bg)]">
      <aside className="grid flex-none content-start gap-[var(--space-3)] px-[var(--space-2)] py-[var(--space-2)] text-[var(--text-secondary)]" style={{ width: 148, background: 'var(--rail-bg)' }}>
        <div className="px-[var(--space-2)] text-[length:var(--tr-text-small-size)] font-semibold tracking-[0.08em] text-[var(--text-faint)]">HOUSTON</div>
        <div className="grid gap-[var(--space-1)] px-[var(--space-2)] text-[length:var(--tr-text-small-size)]">
          <span className="flex items-center gap-[var(--space-2)]"><i className="h-[6px] w-[6px] rounded-full bg-[var(--info)]" />auth-refactor</span>
          <span className="flex items-center gap-[var(--space-2)]"><i className="h-[6px] w-[6px] rounded-full bg-[var(--warn)]" />migrate-db</span>
          <span className="flex items-center gap-[var(--space-2)]"><i className="h-[6px] w-[6px] rounded-full border border-[var(--text-faint)]" />shell</span>
        </div>
        <div className="border-t border-[var(--divider)]" />
        <div className="grid gap-[var(--space-1)] text-[length:var(--tr-text-small-size)]">
          {['Tasks', 'Routines', 'Skills', 'Harness', 'Connections', 'Usage'].map((name) => <div key={name} className={`flex items-center justify-between rounded-[var(--tr-radius-sm)] px-[var(--space-2)] py-[var(--space-1)] ${name === 'Usage' ? 'bg-[var(--hover-fill)] text-[var(--text-primary)]' : ''}`}><span>{name}</span>{name === 'Tasks' ? <span className="text-[var(--warn)]">2</span> : name === 'Harness' ? <span className="text-[var(--warn)]">1</span> : null}</div>)}
        </div>
      </aside>
      <div className="min-h-0 min-w-0 flex-1">
        <UsageSection
          summary={fixtureSummary()}
          activity={fixtureActivity()}
          loading={false}
          error={null}
          workspaces={[{ path: '/home/dev/code/houston', name: 'houston' }]}
          initialWorkspace="all"
          onRequest={() => {}}
          onActivityRequest={() => {}}
        />
      </div>
    </div>
  )
}
