import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { HoustonClient, SessionInfo } from '../../houston/client'
import { loadMarkdownPipeline } from '../MarkdownPreview'
import { IconArrowUp, IconStopCircle } from '../icons'
import { Button } from '../ui/Button'
import { Notice } from '../ui/Notice'
import {
  ThreadAssistantBlock,
  ThreadCaption,
  ThreadComposerActions,
  ThreadComposerFrame,
  ThreadComposerInput,
  ThreadEmpty,
  ThreadHistoryControl,
  ThreadNotice,
  ThreadPlainText,
  ThreadScroll,
  ThreadStoppedMarker,
  ThreadSurface,
  ThreadUserMessage
} from '../ui/Thread'
import { ThreadToolRow } from './ThreadToolCard'
import { THREAD_USER_MESSAGE_MAX_BYTES } from '../../houston/generated/DEFAULTS'
import { LATEST_WINDOW, sameThreadItem, showEarlier, showLater, turnOpen, windowBounds, type ThreadItem, type ThreadWindow } from '../../thread/threadModel'
import { sendThreadMessage, stopThread, useThread } from '../../thread/threadStore'

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

const ThreadRow = memo(function ThreadRow({ item, markdown }: { item: ThreadItem; markdown: PipelineModule | null }): React.JSX.Element {
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
    case 'tool':
      return <ThreadToolRow item={item} />
    case 'notice':
      return <ThreadNotice>{item.text}</ThreadNotice>
    case 'error':
      return <ThreadNotice tone="stop">{item.text}</ThreadNotice>
    case 'stopped':
      return <ThreadStoppedMarker />
  }
}, (a, b) => a.markdown === b.markdown && sameThreadItem(a.item, b.item))

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length
}

/** Enter that confirms an IME candidate; WebKit reports it after `compositionend` with key code 229. */
export function isImeEnter(event: { key: string; keyCode: number; isComposing: boolean }): boolean {
  return event.isComposing || event.keyCode === 229 || event.key === 'Process'
}

export function ThreadComposer({ stoppable, disabledReason, onSend, onStop }: {
  stoppable: boolean
  disabledReason: string | null
  /** Whether the message was written; the text stays in the field when it was not. */
  onSend: (text: string) => boolean
  onStop: () => void
}): React.JSX.Element {
  const [text, setText] = useState('')
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

// A thread without a process resumes on the next message, so only a removed or sleeping session refuses input.
export function composerDisabledReason(info: SessionInfo, connected: boolean): string | null {
  if (!connected) return 'Reconnecting to the daemon'
  if (info.state === 'killed' || info.state === 'sleeping') return `This session is ${info.state}`
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
  const scroll = useRef<HTMLDivElement>(null)
  const { start, end } = windowBounds(thread.items, win)
  const shown = thread.items.slice(start, end)
  const { onScroll, holdFromBottom } = useStickToBottom(scroll, [thread.items, start, end, markdown], win.end === null)
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
        {shown.map((item) => <ThreadRow key={item.key} item={item} markdown={markdown} />)}
        {win.end !== null && (
          <ThreadHistoryControl>
            <Button data-testid="thread-show-later" variant="ghost" size="sm" onClick={() => setWin((current) => showLater(thread.items, current))}>Show later</Button>
            <Button data-testid="thread-jump-latest" variant="ghost" size="sm" onClick={() => { setWin(LATEST_WINDOW); thread.followLatest() }}>Jump to latest</Button>
          </ThreadHistoryControl>
        )}
      </ThreadScroll>
      <ThreadComposer
        stoppable={threadStoppable(info, thread.events)}
        disabledReason={composerDisabledReason(info, connected)}
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
