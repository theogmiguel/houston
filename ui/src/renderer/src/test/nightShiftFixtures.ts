import type { NightEntry } from '../houston/generated/NightEntry'
import type { NightRun } from '../houston/generated/NightRun'
import type { NightShiftSettings } from '../houston/generated/NightShiftSettings'

export const NIGHT_NOW = 1_790_000_000_000

/** The daemon's defaults (door 10). */
export function nightDefaults(): NightShiftSettings {
  return {
    v: 2,
    enabled: false,
    window: { start: { hour: 23, minute: 30 }, wrap_up: { hour: 6, minute: 45 }, hard_stop: { hour: 7, minute: 30 }, nights: [] },
    focus: { reliability: 'normal', performance: 'normal', ui_polish: 'off', competitor_gaps: 'off', docs_accuracy: 'off', test_gaps: 'off' },
    goal: '',
    competitor_sources: [],
    orchestrator: { provider: 'claude', model: 'opus' },
    workers: [{ provider: 'zcode', model: 'GLM-5.3-Flash' }, { provider: 'claude', model: 'opus' }],
    live_workers: 4,
    reviewer: null,
    output: 'prs',
    pr_size: { kind: 'related', max_changes: 5 },
    screenshots: true,
    app_check: null,
    hold_for_qa: true,
    checks: [],
    questions: 'park'
  }
}

export function nightEntry(overrides: Partial<NightEntry>): NightEntry {
  return {
    id: 1, run_id: 7, kind: 'plan', title: 'Entry', theme: null, status: null, pr_number: null, visible: false, qa_passed: false,
    body: '', gates: { checks: 'none', review: 'none', qa: 'none', ci: 'none', reruns: 0 }, created_at_ms: NIGHT_NOW,
    decided_at_ms: null, choice: null, ...overrides
  }
}

export function nightRun(overrides: Partial<NightRun> = {}): NightRun {
  return {
    run_id: 7, routine_id: 3, workspace: '/w', trigger: 'manual', phase: 'running', session_id: 40,
    started_at_ms: NIGHT_NOW - 2 * 3_600_000, wrap_up_at_ms: NIGHT_NOW + 3 * 3_600_000, hard_stop_at_ms: NIGHT_NOW + 4 * 3_600_000,
    ended_at_ms: null, report_path: '/s/night-shift/7/report.md', report_published: false, summary: null, stop_reason: null,
    stop_detail: null,
    interruptions: [{ at_ms: NIGHT_NOW - 3_600_000, resumed_at_ms: NIGHT_NOW - 3_500_000, detail: 'the daemon restarted; the run continued', resumed: true }],
    cost: { pane_hours: 7.5, panes: 3, per_provider: [{ provider: 'claude', panes: 2, pane_hours: 5 }, { provider: 'zcode', panes: 1, pane_hours: 2.5 }] },
    limited: [], preflight: [], keep_awake: 'held', merge_order: [],
    entries: [
      nightEntry({ id: 1, kind: 'plan', title: 'Faster attach', theme: 'performance' }),
      nightEntry({ id: 2, kind: 'pr', title: 'Tray fix', theme: 'reliability', pr_number: 12 }),
      nightEntry({ id: 3, kind: 'deferred', title: 'Rewrite the tray' })
    ],
    crew: [
      { session_id: 40, provider: 'claude', role: null, status: 'working', started_at_ms: NIGHT_NOW - 2 * 3_600_000, limited: false },
      { session_id: 41, provider: 'zcode', role: 'worker-1', status: 'idle', started_at_ms: NIGHT_NOW - 3_600_000, limited: false }
    ],
    ...overrides
  }
}
