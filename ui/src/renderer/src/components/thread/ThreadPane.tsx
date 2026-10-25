import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { HoustonClient, SessionInfo } from '../../houston/client'
import { loadMarkdownPipeline } from '../MarkdownPreview'
import { IconArrowUp, IconClock, IconStopCircle, IconZap } from '../icons'
import { Button } from '../ui/Button'
import { Notice } from '../ui/Notice'
import { Tooltip } from '../ui/Tooltip'
import { Select } from '../ui/Select'
import { Text } from '../ui/Text'
import {
  ThreadAssistantBlock,
  ThreadCaption,
  ThreadComposerActions,
  ThreadComposerFrame,
  ThreadComposerInput,
  ThreadEmpty,
  ThreadHeaderBar,
  ThreadHistoryControl,
  ThreadNotice,
  ThreadPlainText,
  ThreadQueuedMessageRow,
  ThreadQueuedText,
  ThreadQueueStrip,
  ThreadScroll,
  ThreadStoppedMarker,
  ThreadSurface,
  ThreadUserMessage
} from '../ui/Thread'
import { ThreadApprovalRow, ThreadToolRow } from './ThreadToolCard'
import { THREAD_USER_MESSAGE_MAX_BYTES } from '../../houston/generated/DEFAULTS'
import { LATEST_WINDOW, sameThreadItem, showEarlier, showLater, turnOpen, windowBounds, type ThreadItem, type ThreadWindow } from '../../thread/threadModel'
import { actOnQueue, sendThreadMessage, setThreadPermissionMode, stopThread, useThread, type QueueAction } from '../../thread/threadStore'
import type { ThreadPermissionMode, ThreadQueuedMessage } from '../../thread/threadTypes'

type PipelineModule = Awaited<ReturnType<typeof loadMarkdownPipeline>>

const COMPOSER_MAX_ROWS = 8
const STICK_TO_BOTTOM_PX = 24

function useMarkdownPipeline(): PipelineModule | null {
  const [mod, setMod] = useState<PipelineModule | null>(null)
  useEffect(() => {
    let live = true
    loadMarkdownPipeline().then((m) => { if (live) setMod(m) }, (err: unknown) => console.warn('houston: thread markdown chunk failed to load', err))
    return () => { live = false }
  }, [])
  return mod
}

type AnswerApproval = (requestId: string, allow: boolean) => void

const ThreadRow = memo(function ThreadRow({ item, markdown, answering, connected, onAnswer }: {
  item: ThreadItem
  markdown: PipelineModule | null
  answering: boolean
  connected: boolean
  onAnswer: AnswerApproval
}): React.JSX.Element {
  switch (item.kind) {
    case 'user':
      return <ThreadUserMessage steered={item.steered}>{item.text}</ThreadUserMessage>
    case 'assistant':
      return (
        <ThreadAssistantBlock streaming={item.streaming}>
          {markdown ? <markdown.MarkdownDocument source={item.text} variant="thread" /> : <ThreadPlainText>{item.text}</ThreadPlainText>}
          {item.truncated && <ThreadCaption>Answer cut at 256 KiB by Houston.</ThreadCaption>}
        </ThreadAssistantBlock>
      )
    case 'tool':
      return <ThreadToolRow item={item} />
    case 'notice':
      return <ThreadNotice>{item.text}</ThreadNotice>
    case 'error':
      return <ThreadNotice tone="stop">{item.text}</ThreadNotice>
    case 'stopped':
      return <ThreadStoppedMarker />
    case 'approval':
      return <ThreadApprovalRow item={item} answering={answering} connected={connected} onAnswer={onAnswer} />
  }
}, (a, b) => a.markdown === b.markdown && a.onAnswer === b.onAnswer && a.answering === b.answering && a.connected === b.connected && sameThreadItem(a.item, b.item))

const PERMISSION_MODES: readonly { value: ThreadPermissionMode; label: string }[] = [
  { value: 'default', label: 'Ask before tools' },
  { value: 'accept_edits', label: 'Accept edits' },
  { value: 'plan', label: 'Plan only' },
  { value: 'auto', label: 'Auto' },
  { value: 'bypass', label: 'Bypass permissions' }
]

/** Why the mode cannot change now: whenever Stop is offered, since the change restarts Claude. */
export function permissionModeLockedReason(info: SessionInfo, connected: boolean, events: Parameters<typeof turnOpen>[0]): string | null {
  const unavailable = composerDisabledReason(info, connected)
  if (unavailable !== null) return unavailable
  if (info.status === 'needs-input') return 'Claude is waiting for an answer; change the mode after it'
  if (threadStoppable(info, events)) return `A turn is running (status ${info.status ?? 'unknown'}); change the mode when it ends or after Stop`
  return null
}

function ThreadPermissionControl({ client, info, connected, events }: { client: HoustonClient; info: SessionInfo; connected: boolean; events: Parameters<typeof turnOpen>[0] }): React.JSX.Element {
  const locked = permissionModeLockedReason(info, connected, events)
  return (
    <ThreadHeaderBar>
      <Text as="span" size="small" tone="muted" className="flex-none">Permissions</Text>
      <Tooltip label={locked ?? 'Changing the mode restarts Claude in this conversation'} className="inline-flex">
        <Select
          data-testid="thread-permission-mode"
          aria-label="Permission mode"
          variant="property-chip"
          value={info.permission_mode ?? 'default'}
          options={PERMISSION_MODES}
          disabled={locked !== null}
          onChange={(mode) => setThreadPermissionMode(client, info.id, mode as ThreadPermissionMode)}
        />
      </Tooltip>
    </ThreadHeaderBar>
  )
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length
}

/** Enter that confirms an IME candidate; WebKit reports it after `compositionend` with key code 229. */
export function isImeEnter(event: { key: string; keyCode: number; isComposing: boolean }): boolean {
  return event.isComposing || event.keyCode === 229 || event.key === 'Process'
}

/** Whether Enter, with this modifier state, queues, steers or sends. */
export function composerIntent(stoppable: boolean, ctrlKey: boolean): 'send' | 'queue' | 'steer' {
  if (!stoppable) return 'send'
  return ctrlKey ? 'steer' : 'queue'
}

/** Why a message is too large for Claude, or null; the composer and a queued row's edit field both check it. */
function utf8Refusal(text: string): string | null {
  const size = utf8Length(text)
  return size > THREAD_USER_MESSAGE_MAX_BYTES ? `Message not sent: it is ${size.toLocaleString()} bytes and a thread message is limited to ${THREAD_USER_MESSAGE_MAX_BYTES.toLocaleString()} bytes.` : null
}

/** Enter submits, Shift+Enter and an IME confirmation do not. */
function submitsOnEnter(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
  return e.key === 'Enter' && !e.shiftKey && !isImeEnter({ key: e.key, keyCode: e.nativeEvent.keyCode, isComposing: e.nativeEvent.isComposing })
}

export function ThreadComposer({ stoppable, disabledReason, daemonRefusal, onDismissDaemonRefusal, strip, onSend, onStop }: {
  stoppable: boolean
  disabledReason: string | null
  /** The daemon's last refusal of a message or queue request. */
  daemonRefusal?: string | null
  onDismissDaemonRefusal?: () => void
  /** The queue's summary, shown above the field. */
  strip?: React.ReactNode
  /** Whether the message was written; the text stays in the field when it was not. `steer` stops the open turn. */
  onSend: (text: string, steer: boolean) => boolean
  onStop: () => void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [refusal, setRefusal] = useState<string | null>(null)
  const rows = Math.min(COMPOSER_MAX_ROWS, Math.max(1, text.split('\n').length))
  const send = (steer: boolean): void => {
    if (disabledReason !== null || text.trim() === '') return
    const tooLarge = utf8Refusal(text)
    if (tooLarge !== null) {
      setRefusal(tooLarge)
      return
    }
    if (!onSend(text, steer)) {
      setRefusal('Message not sent: the connection to the daemon is closed. Your text is kept.')
      return
    }
    setRefusal(null)
    setText('')
  }
  const empty = text.trim() === ''
  const blocked = disabledReason !== null
  return (
    <ThreadComposerFrame>
      {refusal && <Notice tone="danger" inset="compact-inline" action={{ label: 'Dismiss', onClick: () => setRefusal(null) }}>{refusal}</Notice>}
      {daemonRefusal && <Notice tone="danger" inset="compact-inline" action={{ label: 'Dismiss', onClick: () => onDismissDaemonRefusal?.() }}>{daemonRefusal}</Notice>}
      {strip}
      <ThreadComposerInput
        data-testid="thread-composer-input"
        aria-label="Message Claude"
        placeholder={disabledReason ?? 'Message Claude'}
        rows={rows}
        value={text}
        disabled={disabledReason !== null}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (!submitsOnEnter(e)) return
          e.preventDefault()
          send(composerIntent(stoppable, e.ctrlKey) === 'steer')
        }}
      />
      <ThreadComposerActions hint={stoppable ? 'Enter queues · Ctrl+Enter steers · Shift+Enter adds a line' : 'Enter sends · Shift+Enter adds a line'}>
        {!stoppable && <Button data-testid="thread-send" variant="primary" size="sm" icon={IconArrowUp} disabled={blocked || empty} onClick={() => send(false)}>Send</Button>}
        {stoppable && empty && <Button data-testid="thread-stop" variant="primary" size="sm" icon={IconStopCircle} disabled={blocked} onClick={onStop}>Stop</Button>}
        {stoppable && !empty && (
          <>
            <Tooltip label="Stop the running turn and send this message first (Ctrl+Enter)">
              <Button data-testid="thread-steer" variant="secondary" size="sm" icon={IconZap} disabled={blocked} onClick={() => send(true)}>Steer</Button>
            </Tooltip>
            <Tooltip label="Send this message when the running turn completes (Enter)">
              <Button data-testid="thread-queue" variant="primary" size="sm" icon={IconClock} disabled={blocked} onClick={() => send(false)}>Queue</Button>
            </Tooltip>
          </>
        )}
      </ThreadComposerActions>
    </ThreadComposerFrame>
  )
}

// A thread without a process stays running and resumes on the next message; any other state refuses input.
export function composerDisabledReason(info: SessionInfo, connected: boolean): string | null {
  if (!connected) return 'Reconnecting to the daemon'
  if (info.state !== 'running') return `This session is ${info.state}; restart it to continue`
  return null
}

const TURN_STATUSES: ReadonlySet<SessionInfo['status']> = new Set(['working', 'spawning', 'needs-input'])

/** Stop is offered while the agent reports a turn in progress or the timeline has one without an end. */
export function threadStoppable(info: SessionInfo, events: Parameters<typeof turnOpen>[0]): boolean {
  return TURN_STATUSES.has(info.status) || turnOpen(events)
}

/** One waiting message under the timeline: its state and text, edited in place. */
function QueuedRow({ message, disabled, editing, onEdit, onAct }: {
  message: ThreadQueuedMessage
  disabled: boolean
  editing: boolean
  onEdit: (editing: boolean) => void
  onAct: (action: QueueAction) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(message.text)
  const [refusal, setRefusal] = useState<string | null>(null)
  const held = message.state === 'held'
  const save = (): void => {
    const tooLarge = utf8Refusal(draft)
    if (tooLarge !== null) return setRefusal(tooLarge)
    if (draft.trim() === '') return setRefusal('A queued message cannot be empty; remove it instead.')
    setRefusal(null)
    if (draft !== message.text) onAct({ type: 'edit', id: message.id, text: draft })
    onEdit(false)
  }
  const actions = editing
    ? <>
        <Button data-testid="thread-queued-cancel" variant="ghost" size="sm" onClick={() => { setDraft(message.text); setRefusal(null); onEdit(false) }}>Cancel</Button>
        <Button data-testid="thread-queued-save" variant="primary" size="sm" disabled={disabled} onClick={save}>Save</Button>
      </>
    : <>
        {held
          ? <Button data-testid="thread-queued-send" variant="ghost" size="sm" disabled={disabled} onClick={() => onAct({ type: 'send', id: message.id })}>Send</Button>
          : <Tooltip label="Stop the running turn and send this message first"><Button data-testid="thread-queued-steer" variant="ghost" size="sm" disabled={disabled} onClick={() => onAct({ type: 'steer', id: message.id })}>Steer now</Button></Tooltip>}
        <Button data-testid="thread-queued-edit" variant="ghost" size="sm" disabled={disabled} onClick={() => { setDraft(message.text); onEdit(true) }}>Edit</Button>
        <Button data-testid="thread-queued-remove" variant="ghost" size="sm" disabled={disabled} onClick={() => onAct({ type: 'remove', id: message.id })}>Remove</Button>
      </>
  return (
    <ThreadQueuedMessageRow state={message.state} reason={held ? message.hold_reason : null} actions={actions}>
      {editing
        ? <>
            {refusal && <Notice tone="danger" inset="compact-inline">{refusal}</Notice>}
            <ThreadComposerInput
              data-testid="thread-queued-input"
              aria-label="Edit queued message"
              rows={Math.min(COMPOSER_MAX_ROWS, Math.max(1, draft.split('\n').length))}
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { e.preventDefault(); setDraft(message.text); onEdit(false); return }
                if (!submitsOnEnter(e)) return
                e.preventDefault()
                save()
              }}
            />
          </>
        : <ThreadQueuedText>{message.text}</ThreadQueuedText>}
    </ThreadQueuedMessageRow>
  )
}

/** The queue strip's summary: held messages first, since nothing sends them but the user. */
export function queueSummary(queue: readonly ThreadQueuedMessage[]): { label: string; held: boolean; detail: string | null; head: ThreadQueuedMessage } | null {
  const head = queue[0]
  if (head === undefined) return null
  const held = queue.filter((message) => message.state === 'held')
  const queued = queue.length - held.length
  const firstHeld = held[0]
  if (firstHeld === undefined) return { label: `Queued ${queued}`, held: false, detail: 'Sent when the running turn completes', head }
  const also = queued > 0 ? ` · ${queued} queued` : ''
  return { label: `Held ${held.length}`, held: true, detail: `${firstHeld.hold_reason ?? 'Waiting for you to send it.'}${also}`, head: firstHeld }
}

function QueueStrip({ queue, disabled, onAct }: { queue: readonly ThreadQueuedMessage[]; disabled: boolean; onAct: (action: QueueAction) => void }): React.JSX.Element | null {
  const summary = queueSummary(queue)
  if (summary === null) return null
  return (
    <ThreadQueueStrip label={summary.label} held={summary.held} detail={summary.detail}>
      {summary.held
        ? <Button data-testid="thread-queue-send-next" variant="ghost" size="sm" disabled={disabled} onClick={() => onAct({ type: 'send', id: summary.head.id })}>Send next</Button>
        : <Tooltip label="Stop the running turn and send the first queued message"><Button data-testid="thread-queue-steer" variant="ghost" size="sm" disabled={disabled} onClick={() => onAct({ type: 'steer', id: summary.head.id })}>Steer</Button></Tooltip>}
      <Button data-testid="thread-queue-clear" variant="ghost" size="sm" disabled={disabled} onClick={() => { for (const message of queue) onAct({ type: 'remove', id: message.id }) }}>Clear</Button>
    </ThreadQueueStrip>
  )
}

/** Keeps the newest row in view while the reader is at the bottom; holds position when they paged back. */
function useStickToBottom(scroll: React.RefObject<HTMLDivElement | null>, deps: readonly unknown[], following: boolean): { onScroll: () => void; holdFromBottom: () => void } {
  const atBottom = useRef(true)
  const fromBottom = useRef<number | null>(null)
  useLayoutEffect(() => {
    const el = scroll.current
    if (!el) return
    if (fromBottom.current !== null) {
      el.scrollTop = el.scrollHeight - fromBottom.current
      fromBottom.current = null
    } else if (atBottom.current && following) {
      el.scrollTop = el.scrollHeight
    }
  }, deps)
  return {
    onScroll: () => {
      const el = scroll.current
      if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_TO_BOTTOM_PX
    },
    holdFromBottom: () => {
      const el = scroll.current
      if (el) fromBottom.current = el.scrollHeight - el.scrollTop
    }
  }
}

export function ThreadPane({ client, info, connected }: { client: HoustonClient; info: SessionInfo; connected: boolean }): React.JSX.Element {
  const thread = useThread(client, info.id, connected)
  const markdown = useMarkdownPipeline()
  const [win, setWin] = useState<ThreadWindow>(LATEST_WINDOW)
  const scroll = useRef<HTMLDivElement>(null)
  const { start, end } = windowBounds(thread.items, win)
  const shown = thread.items.slice(start, end)
  const { onScroll, holdFromBottom } = useStickToBottom(scroll, [thread.items, thread.queue, start, end, markdown], win.end === null)
  const [editing, setEditing] = useState<string | null>(null)
  const queueDisabled = composerDisabledReason(info, connected) !== null
  const act = (action: QueueAction): void => {
    if (!actOnQueue(client, info.id, action)) console.warn('houston: thread queue request dropped: the connection to the daemon is closed')
  }
  const growOnArrival = useRef(false)
  useEffect(() => {
    if (thread.loadingEarlier || !growOnArrival.current) return
    growOnArrival.current = false
    holdFromBottom()
    setWin((current) => showEarlier(thread.items, current))
  }, [thread.loadingEarlier, thread.items, holdFromBottom])
  const earlier = (): void => {
    if (start === 0) {
      growOnArrival.current = true
      thread.loadEarlier()
      return
    }
    holdFromBottom()
    setWin((current) => showEarlier(thread.items, current))
  }
  return (
    <ThreadSurface>
      <ThreadPermissionControl client={client} info={info} connected={connected} events={thread.events} />
      {thread.failure && <Notice tone="danger" inset="compact-inline" className="flex-none" action={{ label: 'Retry', onClick: thread.retry }}>{thread.failure}</Notice>}
      <ThreadScroll ref={scroll} onScroll={onScroll}>
        {(start > 0 || thread.hasMore) && (
          <ThreadHistoryControl>
            <Button data-testid="thread-show-earlier" variant="ghost" size="sm" disabled={thread.loadingEarlier} onClick={earlier}>
              {thread.loadingEarlier ? 'Loading earlier messages…' : 'Show earlier'}
            </Button>
          </ThreadHistoryControl>
        )}
        {thread.loaded && thread.items.length === 0 && <ThreadEmpty>No messages yet.</ThreadEmpty>}
        {shown.map((item) => <ThreadRow key={item.key} item={item} markdown={markdown} answering={item.kind === 'approval' && thread.answering.has(item.requestId)} connected={connected} onAnswer={thread.answer} />)}
        {win.end !== null && (
          <ThreadHistoryControl>
            <Button data-testid="thread-show-later" variant="ghost" size="sm" onClick={() => setWin((current) => showLater(thread.items, current))}>Show later</Button>
            <Button data-testid="thread-jump-latest" variant="ghost" size="sm" onClick={() => { setWin(LATEST_WINDOW); thread.followLatest() }}>Jump to latest</Button>
          </ThreadHistoryControl>
        )}
        {win.end === null && thread.queue.map((message) => (
          <QueuedRow key={message.id} message={message} disabled={queueDisabled} editing={editing === message.id} onEdit={(on) => setEditing(on ? message.id : null)} onAct={act} />
        ))}
      </ThreadScroll>
      <ThreadComposer
        stoppable={threadStoppable(info, thread.events)}
        disabledReason={composerDisabledReason(info, connected)}
        daemonRefusal={thread.refusal}
        onDismissDaemonRefusal={thread.dismissRefusal}
        strip={<QueueStrip queue={thread.queue} disabled={queueDisabled} onAct={act} />}
        onSend={(text, steer) => {
          setWin(LATEST_WINDOW)
          thread.followLatest()
          thread.dismissRefusal()
          return sendThreadMessage(client, info.id, text, steer)
        }}
        onStop={() => stopThread(client, info.id)}
      />
    </ThreadSurface>
  )
}
