import React from 'react'
import type { HoustonClient, ServerMsg, SessionInfo } from '../src/houston/client'
import { SessionPane } from '../src/components/SessionPane'
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

function ThreadFrame({ events, info, hasMore, expandTools = 0 }: { events: ThreadEventKind[]; info: SessionInfo; hasMore?: boolean; expandTools?: number }): React.JSX.Element {
  const client = React.useMemo(() => fixtureClient(timeline(events), hasMore), [events, hasMore])
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (expandTools === 0) return
    const timer = window.setInterval(() => {
      const headers = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[data-thread-item="tool"] > button') ?? [])
      if (headers.length === 0) return
      headers.slice(-expandTools).forEach((button) => button.click())
      window.clearInterval(timer)
    }, 20)
    return () => window.clearInterval(timer)
  }, [expandTools])
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
  return <div style={{ height: '100%', padding: 12, display: 'flex' }}><ThreadFrame events={TOOL_HEAVY} info={threadInfo({ title: 'Notes file' })} expandTools={3} /></div>
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
