import React from 'react'
import type { HoustonClient, ServerMsg, SessionInfo } from '../src/houston/client'
import { SessionPane } from '../src/components/SessionPane'
import { DefaultViewSetting } from '../src/components/settings/DefaultViewSetting'
import type { ThreadEvent, ThreadEventKind } from '../src/thread/threadTypes'

const noop = (): void => {}

/** A client that answers `thread_history` from fixture events and ignores every other message. */
function fixtureClient(events: ThreadEvent[], hasMore = false): HoustonClient {
  const listeners = new Set<(msg: ServerMsg) => void>()
  const target = {
    subscribe: (kind: string, handler: (msg: ServerMsg) => void) => {
      const listener = (msg: ServerMsg): void => { if (msg.type === kind) handler(msg) }
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    sessionCwd: () => Promise.resolve('/home/dev/code/houston'),
    trySend: (msg: { type: string; session?: number; before_seq?: number | null }) => {
      if (msg.type !== 'thread_history') return true
      const page = msg.before_seq == null ? events : []
      const reply = { type: 'thread_history', session: msg.session, before_seq: msg.before_seq ?? null, events: page, has_more: msg.before_seq == null && hasMore }
      queueMicrotask(() => { for (const listener of listeners) listener(reply as unknown as ServerMsg) })
      return true
    }
  }
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop in obj) return Reflect.get(obj, prop, receiver)
      if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined
      return noop
    }
  }) as unknown as HoustonClient
}

function timeline(kinds: ThreadEventKind[]): ThreadEvent[] {
  const start = Date.UTC(2026, 9, 24, 9, 0, 0)
  return kinds.map((kind, i) => ({ seq: i + 1, at_ms: start + i * 1500, kind }))
}

const user = (text: string): ThreadEventKind => ({ type: 'user_message', text })
const said = (id: string, text: string): ThreadEventKind => ({ type: 'assistant_message', message_id: id, text, truncated: false })
const delta = (id: string, text: string): ThreadEventKind => ({ type: 'assistant_delta', message_id: id, text })
const call = (id: string, name: string, input: object): ThreadEventKind => ({ type: 'tool_call', tool_use_id: id, name, input: JSON.stringify(input), truncated: false })
const result = (id: string, output: string, isError = false): ThreadEventKind => ({ type: 'tool_result', tool_use_id: id, is_error: isError, output, truncated: false })
const done: ThreadEventKind = { type: 'turn_end', outcome: 'completed', error: null }

const HISTORY: ThreadEventKind[] = [
  { type: 'notice', text: 'Earlier messages were removed: a thread keeps at most 20,000 events.' },
  user('Why does the rail flicker when a pane finishes?'),
  call('t1', 'Grep', { pattern: 'finishedUnseen', path: 'ui/src/renderer/src' }),
  result('t1', 'ui/src/renderer/src/finishedUnseen.ts\nui/src/renderer/src/App.tsx'),
  call('t2', 'Read', { file_path: 'ui/src/renderer/src/finishedUnseen.ts' }),
  result('t2', 'export function finishedUnseen(…) { … }'),
  said('m1', 'The rail re-sorts on every **status** change, so a pane that finishes moves before the unseen mark settles.\n\n- `finishedUnseen` recomputes per render\n- the sort key includes `status_since_ms`\n\nA stable sort key removes the jump:\n\n```ts\nconst key = (s: SessionInfo) => s.id\n```'),
  done,
  user('Make the sort stable and run the tests.'),
  call('t3', 'Edit', { file_path: 'ui/src/renderer/src/railView.ts', old_string: 'const order = sessions\n  .sort(byStatus)\n  .map(toRow)', new_string: 'const order = sessions\n  .sort(byId)\n  .map(toRow)', replace_all: false }),
  result('t3', 'The file ui/src/renderer/src/railView.ts has been updated successfully.'),
  call('t4', 'Bash', { command: 'bun run test railView', description: 'Run the rail view tests' }),
  result('t4', ' ✓ railView.test.ts (12 tests) 41ms\n\n Test Files  1 passed (1)\n      Tests  12 passed (12)'),
  said('m2', 'Done: the rail now sorts by pane id, and the 12 rail view tests pass.'),
  done
]

function threadInfo(over: Partial<SessionInfo>): SessionInfo {
  return {
    id: 701,
    agent: 'claude',
    state: 'running',
    status: 'idle',
    title: 'Rail flicker',
    title_source: 'prompt',
    codename: 'Wren',
    project_dir: '/home/dev/code/houston',
    cwd: '/home/dev/code/houston',
    hidden: false,
    live_children: 0,
    children_waiting: 0,
    inbox_unread: 0,
    tags: [],
    view: 'thread',
    ...over
  } as unknown as SessionInfo
}

function ThreadFrame({ events, info, hasMore, expandTools = 0, openTurns = false, menu = false }: { events: ThreadEventKind[]; info: SessionInfo; hasMore?: boolean; expandTools?: number; openTurns?: boolean; menu?: boolean }): React.JSX.Element {
  const client = React.useMemo(() => fixtureClient(timeline(events), hasMore), [events, hasMore])
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (expandTools === 0 && !openTurns) return
    const timer = window.setInterval(() => {
      const folded = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[data-thread-item="turn"] > button[aria-expanded="false"]') ?? [])
      if (openTurns && folded.length > 0) {
        folded.forEach((button) => button.click())
        return
      }
      const headers = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[data-thread-item="tool"] > button') ?? [])
      if (headers.length === 0) return
      if (expandTools > 0) headers.slice(-expandTools).forEach((button) => button.click())
      window.clearInterval(timer)
    }, 20)
    return () => window.clearInterval(timer)
  }, [expandTools, openTurns])
  React.useEffect(() => {
    if (!menu) return
    const timer = window.setTimeout(() => {
      const pane = ref.current?.querySelector('.pane')
      const box = pane?.getBoundingClientRect()
      pane?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: (box?.left ?? 0) + 40, clientY: (box?.top ?? 0) + 60 }))
    }, 60)
    return () => window.clearTimeout(timer)
  }, [menu])
  return (
    <div ref={ref} style={{ height: '100%', width: '100%', display: 'flex', minHeight: 0 }}>
      <SessionPane
        info={info} client={client} theme="black" active connected fontSize={14} copyOnSelect={false}
        stripBoxGlyphs={false} showProject shellIntegration={false}
        registerOutput={() => noop}
        onReconnectSsh={noop} onActivate={noop} onExpand={noop} onZoom={noop} onShellZoom={noop} onSplit={noop}
        onAddPane={noop} onHeaderPointerDown={noop} onHandoff={noop} onOpenFile={noop} onOpenDir={noop}
      />
    </div>
  )
}

export function ThreadIdleStory(): React.JSX.Element {
  return <div style={{ height: '100%', padding: 12, display: 'flex' }}><ThreadFrame events={HISTORY} info={threadInfo({})} hasMore /></div>
}

const STREAMING: ThreadEventKind[] = [
  ...HISTORY.slice(1, 8),
  user('Could the same jump happen in the stack tabs?'),
  delta('m9', 'Yes. The stack tabs reuse the same sort, so a finishing pane '),
  delta('m9', 'also moves there. Two places need the stable key:\n\n1. `railView.ts`\n2. `StackTabs.tsx`')
]

export function ThreadStreamingStory(): React.JSX.Element {
  return <div style={{ height: '100%', padding: 12, display: 'flex' }}><ThreadFrame events={STREAMING} info={threadInfo({ status: 'working', title: 'Stack tab order' })} /></div>
}

const STOPPED: ThreadEventKind[] = [
  user('Rewrite the release notes generator in Rust.'),
  call('s1', 'Read', { file_path: 'scripts/release-notes.mjs' }),
  delta('s2', 'I will port `release-notes.mjs` to a small Rust binary. First the section parser'),
  { type: 'turn_end', outcome: 'interrupted', error: null },
  user('Never mind, keep the script.'),
  said('s3', 'Understood, the script stays as it is.'),
  done
]

export function ThreadStoppedStory(): React.JSX.Element {
  return <div style={{ height: '100%', padding: 12, display: 'flex' }}><ThreadFrame events={STOPPED} info={threadInfo({ title: 'Release notes port' })} /></div>
}

const TOOL_HEAVY: ThreadEventKind[] = [
  user('Add a notes file, then change its first line.'),
  call('w1', 'Write', { file_path: 'notes.txt', content: 'alpha\nbravo\ncharlie\n' }),
  result('w1', 'File created successfully at: notes.txt'),
  call('e1', 'MultiEdit', { file_path: 'notes.txt', edits: [{ old_string: 'alpha', new_string: 'beta' }, { old_string: 'charlie', new_string: 'delta' }] }),
  result('e1', 'Applied 2 edits to notes.txt'),
  call('b1', 'Bash', { command: 'cat notes.txt && false', description: 'Print the notes and fail' }),
  result('b1', 'beta\nbravo\ndelta\nExit code 1', true),
  call('g1', 'WebFetch', { url: 'https://example.com/changelog', prompt: 'Summarise the latest entry' }),
  result('g1', 'The latest entry adds thread panes.'),
  said('w2', 'Created `notes.txt`, changed two lines, and the final command failed on purpose.'),
  done
]

export function ThreadToolsStory(): React.JSX.Element {
  return <div style={{ height: '100%', padding: 12, display: 'flex' }}><ThreadFrame events={TOOL_HEAVY} info={threadInfo({ title: 'Notes file' })} expandTools={3} openTurns /></div>
}

const thought = (id: string, ms: number, tokens: number): ThreadEventKind => ({ type: 'reasoning', message_id: id, text: '', truncated: false, duration_ms: ms, estimated_tokens: tokens, redacted: false })
const edit = (id: string, path: string, added: number, removed: number): ThreadEventKind => ({ type: 'tool_call', tool_use_id: id, name: 'Edit', input: JSON.stringify({ file_path: path }), truncated: true, summary: { kind: 'edit', target: path, added, removed } })

const WORK_LOG: ThreadEventKind[] = [
  user('The rail and the stack tabs both jump when a pane finishes. Make both sorts stable.'),
  thought('k1', 6000, 812),
  call('g1', 'Grep', { pattern: 'byStatus', path: '/home/dev/code/houston/ui/src/renderer/src' }),
  result('g1', 'railView.ts\nStackTabs.tsx'),
  call('r1', 'Read', { file_path: '/home/dev/code/houston/ui/src/renderer/src/railView.ts' }),
  result('r1', 'export const order = …'),
  call('r2', 'Read', { file_path: '/home/dev/code/houston/ui/src/renderer/src/components/StackTabs.tsx' }),
  result('r2', 'export function StackTabs(…) { … }'),
  edit('e1', '/home/dev/code/houston/ui/src/renderer/src/railView.ts', 4, 2),
  result('e1', 'The file has been updated successfully.'),
  edit('e2', '/home/dev/code/houston/ui/src/renderer/src/components/StackTabs.tsx', 3, 3),
  result('e2', 'The file has been updated successfully.'),
  call('b1', 'Bash', { command: 'bun run typecheck', description: 'Typecheck the renderer' }),
  result('b1', 'src/components/StackTabs.tsx(41,7): error TS2304: Cannot find name byId.', true),
  edit('e3', '/home/dev/code/houston/ui/src/renderer/src/components/StackTabs.tsx', 1, 0),
  result('e3', 'The file has been updated successfully.'),
  call('b2', 'Bash', { command: 'bun run test railView StackTabs', description: 'Run the affected tests' }),
  result('b2', ' Test Files  2 passed (2)\n      Tests  19 passed (19)'),
  said('w1', 'Both sorts now use the pane id, so a finishing pane stays in place. The typecheck caught a missing import, which I added; the 19 affected tests pass.'),
  done,
  user('Does the overview grid sort the same way?'),
  { type: 'reasoning_delta', message_id: 'k2', text: '', estimated_tokens: 50 },
  call('r3', 'Read', { file_path: '/home/dev/code/houston/ui/src/renderer/src/components/Overview.tsx' })
]

/** A settled tool-heavy turn folded into its summary, then a live turn still thinking. */
export function ThreadWorkLogStory(): React.JSX.Element {
  return <div style={{ height: '100%', padding: 12, display: 'flex' }}><ThreadFrame events={WORK_LOG} info={threadInfo({ status: 'working', title: 'Stable sort' })} /></div>
}

/** The same thread with the settled turn opened. */
export function ThreadWorkLogOpenStory(): React.JSX.Element {
  return <div style={{ height: '100%', padding: 12, display: 'flex' }}><ThreadFrame events={WORK_LOG} info={threadInfo({ status: 'working', title: 'Stable sort' })} openTurns /></div>
}

const APPROVALS: ThreadEventKind[] = [
  user('Clean the build output and regenerate the protocol types.'),
  call('a1', 'Write', { file_path: 'notes.txt', content: 'draft' }),
  { type: 'approval_request', request_id: 'r1', tool_use_id: 'a1', tool_name: 'Write', input: JSON.stringify({ file_path: 'notes.txt', content: 'draft' }), truncated: false, input_bytes: 16 },
  { type: 'approval_resolved', request_id: 'r1', decision: 'denied', reason: 'Not that file.' },
  result('a1', 'Not that file.', true),
  call('a2', 'Bash', { command: 'rm -rf ui/out && bash scripts/gen-protocol-types.sh', description: 'Remove the build output and regenerate types' }),
  { type: 'approval_request', request_id: 'r2', tool_use_id: 'a2', tool_name: 'Bash', input: JSON.stringify({ command: 'rm -rf ui/out && bash scripts/gen-protocol-types.sh', description: 'Remove the build output and regenerate types' }), truncated: false, input_bytes: 16 }
]

export function ThreadApprovalStory(): React.JSX.Element {
  return <div style={{ height: '100%', padding: 12, display: 'flex' }}><ThreadFrame events={APPROVALS} info={threadInfo({ status: 'needs-input', title: 'Build cleanup', permission_mode: 'default' })} /></div>
}

/** One long thread, for measuring the rendered DOM against the row window. */
export function ThreadLongStory(): React.JSX.Element {
  const events = React.useMemo(() => Array.from({ length: 1000 }, (_, i) => i % 2 === 0 ? user(`Question ${i / 2 + 1}`) : said(`l${i}`, `Answer ${(i + 1) / 2} with **some** Markdown.`)), [])
  return <div style={{ height: '100%', padding: 12, display: 'flex' }}><ThreadFrame events={events} info={threadInfo({ title: 'Long thread' })} /></div>
}

export function ThreadStatesStory(): React.JSX.Element {
  return (
    <div style={{ height: '100%', padding: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', gap: 8 }}>
      <ThreadFrame events={HISTORY} info={threadInfo({})} hasMore />
      <ThreadFrame events={STREAMING} info={threadInfo({ id: 702, status: 'working', title: 'Stack tab order' })} />
      <ThreadFrame events={STOPPED} info={threadInfo({ id: 703, title: 'Release notes port' })} />
      <ThreadFrame events={TOOL_HEAVY} info={threadInfo({ id: 704, title: 'Notes file' })} expandTools={3} />
    </div>
  )
}

/** The pane menu of an idle Claude terminal and of a thread: each offers the other view. */
export function ViewSwitchMenuStory(): React.JSX.Element {
  return (
    <div style={{ height: '100%', padding: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
      <ThreadFrame events={[]} info={threadInfo({ id: 711, view: 'terminal', title: 'Terminal Claude' } as Partial<SessionInfo>)} menu />
      <ThreadFrame events={HISTORY} info={threadInfo({ id: 712, title: 'Rail flicker' })} menu />
    </div>
  )
}

/** A busy session's switch is disabled and names the status. */
export function ViewSwitchBusyStory(): React.JSX.Element {
  return <div style={{ height: '100%', padding: 12, display: 'flex' }}><ThreadFrame events={STREAMING} info={threadInfo({ id: 713, status: 'working', title: 'Stack tab order' })} menu /></div>
}

/** Settings ▸ Agents ▸ CLIs ▸ Default view, answered by a client that holds Terminal. */
export function DefaultViewSettingStory(): React.JSX.Element {
  const client = React.useMemo(() => {
    let listener: ((msg: ServerMsg) => void) | null = null
    return {
      subscribe: (_kind: string, handler: (msg: ServerMsg) => void) => { listener = handler; return noop },
      send: (msg: { type: string; view?: string }) => {
        const view = msg.type === 'default_view_set' ? msg.view : 'terminal'
        queueMicrotask(() => listener?.({ type: 'default_view', view } as ServerMsg))
      }
    } as unknown as HoustonClient
  }, [])
  return <div style={{ maxWidth: 720, padding: 24 }}><DefaultViewSetting client={client} /></div>
}
