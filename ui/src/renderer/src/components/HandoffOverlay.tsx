import { useEffect, useRef, useState } from 'react'
import { BTN_GHOST, BTN_GHOST_DANGER_HOVER } from './buttonChrome'
import { IconAlertTriangle, IconCheck } from './icons'
import { Icon } from './Icon'
import { MODAL_SCRIM_CLS } from './overlayChrome'

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
        <code
          key={key++}
          className="bg-[var(--tool-code-bg)] rounded px-[5px] py-px [font-size:var(--tr-text-body-size)] [font-weight:var(--tr-text-body-weight)] text-text-primary"
        >
          {token.slice(1, -1)}
        </code>
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
      <ul key={key++} className="my-1.5 pl-5">
        {listBuf.map((item, j) => (
          <li key={j}>{renderInline(item)}</li>
        ))}
      </ul>
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
        <pre
          key={key++}
          className="bg-[var(--tool-code-bg)] border border-border rounded-[var(--tr-radius-sm)] px-2.5 py-2 my-2 overflow-x-auto"
        >
          <code className="bg-transparent p-0 [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-text-secondary">
            {codeLines.join('\n')}
          </code>
        </pre>
      )
      continue
    }
    const h3 = line.match(/^### (.*)/)
    const h2 = line.match(/^## (.*)/)
    const h1 = line.match(/^# (.*)/)
    if (h3 || h2 || h1) {
      flushList()
      const text = (h3 ?? h2 ?? h1)![1]
      const headingClass = 'text-text-primary mt-3.5 mb-1.5 first:mt-0'
      blocks.push(
        h3 ? (
          <h3 key={key++} className={headingClass}>
            {renderInline(text)}
          </h3>
        ) : h2 ? (
          <h2 key={key++} className={headingClass}>
            {renderInline(text)}
          </h2>
        ) : (
          <h1 key={key++} className={headingClass}>
            {renderInline(text)}
          </h1>
        )
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
      <p key={key++} className="my-1.5">
        {renderInline(paraLines.join(' '))}
      </p>
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
      <div className="px-3.5 py-[11px] border-b border-border [font-size:var(--tr-text-subhead-size)] [font-weight:var(--tr-text-subhead-weight)] [letter-spacing:var(--tr-text-subhead-tracking)] text-text-primary">
        HANDOFF — {state.sessionTitle} via {state.provider}
      </div>
      <div className={`p-5 space-y-4 flex flex-col ${isPane ? 'flex-1 min-h-0' : 'max-h-[60vh]'}`}>
        {state.phase === 'generating' && (
          <>
            {state.text === '' ? (
              <div
                data-testid="handoff-skeleton"
                className={`flex-1 min-h-0 flex flex-col justify-center gap-2 ${isPane ? '' : 'h-[44vh]'}`}
              >
                {SKELETON_WIDTHS.map((w, i) => (
                  <div
                    key={i}
                    className="loop-anim h-[13px] rounded-[3px] bg-[color-mix(in_srgb,var(--text-faint)_20%,transparent)] motion-safe:[animation:skeleton-shimmer_1.4s_ease-in-out_infinite]"
                    style={{ width: `${w}%`, animationDelay: `${i * 60}ms` }}
                  />
                ))}
                <div className="text-[var(--text-faint)] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)]">Preparing handoff…</div>
              </div>
            ) : (
              <div
                ref={preRef}
                className={`text-text-secondary [font-size:var(--tr-text-body-size)] [font-weight:var(--tr-text-body-weight)] leading-[1.6] overflow-y-auto ${isPane ? 'flex-1 min-h-0' : 'h-[44vh]'}`}
                onScroll={onScroll}
              >
                {renderMarkdown(state.text)}
                <span
                  aria-hidden="true"
                  className="loop-anim inline-block w-2 h-4 mb-[-3px] bg-[var(--text-primary)] motion-safe:[animation:skeleton-cursor-blink_1s_step-end_infinite]"
                />
              </div>
            )}
            <div className="flex items-center gap-2 text-[var(--text-faint)] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)]">
              <span className="loop-anim w-[7px] h-[7px] rounded-full bg-primary [--dot-pulse-opacity:0.25] motion-safe:animate-[dot-pulse_1.2s_ease-in-out_infinite]" />
              <span>generating…</span>
            </div>
          </>
        )}
        {state.phase === 'done' && (
          <>
            <div
              className={`text-text-secondary [font-size:var(--tr-text-body-size)] [font-weight:var(--tr-text-body-weight)] leading-[1.6] overflow-y-auto ${isPane ? 'flex-1 min-h-0' : ''}`}
            >
              {renderMarkdown(state.markdown)}
            </div>
            {state.savedPath && (
              <div className="text-[var(--text-faint)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.55]">
                saved to {state.savedPath}
              </div>
            )}
          </>
        )}
        {state.phase === 'error' && (
          <div className="text-[var(--status-blocked-text)] [font-size:var(--tr-text-body-size)] [font-weight:var(--tr-text-body-weight)]">{state.error}</div>
        )}
      </div>
      <div className="flex flex-col gap-2 px-5 pb-5">
        <div className="flex gap-2 justify-end">
          {state.phase === 'generating' && (
            <button className={`btn ${BTN_GHOST} ${BTN_GHOST_DANGER_HOVER}`} onClick={onCancel}>
              Cancel
            </button>
          )}
          {state.phase === 'done' && (
            <>
              <button
                className={`btn ${BTN_GHOST} ${copyState === 'failed' ? 'text-warning hover:text-warning' : ''}`}
                data-testid="handoff-copy"
                data-copy-state={copyState}
                onClick={copy}
              >
                {copyState === 'copied' ? (
                  <span className="inline-flex items-center gap-1">
                    <Icon glyph={IconCheck} role="small" /> Copied
                  </span>
                ) : copyState === 'failed' ? (
                  <span className="inline-flex items-center gap-1">
                    <Icon glyph={IconAlertTriangle} role="small" /> Failed
                  </span>
                ) : (
                  'Copy'
                )}
              </button>
              <button className={`btn ${BTN_GHOST}`} onClick={onPaste}>
                Paste into pane
              </button>
              <button className={`btn ${BTN_GHOST}`} onClick={onClose}>
                Close <span className="opacity-55 font-normal">esc</span>
              </button>
            </>
          )}
          {state.phase === 'error' && (
            <button className={`btn ${BTN_GHOST}`} onClick={onClose}>
              Close <span className="opacity-55 font-normal">esc</span>
            </button>
          )}
        </div>
      </div>
    </>
  )

  if (variant === 'modal') {
    return (
      <div
        className={MODAL_SCRIM_CLS}
        onMouseDown={() => {
          if (state.phase !== 'generating') onClose()
        }}
      >
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label={`Handoff — ${state.sessionTitle}`}
          tabIndex={-1}
          className="pop w-[720px] max-w-[92vw] bg-[var(--raised)] border border-[var(--border)] rounded-[var(--tr-radius-md)] shadow-[var(--shadow-2,0_24px_64px_rgba(0,0,0,0.55),0_2px_8px_rgba(0,0,0,0.4))] motion-safe:animate-[panel-in_var(--animate-t-panel)_var(--animate-ease-panel)] [.anim-out_&]:motion-safe:animate-[panel-out_var(--animate-t-fast)_var(--animate-ease-panel)_forwards]"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {content}
        </div>
      </div>
    )
  }
  return (
    <div
      className="handoff-overlay absolute inset-0 z-[calc(var(--z-leaf)+2)] flex flex-col bg-[var(--card-bg)] motion-safe:animate-[panel-in_var(--animate-t-panel)_var(--animate-ease-panel)] [.anim-out_&]:motion-safe:animate-[panel-out_var(--animate-t-fast)_var(--animate-ease-panel)_forwards]"
      onMouseDown={(e) => e.stopPropagation()}
    >
      {content}
    </div>
  )
}
