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
      finding({ key: 'stale-rule', title: 'A rule that never loads', state: 'dismissed', decided_at_ms: 1 })
    ],
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
      liveSessions: new Set([40]),
      onCreateRoutine: vi.fn(),
      onUpdateRoutine: vi.fn(),
      onRunNow: vi.fn(),
      onDecide: vi.fn(),
      onLoadReport: vi.fn(),
      onOpenSession: vi.fn(),
      onOpenFile: vi.fn(),
      onReveal: vi.fn(),
      onPrepareFix: vi.fn()
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

  function openFinding(title: string): void {
    const item = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="list-detail-item"]')).find(
      (b) => b.textContent?.includes(title)
    )
    if (!item) throw new Error(`no finding "${title}" in the list`)
    click(item)
  }

  it('asks for a workspace when none is chosen, and switching one reports it', () => {
    render({ workspace: null, state: null })
    expect(container.textContent).toContain('Choose the workspace whose agent sessions and harness to review')
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

  it('keeps an existing model when it is absent from the current catalog', () => {
    render({ state: harnessState({ routine: routine({ model: 'claude-custom' }), models: [] }) })
    click(button('Schedule'))
    expect(container.querySelector('[data-testid="harness-model"]')?.textContent).toContain('claude-custom')
    click(button('Save schedule'))
    expect(props.onUpdateRoutine).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-custom' }))
  })

  it('a running review disables Run review and names why', () => {
    render({ running: true })
    const run = container.querySelector<HTMLButtonElement>('[data-testid="harness-run"]')!
    expect(run.disabled).toBe(true)
    expect(run.textContent).toBe('Review running…')
    render({ running: false })
    click(container.querySelector<HTMLButtonElement>('[data-testid="harness-run"]')!)
    expect(props.onRunNow).toHaveBeenCalledWith(7)
  })

  it('lists open findings with their evidence and target, and decisions are reversible', () => {
    render()
    expect(button('Open · 1')).toBeTruthy()
    expect(button('Dismissed · 1')).toBeTruthy()
    openFinding('Repeated permission denials')
    const detail = container.querySelector('[data-testid="harness-finding-detail"]')!
    expect(detail.textContent).toContain('Observed in 6 sessions')
    expect(detail.textContent).toContain('Confidence: high')
    expect(detail.textContent).toContain('why was the push denied again')
    expect(detail.textContent).toContain('Sessions: abc123, def456')
    click(button('Open file'))
    expect(props.onOpenFile).toHaveBeenCalledWith(`${WS}/.claude/settings.json`)
    click(button('Dismiss'))
    expect(props.onDecide).toHaveBeenCalledWith('denied-push', 'dismissed')

    click(button('Dismissed · 1'))
    openFinding('A rule that never loads')
    click(button('Reopen'))
    expect(props.onDecide).toHaveBeenLastCalledWith('stale-rule', 'open')
  })

  it('a finding raised again after a decision says so', () => {
    render({ state: harnessState({ findings: [finding({ recurred: true })] }) })
    openFinding('Repeated permission denials')
    expect(container.textContent).toContain('Raised again after a decision')
  })

  it('preparing a fix opens a pane with the edited prompt and leaves the finding open', () => {
    render()
    openFinding('Repeated permission denials')
    click(button('Prepare fix'))
    const area = container.querySelector<HTMLTextAreaElement>('[data-testid="harness-prepare-fix"] textarea')!
    expect(area.value).toBe('Add Bash(git push fork:*) to permissions.allow')
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(area, 'Add the allow rule, then run the tests')
      area.dispatchEvent(new Event('input', { bubbles: true }))
    })
    pickOption(container, 'harness-fix-engine', 'codex')
    expect(container.textContent).toContain('does not mark this finding resolved')
    click(button('Open pane'))
    expect(props.onPrepareFix).toHaveBeenCalledWith('codex', 'Add the allow rule, then run the tests')
    expect(props.onDecide).not.toHaveBeenCalled()
  })

  it('run history shows each run, and a pane link only while the pane lives', () => {
    render({
      state: harnessState({
        reviews: [
          review({ id: 5, run_id: 12, session_id: 41, status: 'failed', error: 'the run ended without publishing' }),
          review()
        ]
      })
    })
    click(container.querySelector<HTMLButtonElement>('[data-testid="harness-tab-history"]')!)
    const text = container.textContent ?? ''
    expect(text).toContain('Failed')
    expect(text).toContain('the run ended without publishing')
    expect(text).toContain('2026-09-01 to 2026-09-15')
    expect(text).toContain('does not mean the findings are resolved')
    const open = Array.from(container.querySelectorAll('button')).filter((b) => b.textContent === 'Open pane')
    expect(open).toHaveLength(1)
    click(open[0])
    expect(props.onOpenSession).toHaveBeenCalledWith(40)
  })

  it('the full report loads the latest published review and opens its files', () => {
    render({ state: harnessState({ reviews: [review({ id: 8, status: 'running' }), review()] }) })
    click(container.querySelector<HTMLButtonElement>('[data-testid="harness-tab-report"]')!)
    expect(props.onLoadReport).toHaveBeenCalledWith(3)
    click(button('Open findings.json'))
    expect(props.onOpenFile).toHaveBeenCalledWith(`${WS}/.houston/harness/r11/findings.json`)
    click(button('Show in folder'))
    expect(props.onReveal).toHaveBeenCalledWith(`${WS}/.houston/harness/r11/report.md`)
    render({ report: { reviewId: 3, markdown: '# Report', truncated: true } })
    expect(container.textContent).toContain('open report.md to read all of it')
  })

  it('the schedule saves provider, model and cadence onto the review routine', () => {
    render()
    expect(container.textContent).toContain('Only when I run it')
    click(button('Schedule'))
    click(button('Daily 09:00'))
    click(button('Save schedule'))
    expect(props.onUpdateRoutine).toHaveBeenCalledWith({
      id: 7,
      expected_revision: 'rev-1',
      engine: 'claude',
      model: null,
      cadence: { type: 'clock', hour: 9, minute: 0, weekdays: null },
      enabled: true
    })
    expect(container.querySelector('[data-testid="harness-schedule"]')).toBeNull()
  })
})
