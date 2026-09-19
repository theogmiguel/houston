import { Fragment, useEffect, useRef, useState } from 'react'
import { BTN_GHOST, BTN_GHOST_DANGER_ARM, BTN_GHOST_DANGER_HOVER, BTN_ICO } from './buttonChrome'
import { IconAlertTriangle, IconCheck, IconChevronDown, IconCopy, type IconComponent } from './icons'
import { Tooltip } from './Tooltip'
import { Icon } from './Icon'
import { MODAL_SCRIM_CLS } from './overlayChrome'
import { useFocusRestore, useFocusTrap } from './dialogFocus'
import { useCopyFeedback, type CopyFeedbackState } from './useCopyFeedback'

export interface HostKeyPrompt {
  request: number
  host: string
  port: number
  algorithm: string
  fingerprint: string
  randomart: string
  changed: boolean
  previous_fingerprint?: string | null
}

export function splitFingerprint(fingerprint: string): { prefix: string; digest: string } {
  const i = fingerprint.indexOf(':')
  if (i === -1) return { prefix: '', digest: fingerprint }
  return { prefix: fingerprint.slice(0, i + 1), digest: fingerprint.slice(i + 1) }
}

export function groupDigest(digest: string, groupSize = 4): string[] {
  const groups: string[] = []
  for (let i = 0; i < digest.length; i += groupSize) {
    groups.push(digest.slice(i, i + groupSize))
  }
  return groups
}

export function enqueueHostKey(
  queue: HostKeyPrompt[],
  prompt: HostKeyPrompt
): HostKeyPrompt[] {
  if (queue.some((p) => p.request === prompt.request)) return queue
  return [...queue, prompt]
}

export function planRejectRemaining(queue: HostKeyPrompt[]): {
  toReject: HostKeyPrompt[]
} {
  const [, ...rest] = queue
  return { toReject: rest }
}

export function removeHostKeys(queue: HostKeyPrompt[], ids: number[]): HostKeyPrompt[] {
  const idSet = new Set(ids)
  return queue.filter((p) => !idSet.has(p.request))
}

interface Props {
  prompt: HostKeyPrompt
  onAnswer: (accept: boolean) => void
  remaining?: number
  onRejectRemaining?: () => void
}

const CHANGED_COUNTDOWN_S = 3

function copyButtonChrome(state: CopyFeedbackState): { label: string; icon: IconComponent; warn: boolean } {
  if (state === 'success') return { label: 'Copy fingerprint', icon: IconCheck, warn: false }
  if (state === 'error') return { label: 'Copy failed', icon: IconAlertTriangle, warn: true }
  return { label: 'Copy fingerprint', icon: IconCopy, warn: false }
}

export function HostKeyModal({
  prompt,
  onAnswer,
  remaining = 0,
  onRejectRemaining
}: Props): React.JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null)
  const rejectRef = useRef<HTMLButtonElement>(null)
  const acceptRef = useRef<HTMLButtonElement>(null)
  const [countdown, setCountdown] = useState(prompt.changed ? CHANGED_COUNTDOWN_S : 0)
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const { copyState, copy } = useCopyFeedback()
  const [showRandomart, setShowRandomart] = useState(false)
  const [showExplainer, setShowExplainer] = useState(false)

  useFocusRestore(dialogRef, rejectRef)
  const trapTab = useFocusTrap(dialogRef)

  const handleCopyFingerprint = (): void => copy(prompt.fingerprint)

  useEffect(() => {
    clearInterval(timerRef.current)
    if (!prompt.changed) {
      setCountdown(0)
      return
    }
    setCountdown(CHANGED_COUNTDOWN_S)
    timerRef.current = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          clearInterval(timerRef.current)
          return 0
        }
        return c - 1
      })
    }, 1000)
    return () => clearInterval(timerRef.current)
  }, [prompt.request, prompt.changed])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onAnswer(false)
      return
    }
    const target = e.target instanceof HTMLElement ? e.target.closest('button') : null
    if (e.key === 'Enter' && (target === null || target === acceptRef.current)) {
      e.preventDefault()
      return
    }
    trapTab(e)
  }

  const field = 'flex flex-col gap-[5px]'
  const acceptDisabled = prompt.changed && countdown > 0
  const { prefix: fingerprintPrefix, digest: fingerprintDigest } = splitFingerprint(prompt.fingerprint)
  const fingerprintGroups = groupDigest(fingerprintDigest)
  const copyChrome = copyButtonChrome(copyState)

  return (
    <div
      className={MODAL_SCRIM_CLS}
      onMouseDown={() => onAnswer(false)}
    >
      <div
        ref={dialogRef}
        className="pop w-[460px] max-w-[92vw] bg-[var(--raised)] border border-[var(--border)] rounded-[var(--tr-radius-md)] shadow-[var(--shadow-2,0_24px_64px_rgba(0,0,0,0.55),0_2px_8px_rgba(0,0,0,0.4))] motion-safe:animate-[panel-in_var(--animate-t-panel)_var(--animate-ease-panel)] [.anim-out_&]:motion-safe:animate-[panel-out_var(--animate-t-fast)_var(--animate-ease-panel)_forwards]"
        role={prompt.changed ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby="hostkey-modal-h"
        aria-describedby="hostkey-modal-msg"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div
          className="flex items-baseline justify-between gap-2 px-3.5 py-[11px] border-b border-border [font-size:var(--tr-text-subhead-size)] [font-weight:var(--tr-text-subhead-weight)] [letter-spacing:var(--tr-text-subhead-tracking)] text-text-primary"
          id="hostkey-modal-h"
        >
          <span>
            Verify host key for {prompt.host}:{prompt.port}
          </span>
          {remaining > 0 && (
            <span className="text-text-secondary font-semibold whitespace-nowrap">
              1 of {remaining + 1}
            </span>
          )}
        </div>
        <div className="p-5 space-y-4" id="hostkey-modal-msg">
          {prompt.changed && (
            <div
              className="p-3 rounded-lg bg-danger/10 border border-danger/20 [font-size:var(--tr-text-body-size)] [font-weight:var(--tr-text-body-weight)] text-danger leading-relaxed space-y-2"
              role="alert"
            >
              The host key has CHANGED since you last connected. This could indicate a
              man-in-the-middle attack.
            </div>
          )}
          {prompt.changed && prompt.previous_fingerprint && (
            <div
              data-testid="hostkey-previous-fingerprint"
              className="p-3 rounded-lg bg-danger/10 border border-danger/20 space-y-1"
            >
              <div className="text-text-muted [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] uppercase">
                Previously known fingerprint
              </div>
              <del
                className="block font-mono [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-danger line-through break-all select-all"
                aria-label={`Previous fingerprint, no longer trusted: ${prompt.previous_fingerprint}`}
              >
                {prompt.previous_fingerprint}
              </del>
            </div>
          )}
          <div className={field}>
            <label className="block text-text-muted [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] uppercase">
              Algorithm
            </label>
            <div className="font-mono [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-text-secondary break-all">{prompt.algorithm}</div>
          </div>
          <div className={field}>
            <div className="flex items-center justify-between">
              <label className="block text-text-muted [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] uppercase">
                Fingerprint
              </label>
              <Tooltip label={copyChrome.label}>
                <button
                  type="button"
                  data-testid="hostkey-copy"
                  data-copy-state={copyState}
                  className={`btn ${BTN_ICO} ${copyChrome.warn ? 'text-warning hover:text-warning' : ''}`}
                  aria-label={copyChrome.label}
                  onClick={handleCopyFingerprint}
                >
                  <Icon glyph={copyChrome.icon} role="small" />
                </button>
              </Tooltip>
            </div>
            <code
              data-testid="hostkey-fingerprint"
              className="block font-mono [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-text-secondary break-normal select-all"
            >
              <span className="text-text-muted">{fingerprintPrefix}</span>
              {fingerprintGroups.map((g, i) => (
                <Fragment key={i}>
                  <span className="whitespace-nowrap">{g}</span>
                  {i < fingerprintGroups.length - 1 ? ' ' : ''}
                </Fragment>
              ))}
            </code>
            {copyState === 'error' && (
              <p className="text-warning [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)]">
                Copy failed. Select the fingerprint manually.
              </p>
            )}
          </div>
          <div className={field}>
            <div className="flex items-center justify-between">
              <label className="block text-text-muted [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] uppercase">
                Randomart
              </label>
              <button
                type="button"
                data-testid="hostkey-randomart-toggle"
                className={`btn ${BTN_GHOST} px-2 py-1 [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] inline-flex items-center gap-1`}
                aria-expanded={showRandomart}
                aria-controls="host-key-art"
                onClick={() => setShowRandomart((v) => !v)}
              >
                <Icon glyph={IconChevronDown} role="label" />
                {showRandomart ? 'Hide' : 'Show'} visual fingerprint
              </button>
            </div>
            <pre
              id="host-key-art"
              aria-label="Visual host key fingerprint"
              hidden={!showRandomart}
              className="m-0 bg-[var(--tool-code-bg)] border border-border rounded-[var(--tr-radius-sm)] px-2.5 py-2 font-mono [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] leading-[1.1] whitespace-pre overflow-x-auto text-text-secondary"
            >
              {prompt.randomart}
            </pre>
          </div>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              data-testid="hostkey-explainer-toggle"
              className={`btn ${BTN_GHOST} px-2 py-1 [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] inline-flex items-center gap-1`}
              aria-expanded={showExplainer}
              aria-controls="host-key-explainer"
              onClick={() => setShowExplainer((v) => !v)}
            >
              <Icon glyph={IconChevronDown} role="label" />
              {showExplainer ? 'Hide' : 'What is a host key?'}
            </button>
            <p
              id="host-key-explainer"
              hidden={!showExplainer}
              className="text-text-secondary [font-size:var(--tr-text-body-size)] [font-weight:var(--tr-text-body-weight)] leading-relaxed"
            >
              A host key is how an SSH server proves it&apos;s the same machine you connected to
              before. The first time you connect there&apos;s no way to be fully certain, so
              accepting the key trusts this server going forward. If the key ever changes
              unexpectedly, it can mean the server was reinstalled — or it can mean someone is
              intercepting the connection, which is why a changed key gets a harder warning above.
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-2 px-5 pb-5">
          {remaining > 0 && onRejectRemaining && (
            <button type="button" className={`btn ${BTN_GHOST} self-start`} onClick={onRejectRemaining}>
              Reject all remaining ({remaining})
            </button>
          )}
          <div className="flex gap-2 justify-end">
            <button
              ref={rejectRef}
              type="button"
              className={`btn ${BTN_GHOST}`}
              data-testid="hostkey-reject"
              onClick={() => onAnswer(false)}
            >
              Reject
            </button>
            <button
              ref={acceptRef}
              type="button"
              className={`btn ${BTN_GHOST} ${prompt.changed ? `${BTN_GHOST_DANGER_HOVER} ${BTN_GHOST_DANGER_ARM}` : ''}`}
              disabled={acceptDisabled}
              onClick={() => onAnswer(true)}
            >
              {prompt.changed
                ? acceptDisabled
                  ? <>Accept anyway (<span className="tabular-nums">{countdown}</span>)</>
                  : 'Accept anyway'
                : 'Accept'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

interface HostProps {
  queue: HostKeyPrompt[]
  onAnswer: (accept: boolean) => void
  onRejectRemaining: () => void
}

export function HostKeyModalHost({
  queue,
  onAnswer,
  onRejectRemaining
}: HostProps): React.JSX.Element | null {
  const prompt = queue[0] ?? null
  if (!prompt) return null
  return (
    <HostKeyModal
      key={prompt.request}
      prompt={prompt}
      onAnswer={onAnswer}
      remaining={queue.length - 1}
      onRejectRemaining={onRejectRemaining}
    />
  )
}
