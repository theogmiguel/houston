import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Toggle } from './ui/settingsPrimitives'
import {
  type ActKind,
  fetchActScreenshot,
  respondToAct,
  type ConfirmRequest
} from '../houston/browserConfirm'
import { Tooltip } from './ui/Tooltip'
import {
  ConfirmationBadge,
  ConfirmationCard,
  ConfirmationCountdown,
  ConfirmationDialogBackdrop,
  ConfirmationDialogPanel,
  ConfirmationFootnote,
  ConfirmationOverlay,
  ConfirmationScreenshot,
  ConfirmationTitle,
  DecisionButton,
  ElementReference,
  ElementSummary,
  OriginBadge,
  OriginStatus,
  PayloadDetails,
  PayloadLabel,
  PayloadValue,
  TrustOption,
  WarningCallout,
  BrowserActSpotlight
} from './ui/BrowserSurface'
import { Text } from './ui/Text'

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
      <div className="flex items-center gap-[var(--space-2)] min-w-0">
        <ConfirmationBadge aria-hidden>
          A
        </ConfirmationBadge>
        <ConfirmationTitle>
          An agent wants to {copy.title} your browser
        </ConfirmationTitle>
      </div>

      <Tooltip label={request.url ?? undefined}>
        <OriginBadge>
          <OriginStatus aria-hidden>
            ●
          </OriginStatus>
          {originOf(request.url)}
        </OriginBadge>
      </Tooltip>

      <ElementSummary>
        <ElementReference>
          {request.element.ref}
        </ElementReference>
        <Text className="truncate">{describeTarget(request)}</Text>
      </ElementSummary>

      {copy.payloadLabel != null && (
        <PayloadDetails>
          <PayloadLabel>
            {copy.payloadLabel(request)}
          </PayloadLabel>
          <PayloadValue>
            {request.text}
          </PayloadValue>
        </PayloadDetails>
      )}

      <WarningCallout>
        <span aria-hidden className="flex-none">
          ⚠
        </span>
        <span>
          {request.kind === 'type'
            ? 'Read this before approving. If it contains anything you did not expect — a key, a token, text from another page — deny it.'
            : 'This page is signed in as you. An action here can submit, purchase or delete.'}
        </span>
      </WarningCallout>

      <TrustOption>
        <Toggle on={trust} onChange={setTrust} data-testid="browser-act-trust" />
        <span>Don&apos;t ask again for this workspace this session</span>
      </TrustOption>

      <div className="flex items-center gap-[var(--space-2)]">
        <ConfirmationCountdown>
          denies in <Text as="span" tabular>{mmss(left)}</Text>
        </ConfirmationCountdown>
        <DecisionButton
          decision="deny"
          ref={denyButtonRef}
          type="button"
          onClick={() => onRespond(false)}
          disabled={busy}
        >
          Deny
        </DecisionButton>
        <DecisionButton
          decision="approve"
          type="button"
          onClick={() => onRespond(true)}
          disabled={busy}
        >
          Approve {copy.approve}
        </DecisionButton>
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
    <ConfirmationOverlay ref={containerRef}>
      <div className="absolute inset-0 overflow-hidden">
        <ConfirmationScreenshot
          src={shot}
          alt=""
          aria-hidden
        />
        <BrowserActSpotlight rect={box} label={request.element.ref} />
      </div>

      <ConfirmationCard
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label="Confirm browser action"
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
      </ConfirmationCard>
    </ConfirmationOverlay>
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
    <ConfirmationDialogBackdrop>
      <ConfirmationDialogPanel
        size="browser"
        surface="browser"
        animated={false}
        role="dialog"
        aria-modal="true"
        aria-label="Confirm browser action"
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
        <ConfirmationFootnote>
          The browser pane is not on screen, so this cannot show you the element in place — only
          describe it. Open the pane and retry if that matters for this action.
        </ConfirmationFootnote>
      </ConfirmationDialogPanel>
    </ConfirmationDialogBackdrop>
  )
}
