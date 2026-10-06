import React, { useEffect, useRef } from 'react'
import { HandoffOverlay, type HandoffUiState } from '../src/components/HandoffOverlay'
import { PaneHandoff } from '../src/components/PaneHandoff'
import { QuestionCard } from '../src/components/QuestionCard'
import DelegationPanel from '../src/components/DelegationPanel'
import type { SessionInfo } from '../src/houston/client'

const noop = (): void => {}

const MARKDOWN = '# Goal\nShip the **roster** conversion.\n\n## Done\n- Moved `children-row` rules\n- Kept the hooks\n\n```\nbun run typecheck\n```\n\n### Next\nRun the pixel diff.'
const STATIC_MOTION = <style>{`.b5b-static *, .b5b-static *::before, .b5b-static *::after { animation: none !important; transition: none !important; }`}</style>

function handoffState(over: Partial<HandoffUiState>): HandoffUiState {
  return { request: 1, session: 1, sessionTitle: 'Review API changes', provider: 'Claude Code', phase: 'done', text: '', markdown: MARKDOWN, savedPath: '', error: '', ...over }
}

function Cell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div style={{ position: 'relative', height: 390, border: '1px solid var(--border)' }}>{children}</div>
}

export function B5bHandoffStatesStory(): React.JSX.Element {
  return (
    <div className="b5b-static" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, padding: 8, height: '100%', background: 'var(--content-bg)' }}>
      {STATIC_MOTION}
      <Cell><HandoffOverlay state={handoffState({ phase: 'generating', markdown: '' })} onCancel={noop} onClose={noop} onPaste={noop} /></Cell>
      <Cell><HandoffOverlay state={handoffState({ phase: 'generating', text: MARKDOWN, markdown: '' })} onCancel={noop} onClose={noop} onPaste={noop} /></Cell>
      <Cell><HandoffOverlay state={handoffState({ savedPath: '/work/acme/.houston/handoff.md' })} onCancel={noop} onClose={noop} onPaste={noop} /></Cell>
      <Cell><HandoffOverlay state={handoffState({ phase: 'error', markdown: '', error: 'The provider closed the stream before the packet finished.' })} onCancel={noop} onClose={noop} onPaste={noop} /></Cell>
    </div>
  )
}

export function B5bPaneHandoffSelectedStory(): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('[data-agent="codex"]')?.click()
  }, [])
  return (
    <div ref={ref} className="b5b-static">
      {STATIC_MOTION}
      <PaneHandoff source={{ session: 1, agent: 'claude', title: 'Review API changes', cwd: '/home/dev/acme', conversation: 'We have finished the API review.' }} onCancel={noop} onHandoff={noop} />
    </div>
  )
}

const OPTIONS = [{ id: 'tests', label: 'Add regression tests' }, { id: 'docs', label: 'Update the docs' }, { id: 'perf', label: 'Measure the render path before changing it so the numbers settle the argument' }]

export function B5bQuestionStatesStory(): React.JSX.Element {
  const common = { questionIndex: 1, questionCount: 3, question: 'Which change should land first?', onSkip: noop }
  return (
    <div className="b5b-static" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, padding: 12, alignItems: 'start', background: 'var(--content-bg)' }}>
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
        cardRef={cardRef} id={`b5b-${kind}-${info.id}`} label="Delegation" anchorRef={anchorRef} kind={kind} info={info}
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

export function B5bDelegationPanelsStory(): React.JSX.Element {
  return (
    <div className="b5b-static" style={{ position: 'relative', height: '100%', background: 'var(--content-bg)' }}>
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
