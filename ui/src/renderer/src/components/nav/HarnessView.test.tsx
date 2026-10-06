// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient } from '../../houston/client'
import type { ServerMsg } from '../../houston/generated/ServerMsg'
import { HarnessView } from './HarnessView'
import { pickOption } from '../../test/selectHarness'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const WS = '/home/dev/proj'

function fakeClient() {
  const handlers = new Map<string, Set<(msg: ServerMsg) => void>>()
  const client = {
    subscribe: (kind: string, handler: (msg: ServerMsg) => void) => {
      const set = handlers.get(kind) ?? new Set()
      set.add(handler)
      handlers.set(kind, set)
      return () => set.delete(handler)
    },
    harnessState: vi.fn(),
    harnessRoutineCreate: vi.fn(),
    harnessReport: vi.fn(),
    harnessDecide: vi.fn(),
    harnessFixTask: vi.fn(),
    harnessSeen: vi.fn(),
    harnessOverviewGet: vi.fn(),
    routineRunNow: vi.fn(),
    routineUpdate: vi.fn()
  }
  const emit = (msg: ServerMsg): void => {
    act(() => handlers.get(msg.type)?.forEach((h) => h(msg)))
  }
  return { client, emit, asClient: client as unknown as HoustonClient }
}

describe('HarnessView', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function render(client: HoustonClient, selectedWorkspace = WS): void {
    act(() =>
      root.render(
        <HarnessView
          client={client}
          workspaces={[{ id: WS, name: 'proj' }]}
          selectedWorkspace={selectedWorkspace}
          routinesRunning={[]}
          attentionRows={[]}
          onOpenFile={vi.fn()}
          onReveal={vi.fn()}
        />
      )
    )
  }

  it('reads the selected workspace, and re-reads it when the daemon says it changed', () => {
    const { client, emit, asClient } = fakeClient()
    render(asClient)
    expect(client.harnessState).toHaveBeenCalledWith(WS)
    emit({ type: 'harness_changed', workspace: '/elsewhere' })
    expect(client.harnessState).toHaveBeenCalledTimes(1)
    emit({ type: 'harness_changed', workspace: WS })
    expect(client.harnessState).toHaveBeenCalledTimes(2)
  })

  it('with no workspace selected it reads nothing until one is chosen', () => {
    const { client, asClient } = fakeClient()
    render(asClient, 'all')
    expect(client.harnessState).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Choose a workspace to see its Harness reviews')
  })

  it('the first review routine is created for the reviewed workspace', () => {
    const { client, emit, asClient } = fakeClient()
    render(asClient)
    emit({
      type: 'harness_state',
      models: [],
      workspace: WS,
      routine: null,
      reviews: [],
      findings: [],
      provider_coverage: []
    })
    expect(container.querySelector('[data-testid="harness-first-run"]')).not.toBeNull()
    act(() =>
      Array.from(container.querySelectorAll('button'))
        .find((b) => b.textContent === 'Run first review')!
        .click()
    )
    expect(client.harnessRoutineCreate).toHaveBeenCalledWith({
      workspace: WS,
      engine: 'claude',
      model: null,
      cadence: { type: 'clock', hour: 9, minute: 0, weekdays: [2] },
      enabled: false
    })
  })

  it('uses models delivered by the daemon when creating a review', () => {
    const { client, emit, asClient } = fakeClient()
    render(asClient)
    emit({
      type: 'harness_state', workspace: WS, routine: null, reviews: [], findings: [],
      models: [{ provider: 'codex', id: 'gpt-catalog-model' }], provider_coverage: []
    })
    pickOption(container, 'harness-provider', 'codex')
    pickOption(container, 'harness-model', 'gpt-catalog-model')
    act(() => Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Run first review')!.click())
    expect(client.harnessRoutineCreate).toHaveBeenCalledWith(expect.objectContaining({
      engine: 'codex', model: 'gpt-catalog-model'
    }))
  })

  it('a decision is sent for the reviewed workspace', () => {
    const { client, emit, asClient } = fakeClient()
    render(asClient)
    emit({
      type: 'harness_state',
      models: [],
      workspace: WS,
      routine: {
        id: 7,
        name: 'Harness review · proj',
        prompt: 'p',
        cadence: { type: 'clock', hour: 9, minute: 0, weekdays: [2] },
        enabled: false,
        workspace_id: WS,
        engine: 'claude',
        next_run_at_ms: 0,
        permission_mode: 'accept_edits',
        isolate: false,
        revision: 'r'
      },
      reviews: [],
      findings: [
        {
          review_id: 1,
          key: 'denied-push',
          title: 'Denied push',
          category: '',
          confidence: 'high',
          sessions: [],
          count: 2,
          quotes: [],
          recommendation_kind: '',
          target: '',
          recommendation: '',
          apply_prompt: '',
          state: 'open',
          recurred: false,
          phase: 'open',
          last_seen_review_id: 1
        }
      ],
      provider_coverage: []
    })
    act(() => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Dismiss')!.click())
    expect(client.harnessDecide).toHaveBeenCalledWith(WS, 'denied-push', 'dismissed')
  })

  it('a refused routine creation is shown with its limit', () => {
    const { emit, asClient } = fakeClient()
    render(asClient)
    emit({ type: 'routine_refused', id: null, kind: 'limit', limit: 4096, requested: 4097 })
    expect(container.textContent).toContain('4096')
  })

  it('creates a Harness fix task with the finding workspace and apply prompt', () => {
    const { client, emit, asClient } = fakeClient()
    render(asClient)
    emit({
      type: 'harness_state',
      models: [],
      workspace: WS,
      routine: { id: 7, name: 'Harness', prompt: 'p', cadence: { type: 'interval', seconds: 60 }, enabled: false, engine: 'claude', next_run_at_ms: 0, permission_mode: 'accept_edits', isolate: false, revision: 'r' },
      reviews: [],
      findings: [{
        review_id: 1, key: 'HOU-12', title: 'Repeated mistake', category: '', confidence: '', sessions: [], count: 2, quotes: [], recommendation_kind: '', target: '', recommendation: '', apply_prompt: 'Fix this safely.', state: 'open', recurred: false, phase: 'open', last_seen_review_id: 1
      }],
      provider_coverage: []
    })
    act(() => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Create task')!.click())
    expect(client.harnessFixTask).toHaveBeenCalledWith(WS, 'HOU-12', 'claude', 'Fix this safely.')
  })

  it('dismisses a published-review notice through HarnessSeen', () => {
    const { client, emit, asClient } = fakeClient()
    render(asClient)
    emit({
      type: 'harness_state', workspace: WS, routine: null, reviews: [{ id: 2, workspace: WS, routine_id: 1, run_id: 2, status: 'published', started_at_ms: 1, run_dir: WS, finding_count: 1, sessions: 3 }], findings: [], models: [], provider_coverage: []
    })
    act(() => root.render(
      <HarnessView client={asClient} workspaces={[{ id: WS, name: 'proj' }]} selectedWorkspace={WS} routinesRunning={[]} attentionRows={[{
        workspace: WS, open: 1, fixing: 0, awaiting_verification: 0, not_seen: 0, resolved: 0, dismissed: 0, latest_published_review_id: 2, seen_review_id: 1, attention: 1
      }]} onOpenFile={vi.fn()} onReveal={vi.fn()} />
    ))
    const notice = container.querySelector('[data-tone="info"] button') as HTMLButtonElement
    act(() => notice.click())
    expect(client.harnessSeen).toHaveBeenCalledWith(WS, 2)
  })
})
