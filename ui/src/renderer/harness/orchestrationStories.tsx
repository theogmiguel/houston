import React, { useEffect, useMemo, useRef } from 'react'
import { HandoffOverlay, type HandoffUiState } from '../src/components/HandoffOverlay'
import { PaneHandoff } from '../src/components/PaneHandoff'
import { QuestionCard } from '../src/components/QuestionCard'
import DelegationPanel from '../src/components/DelegationPanel'
import type { HoustonClient, ServerMsg, SessionInfo } from '../src/houston/client'
import { OverviewTab } from '../src/components/OverviewTab'
import { InstructionQueue } from '../src/components/InstructionQueue'
import type { DelegationResult } from '../src/houston/generated/DelegationResult'
import { ChildInputBanner, ChildInputDetails, ParentOwnedInput } from '../src/components/ChildInputDetails'
import { withPermissionOwner } from '../src/test/inputFixtures'

const noop = (): void => {}

const MARKDOWN = '# Goal\nShip the **roster** conversion.\n\n## Done\n- Moved `children-row` rules\n- Kept the hooks\n\n```\nbun run typecheck\n```\n\n### Next\nRun the pixel diff.'
const STATIC_MOTION = <style>{`.orchestration-static *, .orchestration-static *::before, .orchestration-static *::after { animation: none !important; transition: none !important; }`}</style>

function handoffState(over: Partial<HandoffUiState>): HandoffUiState {
  return { request: 1, session: 1, sessionTitle: 'Review API changes', provider: 'Claude Code', phase: 'done', text: '', markdown: MARKDOWN, savedPath: '', error: '', ...over }
}

function Cell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div style={{ position: 'relative', height: 390, border: '1px solid var(--border)' }}>{children}</div>
}

export function HandoffStatesStory(): React.JSX.Element {
  return (
    <div className="orchestration-static" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, padding: 8, height: '100%', background: 'var(--content-bg)' }}>
      {STATIC_MOTION}
      <Cell><HandoffOverlay state={handoffState({ phase: 'generating', markdown: '' })} onCancel={noop} onClose={noop} onPaste={noop} /></Cell>
      <Cell><HandoffOverlay state={handoffState({ phase: 'generating', text: MARKDOWN, markdown: '' })} onCancel={noop} onClose={noop} onPaste={noop} /></Cell>
      <Cell><HandoffOverlay state={handoffState({ savedPath: '/work/acme/.houston/handoff.md' })} onCancel={noop} onClose={noop} onPaste={noop} /></Cell>
      <Cell><HandoffOverlay state={handoffState({ phase: 'error', markdown: '', error: 'The provider closed the stream before the packet finished.' })} onCancel={noop} onClose={noop} onPaste={noop} /></Cell>
    </div>
  )
}

export function PaneHandoffSelectedStory(): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('[data-agent="codex"]')?.click()
  }, [])
  return (
    <div ref={ref} className="orchestration-static">
      {STATIC_MOTION}
      <PaneHandoff source={{ session: 1, agent: 'claude', title: 'Review API changes', cwd: '/home/dev/acme', conversation: 'We have finished the API review.' }} onCancel={noop} onHandoff={noop} />
    </div>
  )
}

const OPTIONS = [{ id: 'tests', label: 'Add regression tests' }, { id: 'docs', label: 'Update the docs' }, { id: 'perf', label: 'Measure the render path before changing it so the numbers settle the argument' }]

export function QuestionStatesStory(): React.JSX.Element {
  const common = { questionIndex: 1, questionCount: 3, question: 'Which change should land first?', onSkip: noop }
  return (
    <div className="orchestration-static" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, padding: 12, alignItems: 'start', background: 'var(--content-bg)' }}>
      {STATIC_MOTION}
      <QuestionCard {...common} body="multi-select" options={OPTIONS} selectedIds={['tests', 'perf']} onToggleOption={noop} />
      <QuestionCard {...common} body="single-select" options={OPTIONS} selectedId="docs" onSelectOption={noop} disabled disabledReason="Answered elsewhere" />
      <QuestionCard {...common} body="free-text" freeTextValue="Docs first" onFreeTextChange={noop} />
      <QuestionCard {...common} body="single-select" loading />
      <QuestionCard {...common} body="single-select" error={{ message: 'Could not load the options.', onRetry: noop }} />
      <QuestionCard {...common} body="single-select" options={[]} />
      <QuestionCard {...common} body="multi-select" />
      <QuestionCard {...common} body="free-text" disabled disabledReason="Answered elsewhere" />
    </div>
  )
}

const NOW = 1_700_000_000_000
const WS = '/home/dev/code/houston'

function pane(id: number, over: Partial<SessionInfo>): SessionInfo {
  return { id, agent: 'claude', project_dir: WS, cwd: WS, state: 'running', title: `pane ${id}`, codename: null, hidden: false, live_children: 0, children_waiting: 0, inbox_unread: 0, tags: [], resumable: false, status: 'working', spawned_by: null, ...over } as SessionInfo
}

const CHILD = pane(21, {
  title: 'Review API changes', codename: 'Review', spawned_by: 20, status: 'needs-input',
  delegation: { parent: 20, role: 'reviewer', state: 'working', stalled: true, result_staged: true, superseded: 2, ended_at: NOW - 5 * 60_000, stop_reason: 'quiet-settle', turn_end_source: 'quiet-settle', inbox_owed: 1, inbox_provisional: 1, last_result_corrected_by: null, capability_note: 'no hook signal', hold_reason: 'parent is busy', reusable: false, started_at: NOW - 9 * 60_000 } as SessionInfo['delegation']
})
const PARENT = pane(20, { title: 'Orchestrator', codename: 'Orchestrator', live_children: 3, children_waiting: 1 })
const CREW = [
  CHILD,
  pane(22, { title: 'Write regression tests', codename: 'Tests', spawned_by: 20, delegation: { parent: 20, role: 'tests', state: 'working', stalled: false, result_staged: false, superseded: 0, turn_end_source: 'hook', inbox_owed: 0, inbox_provisional: 0, reusable: false, started_at: NOW } as unknown as SessionInfo['delegation'] }),
  pane(23, { title: 'Docs', codename: 'Docs', spawned_by: 20, status: 'idle' })
]

function Anchored({ left, top = 20, kind, info }: { left: number; top?: number; kind: 'origin' | 'orchestrator'; info: SessionInfo }): React.JSX.Element {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  return (
    <>
      <button ref={anchorRef} style={{ position: 'absolute', top, left, width: 80, height: 24 }}>anchor</button>
      <DelegationPanel
        cardRef={cardRef} id={`orchestration-${kind}-${info.id}`} label="Delegation" anchorRef={anchorRef} kind={kind} info={info}
        roster={{ sessions: new Map([PARENT, ...CREW].map((s) => [s.id, s])), maxLiveChildren: 3 }}
        onFocusPane={noop} onDeliverNow={noop} onClose={noop} onPointerEnter={noop} onPointerLeave={noop}
      />
    </>
  )
}

function settled(id: number, state: 'failed' | 'done' | 'unknown'): SessionInfo {
  return pane(id, {
    title: `Child ${id}`, codename: `C${id}`, spawned_by: 20, state: 'exited', status: 'idle',
    delegation: { parent: 20, role: 'worker', state, stalled: false, result_staged: false, superseded: 0, turn_end_source: 'stop-hook', inbox_owed: 0, inbox_provisional: 0, last_result_corrected_by: 31, reusable: false, started_at: NOW, ended_at: NOW + 60_000 } as SessionInfo['delegation']
  })
}

export function DelegationPanelsStory(): React.JSX.Element {
  return (
    <div className="orchestration-static" style={{ position: 'relative', height: '100%', background: 'var(--content-bg)' }}>
      {STATIC_MOTION}
      <Anchored left={20} kind="origin" info={CHILD} />
      <Anchored left={420} kind="orchestrator" info={PARENT} />
      <Anchored left={820} kind="origin" info={CREW[1]} />
      <Anchored left={20} top={500} kind="origin" info={settled(41, 'failed')} />
      <Anchored left={420} top={500} kind="origin" info={settled(42, 'done')} />
      <Anchored left={820} top={500} kind="origin" info={settled(43, 'unknown')} />
    </div>
  )
}

function visibleClient(results: DelegationResult[] = []): HoustonClient {
  const handlers = new Map<string, Set<(message: ServerMsg) => void>>()
  const emit = (message: ServerMsg): void => queueMicrotask(() => {
    for (const handler of handlers.get(message.type) ?? []) handler(message)
  })
  const items = [
    { id: 'queued-1', state: 'queued' as const, mode: 'queue' as const, request_id: null, preview: 'Run the remaining tests.', created_at: NOW, updated_at: NOW, hold_reason: null },
    { id: 'held-2', state: 'held_after_recovery' as const, mode: 'queue' as const, request_id: null, preview: 'Review the schema change.', created_at: NOW + 1, updated_at: NOW + 2, hold_reason: 'Daemon restarted before delivery; explicit resume required' },
    { id: 'uncertain-3', state: 'uncertain' as const, mode: 'steer' as const, request_id: 3, preview: 'Check the migration before continuing.', created_at: NOW + 3, updated_at: NOW + 4, hold_reason: 'Delivery unknown; inspect before sending a new instruction' }
  ]
  return {
    subscribe: (kind: string, handler: (message: ServerMsg) => void) => {
      const group = handlers.get(kind) ?? new Set()
      group.add(handler)
      handlers.set(kind, group)
      return () => group.delete(handler)
    },
    delegationResultsList: (parent: number) => emit({ type: 'delegation_results', parent, results, truncated: false, before_message_id: null, next_message_id: null }),
    delegationResultGet: (parent: number, message_id: number) => emit({ type: 'delegation_result_detail', parent, row: { id: BigInt(message_id), to_session: parent, workspace: WS, from_session: 21, kind: 'result', urgent: false, summary: 'Validation complete', body: 'All targeted checks passed.\n\nThe full result remains available after the child closes.\nThe archived preview is separate from this full body.', artifacts: [WS + '/report.txt'], superseded: 0, provisional: false, attempts: 0, created_at: BigInt(NOW) } }),
    instructionQueueList: (session: number) => emit({ type: 'instruction_queue', snapshot: { session, queued_count: 1, held_count: 1, uncertain_count: 1, hold_reason: 'Recovery requires deliberate resume', items, truncated: false } }),
    instructionGet: (session: number, instruction_id: string) => {
      const instruction = items.find((item) => item.id === instruction_id)
      if (instruction) emit({ type: 'instruction_detail', detail: { session, instruction, body: instruction.preview + '\nInspect the current state before sending another instruction.' } })
    },
    instructionCancel: (session: number, instruction_id: string) => emit({ type: 'instruction_refused', session, instruction_id, message: 'Writer is active; try again when delivery settles.' }),
    instructionResume: (session: number, instruction_id: string) => emit({ type: 'instruction_refused', session, instruction_id, message: 'Inspect the current conversation before resuming.' }),
    inboxList: noop, gitStatus: noop, closeSession: noop
  } as unknown as HoustonClient
}

export function ParentFirstAttentionStory(): React.JSX.Element {
  const client = useMemo(() => visibleClient(), [])
  const children = [
    pane(21, { spawned_by: 20, title: 'Choose the target branch', status: 'needs-input' }),
    pane(22, { spawned_by: 20, title: 'Waiting for permission', status: 'needs-input', delegation: { ...CREW[1].delegation!, state: 'asked_orchestrator', input_request: withPermissionOwner(CREW[1], 'orchestrator').delegation!.input_request } }),
    pane(23, { spawned_by: 20, title: 'Confirm deployment access', status: 'needs-input', delegation: { ...CREW[1].delegation!, state: 'needs_input', input_request: withPermissionOwner(CREW[1], 'user').delegation!.input_request } })
  ]
  return <div className="orchestration-static" style={{ height: '100%', maxWidth: 900, margin: 'auto', overflow: 'auto', background: 'var(--content-bg)' }}>{STATIC_MOTION}<OverviewTab parentId={20} sessions={new Map([[20, { ...PARENT, children_waiting: 1 }], ...children.map((child): [number, SessionInfo] => [child.id, child])])} client={client} onClose={noop} onReview={noop} /></div>
}

export function ArchivedResultsStory(): React.JSX.Element {
  const client = useMemo(() => visibleClient([
    { message_id: 300, child: 21, role: 'validator', from_codename: 'reviewer', request_id: 1, summary: 'Validation complete', excerpt: 'All targeted checks passed.', created_at: NOW, ready_at: NOW + 1, provisional: false, reason: null, delivered_via: 'wait' },
    { message_id: 299, child: 22, role: 'scout', request_id: 2, summary: 'Partial findings', excerpt: 'The migration needs one more check.', created_at: NOW - 1000, ready_at: NOW, provisional: true, reason: 'Interrupted before final handback', delivered_via: null }
  ]), [])
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const timer = window.setTimeout(() => [...host.current?.querySelectorAll('button') ?? []].find((button) => button.textContent === 'View result')?.click(), 100)
    return () => window.clearTimeout(timer)
  }, [])
  return <div ref={host} className="orchestration-static" style={{ height: '100%', maxWidth: 900, margin: 'auto', overflow: 'auto', background: 'var(--content-bg)' }}>{STATIC_MOTION}<OverviewTab parentId={20} sessions={new Map([[20, { ...PARENT, live_children: 0, children_waiting: 0 }]])} client={client} onClose={noop} onReview={noop} /></div>
}

export function InstructionRecoveryStory(): React.JSX.Element {
  const client = useMemo(() => visibleClient(), [])
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => { const details = host.current?.querySelector('details'); if (details) details.open = true }, [])
  return <div ref={host} className="orchestration-static" style={{ height: '100%', maxWidth: 900, margin: 'auto', padding: 20, overflow: 'auto', background: 'var(--content-bg)' }}>{STATIC_MOTION}<InstructionQueue sessionId={21} client={client} onOpenPane={noop} /></div>
}

export function PermissionOwnershipStory(): React.JSX.Element {
  const pending = withPermissionOwner(pane(21, { spawned_by: 20, title: 'Verify the API endpoint' }), 'orchestrator')
  const escalated = withPermissionOwner(pending, 'user')
  return <div className="orchestration-static" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, padding: 24, alignItems: 'start', background: 'var(--content-bg)' }}>
    {STATIC_MOTION}
    <section aria-label="Permission pending with orchestrator"><ParentOwnedInput info={pending} /><ChildInputDetails info={pending} /><ChildInputBanner info={pending} /></section>
    <section aria-label="Permission escalated to operator"><ChildInputBanner info={escalated} /></section>
  </div>
}
