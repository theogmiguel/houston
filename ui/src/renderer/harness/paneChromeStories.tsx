import React from 'react'
import type { HoustonClient, SessionInfo } from '../src/houston/client'
import type { TagInfo } from '../src/houston/generated/TagInfo'
import { SessionPane } from '../src/components/SessionPane'
import { StackTabs } from '../src/components/StackTabs'
import { TagManager } from '../src/components/TagManager'
import { TagEditor } from '../src/components/tagEditing'
import { TagChipRow } from '../src/components/tags'
import { SurfaceBoundary } from '../src/components/SurfaceBoundary'
import { PrefixHint } from '../src/components/PrefixHint'
import { TerminalPane, type TermActions } from '../src/pane/TerminalPane'
import { TagsContext } from '../src/layout/tagsContext'
import { prefixLayer } from '../src/prefixLayer'
import { leaf, stackPane } from '../src/layout/tree'
import { createSessionsStore, SessionsStoreContext } from '../src/sessionsStore'

const noop = (): void => {}
const settleTagEditorSelection = (): void => {
  const inputs = document.querySelectorAll<HTMLInputElement>('[data-testid="tag-editor"] input')
  const input = inputs[inputs.length - 1]
  if (!input) return
  if (document.documentElement.dataset.theme === 'paper') input.select()
  else input.setSelectionRange(0, 0)
}

const TAGS: TagInfo[] = [
  { id: 1, name: 'Bug', color: '#f472b6' },
  { id: 2, name: 'Review', color: '#f59e0b' },
  { id: 3, name: 'Docs', color: '#7cb7ff' }
]

function proxyClient(): HoustonClient {
  return new Proxy({ subscribe: () => noop, sessionCwd: () => Promise.resolve('/home/dev/code/houston') }, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver)
      if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined
      return noop
    }
  }) as unknown as HoustonClient
}

function mkInfo(over: Partial<SessionInfo>): SessionInfo {
  return {
    id: 501,
    agent: 'claude',
    state: 'running',
    status: 'working',
    title: 'Chrome states',
    codename: 'Chrome',
    project_dir: '/home/dev/code/houston',
    cwd: '/home/dev/code/houston',
    hidden: false,
    live_children: 0,
    children_waiting: 0,
    inbox_unread: 0,
    tags: [1, 2],
    ...over
  } as unknown as SessionInfo
}

function PaneFor({ info, branch, menu }: { info: SessionInfo; branch?: string; menu?: boolean }): React.JSX.Element {
  const client = React.useMemo(proxyClient, [])
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (!menu) return
    const target = ref.current?.querySelector('[data-testid="term-surface"], .pane')
    target?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 420, clientY: 140 }))
  }, [menu])
  return (
    <div ref={ref} style={{ height: '100%', width: '100%', display: 'flex' }}>
      <SessionPane
        info={info} client={client} theme="black" active connected fontSize={14} copyOnSelect={false}
        stripBoxGlyphs={false} showProject branch={branch} shellIntegration={false}
        registerOutput={() => noop}
        onReconnectSsh={noop} onActivate={noop} onExpand={noop} onZoom={noop} onShellZoom={noop} onSplit={noop}
        onAddPane={noop} onHeaderPointerDown={noop} onHandoff={noop} onOpenFile={noop} onOpenDir={noop} onSwapAdjacent={noop}
      />
    </div>
  )
}

export function PaneMenuStory(): React.JSX.Element {
  return (
    <TagsContext.Provider value={TAGS}>
      <div style={{ height: '100%', padding: 12, display: 'flex' }}>
        <PaneFor info={mkInfo({ acp: 'zcode', profile_label: 'work' } as Partial<SessionInfo>)} branch="ui/p5-b5a" menu />
      </div>
    </TagsContext.Provider>
  )
}

const ENDED = mkInfo({ state: 'exited', status: 'idle', resumable: true, resume_notice: 'No conversation to resume, so this pane started fresh.', tags: [1, 2, 3] } as Partial<SessionInfo>)

export function PaneEndedStory(): React.JSX.Element {
  const sessions = new Map([
    [501, ENDED],
    [502, mkInfo({ id: 502, title: 'Second tab', status: 'working' })],
    [503, mkInfo({ id: 503, title: 'Third tab', status: 'idle' })]
  ])
  const store = React.useMemo(() => createSessionsStore(sessions), [])
  const stack = stackPane([leaf(501), leaf(502), leaf(503)])
  return (
    <>
    <style>{'.loop-anim{animation:none!important}'}</style>
    <TagsContext.Provider value={TAGS}>
      <SessionsStoreContext.Provider value={store}>
        <div style={{ height: '100%', padding: 12, display: 'flex', flexDirection: 'column', gap: 12, background: 'var(--content-bg)' }}>
          <div style={{ width: 520 }}>
            <StackTabs stack={stack} displayedIndex={1} sessions={sessions} onSelect={noop} onUnstack={noop} />
          </div>
          <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
            <PaneFor info={ENDED} branch="main" />
          </div>
        </div>
      </SessionsStoreContext.Provider>
    </TagsContext.Provider>
    </>
  )
}

export function PaneSleepingStory(): React.JSX.Element {
  const sleeping = mkInfo({
    state: 'sleeping', status: 'idle', resumable: true, tags: [1, 3],
    latest_prompt: 'Trace the daemon recovery path and preserve the last user request.',
    last_agent_message: 'The session has been saved and is waiting for an explicit wake.',
    slept_at_ms: Date.now() - 25 * 60_000,
    sleep_notice: 'A deferred child remains visible in the recovery notice.'
  })
  const sessions = new Map([[sleeping.id, sleeping]])
  const store = React.useMemo(() => createSessionsStore(sessions), [])
  return <TagsContext.Provider value={TAGS}><SessionsStoreContext.Provider value={store}><div style={{ height: '100%', padding: 12, display: 'flex', background: 'var(--content-bg)' }}><PaneFor info={sleeping} branch="feature/session-recovery" /></div></SessionsStoreContext.Provider></TagsContext.Provider>
}

export function PaneRecoveryDeferredStory(): React.JSX.Element {
  const shell = mkInfo({ agent: 'shell', state: 'running', restore_deferred: 'spawn-failed' })
  const sessions = new Map([[shell.id, shell]])
  const store = React.useMemo(() => createSessionsStore(sessions), [])
  return <TagsContext.Provider value={TAGS}><SessionsStoreContext.Provider value={store}><div style={{ height: '100%', padding: 12, display: 'flex', background: 'var(--content-bg)' }}><PaneFor info={shell} branch="feature/session-recovery" /></div></SessionsStoreContext.Provider></TagsContext.Provider>
}

export function PaneTerminalStatesStory(): React.JSX.Element {
  const actions = React.useRef<TermActions | null>(null)
  const client = React.useMemo(proxyClient, [])
  React.useEffect(() => {
    const interval = window.setInterval(() => {
      const actionsReady = actions.current
      const host = document.querySelector('.term-host')
      if (!actionsReady || !host) return
      actionsReady.find()
      const dataTransfer = new DataTransfer()
      dataTransfer.items.add(new File(['specimen'], 'specimen.txt', { type: 'text/plain' }))
      host.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer }))
      window.clearInterval(interval)
    }, 20)
    const timeout = window.setTimeout(() => window.clearInterval(interval), 3000)
    return () => { window.clearInterval(interval); window.clearTimeout(timeout) }
  }, [])
  return (
    <div style={{ height: '100%', padding: 12, display: 'flex', flexDirection: 'column' }}>
      <style>{'.loop-anim{animation:none!important}'}</style>
      <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <TerminalPane
          client={client} info={mkInfo({ state: 'running' })} theme="black" active connected fontSize={14}
          copyOnSelect={false} stripBoxGlyphs={false} registerOutput={() => noop} onActivate={noop}
          onZoom={noop} onShellZoom={noop} onOpenFile={noop} onOpenDir={noop} actions={actions}
        />
      </div>
    </div>
  )
}

export function TagsFormsStory(): React.JSX.Element {
  const usage = new Map([[1, { panes: 2, grids: 1 }], [2, { panes: 1, grids: 0 }]])
  return <><style>{'[data-tag-new="true"]{animation:none!important}'}</style><TagManager open tags={TAGS} usage={usage} highlight="Docs" onCreate={noop} onUpdate={noop} onDelete={noop} onClose={noop} /></>
}

export function TagEditorStory(): React.JSX.Element {
  React.useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const inputs = document.querySelectorAll<HTMLInputElement>('[data-testid="tag-editor"] input')
      const input = inputs[inputs.length - 1]
      input?.focus()
      settleTagEditorSelection()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [])
  return (
    <div style={{ height: '100%', background: 'var(--content-bg)' }}>
      <TagEditor state={{ x: 120, y: 80, tag: null }} tags={TAGS} onSave={noop} onCancel={noop} />
      <TagEditor state={{ x: 420, y: 80, tag: TAGS[0] }} tags={TAGS} onSave={noop} onCancel={noop} />
      <div style={{ position: 'absolute', left: 120, top: 460, display: 'grid', gap: 12 }}>
        <TagChipRow tags={TAGS} />
        <TagChipRow tags={TAGS} compact />
        <TagChipRow tags={TAGS} onToggle={noop} />
      </div>
    </div>
  )
}

function Thrower(): React.JSX.Element {
  throw new Error('specimen failure')
}

export function PaneMiscStory(): React.JSX.Element {
  React.useEffect(() => {
    prefixLayer.arm()
    return () => prefixLayer.disarm()
  }, [])
  const prev = console.error
  console.error = noop
  React.useEffect(() => () => { console.error = prev })
  return (
    <div style={{ height: '100%', padding: 12, display: 'grid', gap: 12, alignContent: 'start', background: 'var(--content-bg)' }}>
      <div style={{ height: 160, border: '1px solid var(--border)' }}>
        <SurfaceBoundary label="Specimen"><Thrower /></SurfaceBoundary>
      </div>
      <PrefixHint />
    </div>
  )
}
