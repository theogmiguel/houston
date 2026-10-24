import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { HoustonClient, SessionInfo } from '../../houston/client'
import { isLive } from '../../houston/client'
import { loadMarkdownPipeline } from '../MarkdownPreview'
import { IconArrowUp, IconStopCircle } from '../icons'
import { Button } from '../ui/Button'
import { Notice } from '../ui/Notice'
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
  ThreadUserMessage
} from '../ui/Thread'
import { ThreadApprovalRow, ThreadToolRow } from './ThreadToolCard'
import { THREAD_USER_MESSAGE_MAX_BYTES } from '../../houston/generated/DEFAULTS'
import { LATEST_WINDOW, sameThreadItem, showEarlier, showLater, windowBounds, type ThreadItem, type ThreadWindow } from '../../thread/threadModel'
import { answerApproval, sendThreadMessage, setThreadPermissionMode, stopThread, useThread } from '../../thread/threadStore'
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

const ThreadRow = memo(function ThreadRow({ item, markdown, onAnswer }: { item: ThreadItem; markdown: PipelineModule | null; onAnswer: AnswerApproval }): React.JSX.Element {
  switch (item.kind) {
    case 'user':
      return <ThreadUserMessage>{item.text}</ThreadUserMessage>
    case 'assistant':
      return (
        <ThreadAssistantBlock streaming={item.streaming}>
          {markdown ? <markdown.MarkdownDocument source={item.text} variant="chat" /> : <ThreadPlainText>{item.text}</ThreadPlainText>}
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
      return <ThreadApprovalRow item={item} onAnswer={onAnswer} />
  }
}, (a, b) => a.markdown === b.markdown && a.onAnswer === b.onAnswer && sameThreadItem(a.item, b.item))

const PERMISSION_MODES: readonly { value: ThreadPermissionMode; label: string }[] = [
  { value: 'default', label: 'Ask before tools' },
  { value: 'accept_edits', label: 'Accept edits' },
  { value: 'plan', label: 'Plan only' },
  { value: 'auto', label: 'Auto' },
  { value: 'bypass', label: 'Bypass permissions' }
]

/** Why the mode cannot change now; the daemon refuses it the same way. */
export function permissionModeLockedReason(info: SessionInfo, connected: boolean): string | null {
  if (!connected) return 'Reconnecting to the daemon'
  if (!isLive(info.state)) return `This session is ${info.state}`
  if (info.status === 'working') return 'Claude is working; change the mode when the turn ends or after Stop'
  if (info.status === 'needs-input') return 'Claude is waiting for an answer; change the mode after it'
  return null
}

function ThreadPermissionControl({ client, info, connected }: { client: HoustonClient; info: SessionInfo; connected: boolean }): React.JSX.Element {
  const locked = permissionModeLockedReason(info, connected)
  return (
    <ThreadHeaderBar>
      <Text as="span" size="small" tone="muted" className="flex-none">Permissions</Text>
      <Select
        data-testid="thread-permission-mode"
        aria-label="Permission mode"
        variant="property-chip"
        value={info.permission_mode ?? 'default'}
        options={PERMISSION_MODES}
        disabled={locked !== null}
        title={locked ?? 'Changing the mode restarts Claude in this conversation'}
        onChange={(mode) => setThreadPermissionMode(client, info.id, mode as ThreadPermissionMode)}
      />
    </ThreadHeaderBar>
  )
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length
}

function formatKiB(bytes: number): string {
  return `${(bytes / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KiB`
}

export function ThreadComposer({ working, disabledReason, onSend, onStop }: {
  working: boolean
  disabledReason: string | null
  onSend: (text: string) => void
  onStop: () => void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [refusal, setRefusal] = useState<string | null>(null)
  const rows = Math.min(COMPOSER_MAX_ROWS, Math.max(1, text.split('\n').length))
  const send = (): void => {
    if (disabledReason !== null || text.trim() === '') return
    const size = utf8Length(text)
    if (size > THREAD_USER_MESSAGE_MAX_BYTES) {
      setRefusal(`Message not sent: it is ${formatKiB(size)} and a thread message is limited to ${formatKiB(THREAD_USER_MESSAGE_MAX_BYTES)}.`)
      return
    }
    setRefusal(null)
    onSend(text)
    setText('')
  }
  return (
    <ThreadComposerFrame>
      {refusal && <Notice tone="danger" inset="compact-inline" action={{ label: 'Dismiss', onClick: () => setRefusal(null) }}>{refusal}</Notice>}
      <ThreadComposerInput
        data-testid="thread-composer-input"
        aria-label="Message Claude"
        placeholder={disabledReason ?? (working ? 'Message Claude; it reads this after the current step' : 'Message Claude')}
        rows={rows}
        value={text}
        disabled={disabledReason !== null}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
          e.preventDefault()
          send()
        }}
      />
      <ThreadComposerActions hint="Enter sends · Shift+Enter adds a line">
        {working
          ? <Button data-testid="thread-stop" variant="primary" size="sm" icon={IconStopCircle} disabled={disabledReason !== null} onClick={onStop}>Stop</Button>
          : <Button data-testid="thread-send" variant="primary" size="sm" icon={IconArrowUp} disabled={disabledReason !== null || text.trim() === ''} onClick={send}>Send</Button>}
      </ThreadComposerActions>
    </ThreadComposerFrame>
  )
}

function composerDisabledReason(info: SessionInfo, connected: boolean): string | null {
  if (!connected) return 'Reconnecting to the daemon'
  if (!isLive(info.state)) return `This session is ${info.state}`
  return null
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
  const { onScroll, holdFromBottom } = useStickToBottom(scroll, [thread.items, start, end], win.end === null)
  const earlierAvailable = start > 0 || thread.hasMore
  const working = info.status === 'working'
  const onAnswer = useCallback<AnswerApproval>((requestId, allow) => answerApproval(client, info.id, requestId, allow), [client, info.id])
  const earlier = (): void => {
    holdFromBottom()
    if (start === 0) thread.loadEarlier()
    setWin((current) => showEarlier(thread.items, current))
  }
  return (
    <ThreadSurface>
      <ThreadPermissionControl client={client} info={info} connected={connected} />
      <ThreadScroll ref={scroll} onScroll={onScroll}>
        {earlierAvailable && (
          <ThreadHistoryControl>
            <Button data-testid="thread-show-earlier" variant="ghost" size="sm" disabled={thread.loadingEarlier} onClick={earlier}>
              {thread.loadingEarlier ? 'Loading earlier messages…' : 'Show earlier'}
            </Button>
          </ThreadHistoryControl>
        )}
        {thread.loaded && thread.items.length === 0 && <ThreadEmpty>No messages yet.</ThreadEmpty>}
        {shown.map((item) => <ThreadRow key={item.key} item={item} markdown={markdown} onAnswer={onAnswer} />)}
        {win.end !== null && (
          <ThreadHistoryControl>
            <Button data-testid="thread-show-later" variant="ghost" size="sm" onClick={() => setWin((current) => showLater(thread.items, current))}>Show later</Button>
            <Button data-testid="thread-jump-latest" variant="ghost" size="sm" onClick={() => setWin(LATEST_WINDOW)}>Jump to latest</Button>
          </ThreadHistoryControl>
        )}
      </ThreadScroll>
      <ThreadComposer
        working={working}
        disabledReason={composerDisabledReason(info, connected)}
        onSend={(text) => {
          setWin(LATEST_WINDOW)
          sendThreadMessage(client, info.id, text)
        }}
        onStop={() => stopThread(client, info.id)}
      />
    </ThreadSurface>
  )
}
