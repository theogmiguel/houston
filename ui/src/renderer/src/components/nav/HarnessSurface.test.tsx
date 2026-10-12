// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessFinding } from '../../houston/generated/HarnessFinding'
import type { HarnessReview } from '../../houston/generated/HarnessReview'
import type { Routine } from '../../houston/generated/Routine'
import type { HarnessState } from '../../houston/useHarness'
import { closeSelect, openSelect, pickOption, selectOptionLabels, selectValue } from '../../test/selectHarness'
import { HarnessSurface, type HarnessSurfaceProps } from './HarnessSurface'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const WS = '/home/dev/proj'

function routine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: 7,
    kind: 'harness_review',
    engine: 'claude',
    name: 'Harness review · proj',
    prompt: '[houston harness review]',
    cadence: { type: 'clock', hour: 9, minute: 0, weekdays: [2] },
    enabled: false,
    workspace_id: WS,
    permission_mode: 'accept_edits',
    isolate: false,
    next_run_at_ms: 0,
    last_run_at_ms: null,
    last_run_session_id: null,
    last_error: null,
    revision: 'rev-1',
    ...overrides
  }
}

function review(overrides: Partial<HarnessReview> = {}): HarnessReview {
  return {
    id: 3,
    workspace: WS,
    routine_id: 7,
    run_id: 11,
    session_id: 40,
    status: 'published',
    started_at_ms: Date.UTC(2026, 8, 15),
    ended_at_ms: Date.UTC(2026, 8, 15, 1),
    run_dir: `${WS}/.houston/harness/r11`,
    window: ['2026-09-01', '2026-09-15'],
    sessions: 7,
    prompts: 40,
    cost_usd: 1.25,
    finding_count: 2,
    summary: '2 findings',
    error: null,
    ...overrides
  }
}

function finding(overrides: Partial<HarnessFinding> = {}): HarnessFinding {
  return {
    review_id: 3,
    key: 'denied-push',
    title: 'Repeated permission denials for git push',
    category: 'permissions',
    confidence: 'high',
    sessions: ['abc123', 'def456'],
    count: 6,
    quotes: ['why was the push denied again'],
    recommendation_kind: 'settings-allow',
    target: '.claude/settings.json',
    recommendation: 'Allow git push to the fork remote.',
    apply_prompt: 'Add Bash(git push fork:*) to permissions.allow',
    state: 'open',
    decided_at_ms: null,
    recurred: false,
    phase: 'open',
    task: null,
    verification: null,
    last_seen_review_id: 3,
    ...overrides
  }
}

function harnessState(overrides: Partial<HarnessState> = {}): HarnessState {
  return {
    workspace: WS,
    routine: routine(),
    models: [{ provider: 'claude', id: 'claude-sonnet-test' }, { provider: 'codex', id: 'gpt-test' }],
    reviews: [review()],
    findings: [
      finding(),
      finding({ key: 'stale-rule', title: 'A rule that never loads', state: 'dismissed', phase: 'dismissed', decided_at_ms: 1 })
    ],
    providerCoverage: [],
    engineRefusals: [],
    ...overrides
  }
}

describe('HarnessSurface', () => {
  let container: HTMLDivElement
  let root: Root
  let props: HarnessSurfaceProps

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    props = {
      workspaces: [
        { id: WS, name: 'proj' },
        { id: '/home/dev/other', name: 'other' }
      ],
      workspace: WS,
      onWorkspace: vi.fn(),
      state: harnessState(),
      report: null,
      running: false,
      onCreateRoutine: vi.fn(),
      onRunNow: vi.fn(),
      onDecide: vi.fn(),
      attention: null,
      onSeen: vi.fn(),
      onCreateTask: vi.fn(),
      onLoadReport: vi.fn(),
      onOpenFile: vi.fn(),
      onReveal: vi.fn()
    }
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.innerHTML = ''
  })

  function render(over: Partial<HarnessSurfaceProps> = {}): void {
    props = { ...props, ...over }
    act(() => root.render(<HarnessSurface {...props} />))
  }

  function button(label: string): HTMLButtonElement {
    const found = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === label
    )
    if (!found) throw new Error(`no button "${label}"`)
    return found
  }

  function click(el: HTMLElement): void {
    act(() => el.click())
  }

  it('embeds Review without a schedule form and routes first-run setup to Routines', () => {
    props = { ...props, embedded: true, state: harnessState({ routine: null }), onOpenRoutines: vi.fn() }
    act(() => root.render(<HarnessSurface {...props} />))
    expect(container.querySelector('h1')?.textContent).toBe('Review')
    expect(container.querySelector('form')).toBeNull()
    expect(container.querySelector('main')).toBeNull()
    const open = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Open Routines')!
    act(() => open.click())
    expect(props.onOpenRoutines).toHaveBeenCalledOnce()
  })

  it('asks for a workspace when none is chosen, and switching one reports it', () => {
    render({ workspace: null, state: null })
    expect(container.textContent).toContain('Choose a workspace to see its Harness reviews')
    expect(container.querySelector('[data-testid="harness-run"]')).toBeNull()
    pickOption(container, 'harness-workspace', '/home/dev/other')
    expect(props.onWorkspace).toHaveBeenCalledWith('/home/dev/other')
  })

  it('first use shows ZCode and OpenCode unavailable, with why, because a review starts with accept edits', () => {
    const reason = 'its edit mode waits for approval on every shell command, and nobody gives it'
    render({
      state: harnessState({
        routine: null,
        reviews: [],
        findings: [],
        engineRefusals: [
          { engine: 'opencode', permission_mode: 'accept_edits', reason: 'its only unattended mode approves every action, as full access does' },
          { engine: 'zcode', permission_mode: 'accept_edits', reason },
          { engine: 'codex', permission_mode: 'bypass_permissions', reason: 'a refusal under another access level' }
        ]
      })
    })
    const rows = openSelect(container, 'harness-provider')
    const disabled = rows.filter((r) => r.getAttribute('aria-disabled') === 'true').map((r) => r.dataset.value)
    expect(disabled).toEqual(['opencode', 'zcode'])
    const zcode = rows.find((r) => r.dataset.value === 'zcode')!
    expect(zcode.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe(
      `ZCode needs isolated full access: ${reason}. A review starts with accept edits: start it with another provider, then change its access in Routines.`
    )
    act(() => zcode.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 })))
    closeSelect(container, 'harness-provider')
    expect(selectValue(container, 'harness-provider')).toBe('Claude Code')
  })

  it('first use shows what a run sends, creates the routine and runs it once it exists', () => {
    render({ state: harnessState({ routine: null, reviews: [], findings: [] }) })
    expect(container.querySelector('[data-testid="harness-consent"]')?.textContent).toContain(
      'permission denials with secrets masked'
    )
    pickOption(container, 'harness-provider', 'codex')
    pickOption(container, 'harness-model', 'gpt-test')
    click(button('Mondays 09:00'))
    expect(button('Run first review').closest('header')).not.toBeNull()
    click(button('Run first review'))
    expect(props.onCreateRoutine).toHaveBeenCalledWith({
      engine: 'codex',
      model: 'gpt-test',
      cadence: { type: 'clock', hour: 9, minute: 0, weekdays: [2] },
      enabled: true
    })
    expect(props.onRunNow).not.toHaveBeenCalled()

    render({ state: harnessState({ routine: routine({ id: 9 }), reviews: [], findings: [] }) })
    expect(props.onRunNow).toHaveBeenCalledTimes(1)
    expect(props.onRunNow).toHaveBeenCalledWith(9)
    render({ state: harnessState({ routine: routine({ id: 9 }), reviews: [], findings: [] }) })
    expect(props.onRunNow).toHaveBeenCalledTimes(1)
  })

  it('a routine without a published review shows no 0 → 0 trend line', () => {
    render({ state: harnessState({ routine: routine({ id: 9 }), reviews: [], findings: [] }) })
    expect(container.textContent).not.toContain('Repeated mistakes per 100 sessions')
    expect(container.textContent).toContain('No published reviews yet.')
  })

  it('filters catalog models by provider and resets the model when the provider changes', () => {
    render({ state: harnessState({ routine: null }) })
    pickOption(container, 'harness-model', 'claude-sonnet-test')
    pickOption(container, 'harness-provider', 'codex')
    const options = selectOptionLabels(container, 'harness-model')
    expect(options).toContain('gpt-test')
    expect(options).not.toContain('claude-sonnet-test')
    expect(container.querySelector('[data-testid="harness-model"]')?.textContent).toContain("The provider's default")
  })

  it('a running review disables Run review now', () => {
    render({ running: true })
    const run = container.querySelector<HTMLButtonElement>('[data-testid="harness-run"]')!
    expect(run.disabled).toBe(true)
    expect(run.textContent).toBe('Review running…')
    render({ running: false })
    click(container.querySelector<HTMLButtonElement>('[data-testid="harness-run"]')!)
    expect(props.onRunNow).toHaveBeenCalledWith(7)
  })

  it('shows one actionable row per active phase and sends task and decision callbacks', () => {
    render()
    expect(container.textContent).toContain('Active1')
    expect(button('Create task')).toBeTruthy()
    click(button('Dismiss'))
    expect(props.onDecide).toHaveBeenCalledWith('denied-push', 'dismissed')
  })

  it('creates a linked task from the finding prompt', () => {
    render()
    click(button('Create task'))
    expect(props.onCreateTask).toHaveBeenCalledWith('denied-push', 'claude', 'Add Bash(git push fork:*) to permissions.allow')
  })

  it('opens the full report for the review from its history row', () => {
    render({ state: harnessState({ reviews: [review({ id: 8, status: 'running' }), review()] }) })
    click(button('Full report'))
    expect(props.onLoadReport).toHaveBeenCalledWith(3)
    click(button('Open findings.json'))
    expect(props.onOpenFile).toHaveBeenCalledWith(`${WS}/.houston/harness/r11/findings.json`)
    click(button('Show in folder'))
    expect(props.onReveal).toHaveBeenCalledWith(`${WS}/.houston/harness/r11/report.md`)
    render({ report: { reviewId: 3, markdown: '# Report', truncated: true } })
    expect(container.textContent).toContain('open report.md to read all of it')
  })

  it('renders the harness story trend and compact older-review delta', () => {
    const latest = review({ id: 13, sessions: 38, finding_count: 7 })
    const older = review({ id: 12, sessions: 41, finding_count: 10 })
    render({
      state: harnessState({ reviews: [latest, older] }),
      trendValues: [41, 33, 25, 18],
      trendReviewCount: 4,
      historyDeltaOverrides: { 12: { new: 2, gone: 1 } }
    })
    expect(container.textContent).toContain('Repeated mistakes per 100 sessions: 41 → 18 over 4 reviews')
    expect(container.textContent).toContain('41 sessions · 2 new · 1 gone')
  })
  it('puts the reported Settings review summary and its actions in one card', () => {
    render({ embedded: true, onOpenRoutines: vi.fn(), state: harnessState({ routine: routine({ enabled: true }), reviews: [review({ sessions: 38, finding_count: 7 }), review({ id: 2, sessions: 41, finding_count: 17 })] }) })
    const summary = container.querySelector('[data-testid="review-summary"]')!
    expect(summary).not.toBeNull()
    expect(summary.textContent).toContain('Repeated mistakes fell from 41 to 18 per 100 sessions')
    expect(summary.textContent).toContain('38 sessions')
    click(button('Review now'))
    expect(props.onRunNow).toHaveBeenCalledWith(7)
    click(button('Edit schedule in Routines'))
    expect(props.onOpenRoutines).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Open findings')
    expect(container.textContent).toContain('New')
    expect(container.querySelector('form')).toBeNull()
  })
  it('does not turn an unreported review session total into a zero trend', () => {
    render({ embedded: true, state: harnessState({ reviews: [review({ sessions: null })] }) })
    expect(container.textContent).not.toContain('Repeated mistakes per 100 sessions: 0')
    const summary = container.querySelector('[data-testid="review-summary"]')!
    expect(summary).not.toBeNull()
    expect(summary.textContent).toContain('Session total not reported')
    expect(summary.textContent).not.toContain('per 100 sessions')
    expect(container.textContent).not.toContain('6 of 6 sessions')
  })

})
