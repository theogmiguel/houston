// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessFinding } from '../../houston/generated/HarnessFinding'
import type { HarnessReview } from '../../houston/generated/HarnessReview'
import type { Routine } from '../../houston/generated/Routine'
import type { HarnessState } from '../../houston/useHarness'
import { pickOption, selectOptionLabels } from '../../test/selectHarness'
import { HarnessSurface, type HarnessSurfaceProps } from './HarnessSurface'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const WS = '/home/dev/proj'

function routine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: 7,
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

  it('asks for a workspace when none is chosen, and switching one reports it', () => {
    render({ workspace: null, state: null })
    expect(container.textContent).toContain('Choose a workspace to see its Harness reviews')
    expect(container.querySelector('[data-testid="harness-run"]')).toBeNull()
    pickOption(container, 'harness-workspace', '/home/dev/other')
    expect(props.onWorkspace).toHaveBeenCalledWith('/home/dev/other')
  })

  it('first use shows what a run sends, creates the routine and runs it once it exists', () => {
    render({ state: harnessState({ routine: null, reviews: [], findings: [] }) })
    expect(container.querySelector('[data-testid="harness-consent"]')?.textContent).toContain(
      'permission denials with secrets masked'
    )
    pickOption(container, 'harness-provider', 'codex')
    pickOption(container, 'harness-model', 'gpt-test')
    click(button('Mondays 09:00'))
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
})
