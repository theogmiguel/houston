import { useEffect, useRef, useState } from 'react'
import { IconAlertTriangle, IconCheck } from './icons'
import { Icon } from './ui/Icon'
import { Button, DialogBackdrop, DialogPanel } from './ui'
import {
  ScrollBody,
  StatusCaption,
  CodeBlock,
  CopyButton,
  TypingCursor,
  ErrorMessage,
  ActionRow,
  OverlayHeader,
  MarkdownHeading,
  InlineCode,
  MarkdownList,
  OverlaySurface,
  MarkdownParagraph,
  MarkdownBody,
  StatusPulse,
  SavedPath,
  LoadingPlaceholder,
  LoadingPlaceholderLine,
  KeyHint
} from './ui/MarkdownContent'

export interface HandoffUiState {
  request: number
  session: number
  sessionTitle: string
  provider: string
  phase: 'generating' | 'done' | 'error'
  text: string
  markdown: string
  savedPath: string
  error: string
}

interface Props {
  state: HandoffUiState
  onCancel: () => void
  onClose: () => void
  onPaste: () => void
  variant?: 'pane' | 'modal'
}

export interface HandoffUi {
  state: HandoffUiState
  onCancel: () => void
  onClose: () => void
  onPaste: () => void
}

function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    const token = m[0]
    parts.push(
      token.startsWith('**') ? (
        <strong key={key++}>{token.slice(2, -2)}</strong>
      ) : (
        <InlineCode key={key++}>{token.slice(1, -1)}</InlineCode>
      )
    )
    last = re.lastIndex
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

function renderMarkdown(md: string): React.JSX.Element[] {
  const lines = md.split('\n')
  const blocks: React.JSX.Element[] = []
  let listBuf: string[] = []
  let key = 0
  let i = 0

  const flushList = (): void => {
    if (listBuf.length === 0) return
    blocks.push(
      <MarkdownList key={key++}>
        {listBuf.map((item, j) => (
          <li key={j}>{renderInline(item)}</li>
        ))}
      </MarkdownList>
    )
    listBuf = []
  }

  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith('```')) {
      flushList()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      i++
      blocks.push(
        <CodeBlock key={key++}>{codeLines.join('\n')}</CodeBlock>
      )
      continue
    }
    const h3 = line.match(/^### (.*)/)
    const h2 = line.match(/^## (.*)/)
    const h1 = line.match(/^# (.*)/)
    if (h3 || h2 || h1) {
      flushList()
      const text = (h3 ?? h2 ?? h1)![1]
      const level = h3 ? 3 : h2 ? 2 : 1
      blocks.push(
        <MarkdownHeading key={key++} level={level} className="mt-3.5">
          {renderInline(text)}
        </MarkdownHeading>
      )
      i++
      continue
    }
    const li = line.match(/^[-*] (.*)/)
    if (li) {
      listBuf.push(li[1])
      i++
      continue
    }
    if (line.trim() === '') {
      flushList()
      i++
      continue
    }
    flushList()
    const paraLines = [line]
    i++
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].startsWith('```') &&
      !/^#{1,3} /.test(lines[i]) &&
      !/^[-*] /.test(lines[i])
    ) {
      paraLines.push(lines[i])
      i++
    }
    blocks.push(
      <MarkdownParagraph key={key++}>{renderInline(paraLines.join(' '))}</MarkdownParagraph>
    )
  }
  flushList()
  return blocks
}

const COPY_FEEDBACK_MS = 2000

const SKELETON_WIDTHS = [92, 78, 85, 60, 88, 45]

export function HandoffOverlay({
  state,
  onCancel,
  onClose,
  onPaste,
  variant = 'pane'
}: Props): React.JSX.Element {
  const preRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copyTokenRef = useRef(0)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (state.phase === 'generating' && pinned.current && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight
    }
  }, [state.text, state.phase])

  useEffect(() => {
    return () => {
      clearTimeout(copyTimerRef.current)
      copyTokenRef.current = -1
    }
  }, [])

  useEffect(() => {
    if (variant !== 'modal') return undefined
    const previouslyFocused = document.activeElement as HTMLElement | null
    panelRef.current?.focus()
    return () => {
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per mount, not on every state/variant re-render
  }, [])

  const onScroll = (): void => {
    const el = preRef.current
    if (!el) return
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }

  const copy = (): void => {
    clearTimeout(copyTimerRef.current)
    const token = ++copyTokenRef.current
    const settle = (result: 'copied' | 'failed'): void => {
      if (copyTokenRef.current !== token) return
      setCopyState(result)
      copyTimerRef.current = setTimeout(() => setCopyState('idle'), COPY_FEEDBACK_MS)
    }
    void navigator.clipboard.writeText(state.markdown).then(
      () => settle('copied'),
      () => settle('failed')
    )
  }

  const isPane = variant === 'pane'

  const content = (
    <>
      <OverlayHeader>
        HANDOFF — {state.sessionTitle} via {state.provider}
      </OverlayHeader>
      <ScrollBody pane={isPane}>
        {state.phase === 'generating' && (
          <>
            {state.text === '' ? (
              <LoadingPlaceholder data-testid="handoff-skeleton" extent={isPane ? 'natural' : 'tall'}>
                {SKELETON_WIDTHS.map((w, i) => (
                  <LoadingPlaceholderLine
                    key={i}
                    style={{ width: `${w}%`, animationDelay: `${i * 60}ms` }}
                  />
                ))}
                <StatusCaption>Preparing handoff…</StatusCaption>
              </LoadingPlaceholder>
            ) : (
              <MarkdownBody ref={preRef} extent={isPane ? 'fill' : 'tall'} onScroll={onScroll}>
                {renderMarkdown(state.text)}
                <TypingCursor />
              </MarkdownBody>
            )}
            <StatusCaption className="flex items-center gap-[var(--space-2)]">
              <StatusPulse />
              <span>generating…</span>
            </StatusCaption>
          </>
        )}
        {state.phase === 'done' && (
          <>
            <MarkdownBody extent={isPane ? 'fill' : 'natural'}>{renderMarkdown(state.markdown)}</MarkdownBody>
            {state.savedPath && <SavedPath>saved to {state.savedPath}</SavedPath>}
          </>
        )}
        {state.phase === 'error' && <ErrorMessage>{state.error}</ErrorMessage>}
      </ScrollBody>
      <ActionRow>
        {state.phase === 'generating' && (
          <Button variant="legacy-danger" onClick={onCancel}>
            Cancel
          </Button>
        )}
        {state.phase === 'done' && (
          <>
            <CopyButton
              failed={copyState === 'failed'}
              data-testid="handoff-copy"
              data-copy-state={copyState}
              onClick={copy}
            >
              {copyState === 'copied' ? (
                <span className="inline-flex items-center gap-[var(--space-1)]">
                  <Icon glyph={IconCheck} role="small" /> Copied
                </span>
              ) : copyState === 'failed' ? (
                <span className="inline-flex items-center gap-[var(--space-1)]">
                  <Icon glyph={IconAlertTriangle} role="small" /> Failed
                </span>
              ) : (
                'Copy'
              )}
            </CopyButton>
            <Button variant="legacy-ghost" onClick={onPaste}>
              Paste into pane
            </Button>
            <Button variant="legacy-ghost" onClick={onClose}>
              Close <KeyHint>esc</KeyHint>
            </Button>
          </>
        )}
        {state.phase === 'error' && (
          <Button variant="legacy-ghost" onClick={onClose}>
            Close <KeyHint>esc</KeyHint>
          </Button>
        )}
      </ActionRow>
    </>
  )

  if (variant === 'modal') {
    return (
      <DialogBackdrop onMouseDown={() => {
          if (state.phase !== 'generating') onClose()
        }}>
        <DialogPanel
          size="handoff"
          surface="raised"
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label={`Handoff — ${state.sessionTitle}`}
          tabIndex={-1}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {content}
        </DialogPanel>
      </DialogBackdrop>
    )
  }
  return <OverlaySurface onMouseDown={(e) => e.stopPropagation()}>{content}</OverlaySurface>
}
