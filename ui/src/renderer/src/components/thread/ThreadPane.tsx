import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { HoustonClient, SessionInfo } from '../../houston/client'
import { loadMarkdownPipeline } from '../MarkdownPreview'
import { IconArrowUp, IconStopCircle } from '../icons'
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
  ThreadScroll,
  ThreadStoppedMarker,
  ThreadSurface,
  ThreadTurnFold,
  ThreadUserMessage
} from '../ui/Thread'
import { ThreadApprovalRow, ThreadPlanRow, ThreadToolRow } from './ThreadToolCard'
import { ThreadQuestionPrompt, ThreadQuestionRow } from './ThreadQuestion'
import { ThreadChangesCard, ThreadReasoningItem } from './ThreadWorkLog'
import { THREAD_USER_MESSAGE_MAX_BYTES } from '../../houston/generated/DEFAULTS'
import { LATEST_WINDOW, PLAN_TOOL, pendingQuestion, sameThreadItem, showEarlier, showLater, turnOpen, windowBounds, type ThreadItem, type ThreadWindow } from '../../thread/threadModel'
import { sendThreadMessage, setThreadPermissionMode, stopThread, useThread } from '../../thread/threadStore'
import { foldThreadRows } from '../../thread/threadTurns'
import type { ThreadPermissionMode } from '../../thread/threadTypes'

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

/** Sent when Keep planning is pressed with an empty message box. */
export const KEEP_PLANNING_DEFAULT = 'The user wants to keep planning before you implement.'

const ThreadRow = memo(function ThreadRow({ item, markdown, answering, connected, cwd, onAnswer, onKeepPlanning, onToggleTurn }: {
  item: ThreadItem
  markdown: PipelineModule | null
  answering: boolean
  connected: boolean
  cwd: string | undefined
  onAnswer: AnswerApproval
  onKeepPlanning: (requestId: string) => void
  onToggleTurn: (turn: string) => void
}): React.JSX.Element {
  switch (item.kind) {
    case 'user':
      return <ThreadUserMessage>{item.text}</ThreadUserMessage>
    case 'assistant':
      return (
        <ThreadAssistantBlock streaming={item.streaming}>
          {markdown ? <markdown.MarkdownDocument source={item.text} variant="thread" /> : <ThreadPlainText>{item.text}</ThreadPlainText>}
          {item.truncated && <ThreadCaption>Answer cut at 256 KiB by Houston.</ThreadCaption>}
        </ThreadAssistantBlock>
      )
    case 'reasoning':
      return <ThreadReasoningItem item={item} />
    case 'tool':
      return <ThreadToolRow item={item} cwd={cwd} />
    case 'turn':
      return <ThreadTurnFold label={item.label} outcome={item.outcome} open={item.expanded} onToggle={() => onToggleTurn(item.turn)} />
    case 'changes':
      return <ThreadChangesCard item={item} cwd={cwd} />
    case 'notice':
      return <ThreadNotice>{item.text}</ThreadNotice>
    case 'error':
      return <ThreadNotice tone="stop">{item.text}</ThreadNotice>
    case 'stopped':
      return <ThreadStoppedMarker />
    case 'approval':
      if (item.name === PLAN_TOOL) {
        const renderPlan = (source: string): React.JSX.Element => markdown ? <markdown.MarkdownDocument source={source} variant="thread" /> : <ThreadPlainText>{source}</ThreadPlainText>
        return <ThreadPlanRow item={item} answering={answering} connected={connected} renderPlan={renderPlan} onAnswer={onAnswer} onKeepPlanning={onKeepPlanning} />
      }
      return <ThreadApprovalRow item={item} answering={answering} connected={connected} onAnswer={onAnswer} />
    case 'question':
      return <ThreadQuestionRow item={item} />
  }
}, (a, b) => a.markdown === b.markdown && a.onAnswer === b.onAnswer && a.onKeepPlanning === b.onKeepPlanning && a.onToggleTurn === b.onToggleTurn && a.answering === b.answering && a.connected === b.connected && a.cwd === b.cwd && sameThreadItem(a.item, b.item))

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

/** The composer's text for a caller outside it, such as Keep planning, without re-rendering on each key. */
export interface ComposerDraft {
  text: () => string
  clear: () => void
}

export function ThreadComposer({ stoppable, disabledReason, draft, onSend, onStop }: {
  stoppable: boolean
  disabledReason: string | null
  draft?: React.RefObject<ComposerDraft | null>
  /** Whether the message was written; the text stays in the field when it was not. */
  onSend: (text: string) => boolean
  onStop: () => void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const current = useRef(text)
  current.current = text
  useEffect(() => {
    if (!draft) return
    draft.current = { text: () => current.current, clear: () => setText('') }
    return () => { draft.current = null }
  }, [draft])
  const [refusal, setRefusal] = useState<string | null>(null)
  const rows = Math.min(COMPOSER_MAX_ROWS, Math.max(1, text.split('\n').length))
  const send = (): void => {
    if (disabledReason !== null || text.trim() === '') return
    const size = utf8Length(text)
    if (size > THREAD_USER_MESSAGE_MAX_BYTES) {
      setRefusal(`Message not sent: it is ${size.toLocaleString()} bytes and a thread message is limited to ${THREAD_USER_MESSAGE_MAX_BYTES.toLocaleString()} bytes.`)
      return
    }
    if (!onSend(text)) {
      setRefusal('Message not sent: the connection to the daemon is closed. Your text is kept.')
      return
    }
    setRefusal(null)
    setText('')
  }
  return (
    <ThreadComposerFrame>
      {refusal && <Notice tone="danger" inset="compact-inline" action={{ label: 'Dismiss', onClick: () => setRefusal(null) }}>{refusal}</Notice>}
      <ThreadComposerInput
        data-testid="thread-composer-input"
        aria-label="Message Claude"
        placeholder={disabledReason ?? 'Message Claude'}
        rows={rows}
        value={text}
        disabled={disabledReason !== null}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.shiftKey || isImeEnter({ key: e.key, keyCode: e.nativeEvent.keyCode, isComposing: e.nativeEvent.isComposing })) return
          e.preventDefault()
          send()
        }}
      />
      <ThreadComposerActions hint="Enter sends · Shift+Enter adds a line">
        {stoppable
          ? <Button data-testid="thread-stop" variant="primary" size="sm" icon={IconStopCircle} disabled={disabledReason !== null} onClick={onStop}>Stop</Button>
          : <Button data-testid="thread-send" variant="primary" size="sm" icon={IconArrowUp} disabled={disabledReason !== null || text.trim() === ''} onClick={send}>Send</Button>}
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
  // Turns the reader opened, by the seq of their first message; settled turns start folded.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const toggleTurn = useCallback((turn: string) => setExpanded((current) => {
    const next = new Set(current)
    if (!next.delete(turn)) next.add(turn)
    return next
  }), [])
  const rows = useMemo(() => foldThreadRows(thread.timeline, expanded), [thread.timeline, expanded])
  const scroll = useRef<HTMLDivElement>(null)
  const { start, end } = windowBounds(rows, win)
  const shown = rows.slice(start, end)
  const asking = pendingQuestion(thread.timeline.items)
  const { onScroll, holdFromBottom } = useStickToBottom(scroll, [rows, start, end, markdown], win.end === null)
  const draft = useRef<ComposerDraft | null>(null)
  const { answer } = thread
  const keepPlanning = useCallback((requestId: string) => {
    const message = draft.current?.text().trim() ?? ''
    if (answer(requestId, false, message || KEEP_PLANNING_DEFAULT)) draft.current?.clear()
  }, [answer])
  const growOnArrival = useRef(false)
  useEffect(() => {
    if (thread.loadingEarlier || !growOnArrival.current) return
    growOnArrival.current = false
    holdFromBottom()
    setWin((current) => showEarlier(rows, current))
  }, [thread.loadingEarlier, rows, holdFromBottom])
  const earlier = (): void => {
    if (start === 0) {
      growOnArrival.current = true
      thread.loadEarlier()
      return
    }
    holdFromBottom()
    setWin((current) => showEarlier(rows, current))
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
        {thread.loaded && rows.length === 0 && <ThreadEmpty>No messages yet.</ThreadEmpty>}
        {shown.map((item) => <ThreadRow key={item.key} item={item} markdown={markdown} answering={item.kind === 'approval' && thread.answering.has(item.requestId)} connected={connected} cwd={info.cwd} onAnswer={thread.answer} onKeepPlanning={keepPlanning} onToggleTurn={toggleTurn} />)}
        {win.end !== null && (
          <ThreadHistoryControl>
            <Button data-testid="thread-show-later" variant="ghost" size="sm" onClick={() => setWin((current) => showLater(rows, current))}>Show later</Button>
            <Button data-testid="thread-jump-latest" variant="ghost" size="sm" onClick={() => { setWin(LATEST_WINDOW); thread.followLatest() }}>Jump to latest</Button>
          </ThreadHistoryControl>
        )}
      </ThreadScroll>
      {asking && <ThreadQuestionPrompt key={asking.requestId} item={asking} answering={thread.answering.has(asking.requestId)} connected={connected} onAnswer={thread.answerQuestion} />}
      <ThreadComposer
        stoppable={threadStoppable(info, thread.events)}
        disabledReason={composerDisabledReason(info, connected)}
        draft={draft}
        onSend={(text) => {
          setWin(LATEST_WINDOW)
          thread.followLatest()
          return sendThreadMessage(client, info.id, text)
        }}
        onStop={() => stopThread(client, info.id)}
      />
    </ThreadSurface>
  )
}
