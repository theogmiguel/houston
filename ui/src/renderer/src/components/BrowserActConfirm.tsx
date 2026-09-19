import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Toggle } from './settingsPrimitives'
import {
  type ActKind,
  fetchActScreenshot,
  respondToAct,
  type ConfirmRequest
} from '../houston/browserConfirm'
import { Tooltip } from './Tooltip'

function originOf(url: string | null): string {
  if (!url) return 'unknown page'
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

function describeTarget(request: ConfirmRequest): string {
  const { element } = request
  const name = element.name?.trim()
  return name ? `${element.role} “${name}”` : `<${element.tag}>`
}

function useCountdown(request: ConfirmRequest | null): number {
  const [left, setLeft] = useState(request?.timeoutSecs ?? 0)
  useEffect(() => {
    if (!request) return undefined
    setLeft(request.timeoutSecs)
    const tick = setInterval(() => setLeft((n) => (n > 0 ? n - 1 : 0)), 1000)
    return () => clearInterval(tick)
  }, [request])
  return left
}

function mmss(total: number): string {
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

const ACT_COPY: Record<
  ActKind,
  {
    title: string
    approve: string
    payloadLabel: ((request: ConfirmRequest) => string) | null
  }
> = {
  click: { title: 'click in', approve: 'click', payloadLabel: null },
  type: {
    title: 'type in',
    approve: 'typing',
    payloadLabel: (request) =>
      `Text to insert — ${request.text?.length ?? 0} characters` +
      (request.replace ? ' · replaces existing text' : '')
  },
  hover: { title: 'hover in', approve: 'hover', payloadLabel: null },
  pressKey: {
    title: 'press a key in',
    approve: 'key press',
    payloadLabel: () => 'Key to press'
  },
  selectOption: {
    title: 'select an option in',
    approve: 'selection',
    payloadLabel: () => 'Option to select'
  }
}

interface BodyProps {
  request: ConfirmRequest
  trust: boolean
  setTrust: (v: boolean) => void
  left: number
  busy: boolean
  onRespond: (approved: boolean) => void
  denyButtonRef?: React.RefObject<HTMLButtonElement | null>
}

function ConfirmBody({
  request,
  trust,
  setTrust,
  left,
  busy,
  onRespond,
  denyButtonRef
}: BodyProps): React.JSX.Element {
  const copy = ACT_COPY[request.kind] ?? ACT_COPY.click
  return (
    <>
      <div className="flex items-center gap-2 min-w-0">
        <span
          aria-hidden
          className="w-5 h-5 rounded-md flex-none grid place-items-center [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] text-[var(--content-bg)] bg-[var(--accent)]"
        >
          A
        </span>
        <span className="[font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] truncate">
          An agent wants to {copy.title} your browser
        </span>
      </div>

      <Tooltip label={request.url ?? undefined}>
        <div className="inline-flex items-center gap-1.5 self-start max-w-full px-2 py-1 rounded-md border border-[var(--border-hover)] bg-[var(--content-bg)] font-mono [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] truncate">
          <span className="text-[var(--success)] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)]" aria-hidden>
            ●
          </span>
          {originOf(request.url)}
        </div>
      </Tooltip>

      <div className="flex items-center gap-2 [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] min-w-0">
        <span className="font-mono [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] px-1.5 py-0.5 rounded bg-[var(--accent-muted)] text-[var(--accent-hover)] flex-none">
          {request.element.ref}
        </span>
        <span className="truncate">{describeTarget(request)}</span>
      </div>

      {copy.payloadLabel != null && (
        <div>
          <div className="[font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] uppercase text-[var(--text-faint)] mb-1">
            {copy.payloadLabel(request)}
          </div>
          <div className="font-mono [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] rounded-md border border-[var(--border)] bg-[var(--content-bg)] px-2.5 py-2 max-h-24 overflow-auto whitespace-pre-wrap break-words">
            {request.text}
          </div>
        </div>
      )}

      <div className="flex gap-2 items-start [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] rounded-md px-2.5 py-2 border border-[color-mix(in_srgb,var(--warning)_28%,transparent)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] text-[color-mix(in_srgb,var(--warning)_55%,var(--text-primary))]">
        <span aria-hidden className="flex-none">
          ⚠
        </span>
        <span>
          {request.kind === 'type'
            ? 'Read this before approving. If it contains anything you did not expect — a key, a token, text from another page — deny it.'
            : 'This page is signed in as you. An action here can submit, purchase or delete.'}
        </span>
      </div>

      <div className="flex items-center gap-2 [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)]">
        <Toggle on={trust} onChange={setTrust} data-testid="browser-act-trust" />
        <span>Don&apos;t ask again for this workspace this session</span>
      </div>

      <div className="flex items-center gap-2">
        <span className="font-mono [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-faint)] mr-auto">
          denies in <span className="tabular-nums">{mmss(left)}</span>
        </span>
        <button
          ref={denyButtonRef}
          type="button"
          onClick={() => onRespond(false)}
          disabled={busy}
          className="btn h-[var(--h-ctl)] px-3 rounded-[var(--tr-radius-button)] [font-size:var(--tr-text-small-size)] font-semibold border border-[var(--border-hover)] bg-[var(--card-bg)] text-[var(--text-primary)] hover:bg-[var(--card-hover)] disabled:opacity-[0.45] disabled:cursor-default"
        >
          Deny
        </button>
        <button
          type="button"
          onClick={() => onRespond(true)}
          disabled={busy}
          className="btn h-[var(--h-ctl)] px-3 rounded-[var(--tr-radius-button)] [font-size:var(--tr-text-small-size)] font-semibold border-0 text-[var(--content-bg)] bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-[0.45] disabled:cursor-default"
        >
          Approve {copy.approve}
        </button>
      </div>
    </>
  )
}

export interface BrowserActConfirmProps {
  request: ConfirmRequest
  paneRef?: React.RefObject<HTMLElement | null>
  onDone: () => void
}

export function BrowserActConfirm({
  request,
  onDone
}: BrowserActConfirmProps): React.JSX.Element | null {
  const [shot, setShot] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [trust, setTrust] = useState(false)
  const [busy, setBusy] = useState(false)
  const answered = useRef(false)
  const left = useCountdown(request)
  const containerRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const denyButtonRef = useRef<HTMLButtonElement>(null)
  const [cardPos, setCardPos] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    const container = containerRef.current
    const card = cardRef.current
    if (!container || !card) return
    const target = request.element.rect
    const MARGIN = 12
    const paneW = container.clientWidth
    const paneH = container.clientHeight
    const cardW = card.offsetWidth
    const cardH = card.offsetHeight
    let top = target.y + target.height + 14
    if (top + cardH > paneH - MARGIN) {
      const above = target.y - 14 - cardH
      top = above >= MARGIN ? above : Math.max(MARGIN, paneH - MARGIN - cardH)
    }
    let leftPos = Math.max(MARGIN, target.x - 8)
    if (leftPos + cardW > paneW - MARGIN) {
      leftPos = Math.max(MARGIN, paneW - MARGIN - cardW)
    }
    setCardPos({ top, left: leftPos })
  }, [shot, request])

  useEffect(() => {
    let url: string | null = null
    let dropped = false
    setFailed(false)
    void fetchActScreenshot(request).then((got) => {
      if (dropped) {
        if (got) URL.revokeObjectURL(got)
        return
      }
      url = got
      setShot(got)
      if (!got) setFailed(true)
    })
    return () => {
      dropped = true
      if (url) URL.revokeObjectURL(url)
      setShot(null)
    }
  }, [request])

  const respond = (approved: boolean): void => {
    if (answered.current) return
    answered.current = true
    setBusy(true)
    void respondToAct(request, approved, approved && trust)
      .catch((err: unknown) => {
        console.error('[browser] responding to a pending act failed:', err)
      })
      .finally(onDone)
  }

  useEffect(() => {
    if (!shot) return undefined
    const previouslyFocused = document.activeElement as HTMLElement | null
    denyButtonRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      respond(false)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- respond is a
  }, [shot])

  if (!request.hasScreenshot) return null
  if (failed) {
    return <BrowserActConfirmModal request={request} onDone={onDone} />
  }
  if (!shot) return null

  const box = request.element.rect
  return (
    <div
      ref={containerRef}
      className="absolute inset-0 z-[var(--z-sticky)] bg-[color-mix(in_srgb,var(--content-bg)_55%,transparent)] motion-safe:animate-[backdrop-in_var(--animate-t-scrim)_var(--animate-ease-scrim)]"
    >
      <div className="absolute inset-0 overflow-hidden">
        <img
          src={shot}
          alt=""
          aria-hidden
          className="absolute inset-0 w-full h-full object-cover object-left-top"
        />
        <div
          className="absolute rounded-md pointer-events-none"
          style={{
            left: box.x,
            top: box.y,
            width: box.width,
            height: box.height,
            outline: '2px solid var(--warning)',
            outlineOffset: 2,
            background: 'color-mix(in srgb, var(--warning) 13%, transparent)',
            boxShadow: '0 0 0 9999px color-mix(in srgb, var(--content-bg) 62%, transparent)'
          }}
        >
          <span className="absolute -top-3 -left-0.5 font-mono [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] px-1.5 rounded bg-[var(--warning)] text-[var(--content-bg)]">
            {request.element.ref}
          </span>
        </div>
      </div>

      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label="Confirm browser action"
        className="absolute w-[300px] max-w-[calc(100%-24px)] flex flex-col gap-2 rounded-xl border border-[var(--warning)] bg-[var(--card-bg)] p-3 shadow-[var(--shadow-lg)] motion-safe:animate-[menu-in_var(--animate-t-fast)_var(--animate-ease-menu)]"
        style={cardPos ?? { top: box.y + box.height + 14, left: Math.max(12, box.x - 8) }}
      >
        <ConfirmBody
          request={request}
          trust={trust}
          setTrust={setTrust}
          left={left}
          busy={busy}
          onRespond={respond}
          denyButtonRef={denyButtonRef}
        />
      </div>
    </div>
  )
}

export function BrowserActConfirmModal({
  request,
  onDone
}: {
  request: ConfirmRequest
  onDone: () => void
}): React.JSX.Element {
  const [trust, setTrust] = useState(false)
  const [busy, setBusy] = useState(false)
  const answered = useRef(false)
  const left = useCountdown(request)
  const denyButtonRef = useRef<HTMLButtonElement>(null)

  const respond = (approved: boolean): void => {
    if (answered.current) return
    answered.current = true
    setBusy(true)
    void respondToAct(request, approved, approved && trust)
      .catch((err: unknown) => {
        console.error('[browser] responding to a pending act failed:', err)
      })
      .finally(onDone)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') respond(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request])

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    denyButtonRef.current?.focus()
    return () => {
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [])

  return (
    <div className="fixed inset-0 z-[var(--z-modal)] grid place-items-center bg-[var(--overlay)] motion-safe:animate-[backdrop-in_var(--animate-t-scrim)_var(--animate-ease-scrim)]">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Confirm browser action"
        className="w-[428px] max-w-[calc(100vw-32px)] flex flex-col gap-3 rounded-xl border border-[var(--border-hover)] bg-[var(--card-bg)] p-4 shadow-[var(--shadow-lg)] motion-safe:animate-[panel-in_var(--animate-t-panel)_var(--animate-ease-panel)]"
      >
        <ConfirmBody
          request={request}
          trust={trust}
          setTrust={setTrust}
          left={left}
          busy={busy}
          onRespond={respond}
          denyButtonRef={denyButtonRef}
        />
        <p className="m-0 [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-faint)]">
          The browser pane is not on screen, so this cannot show you the element in place — only
          describe it. Open the pane and retry if that matters for this action.
        </p>
      </div>
    </div>
  )
}
