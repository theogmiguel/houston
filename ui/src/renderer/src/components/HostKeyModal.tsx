import { Fragment, useEffect, useRef, useState } from 'react'
import { IconAlertTriangle, IconCheck, IconChevronDown, IconCopy, type IconComponent } from './icons'
import { Tooltip } from './ui/Tooltip'
import { Icon } from './ui/Icon'
import { Button, DangerPanel, DialogActions, DialogBackdrop, DialogBody, DialogDescription, DialogPanel, DialogTitle, InlineText, MonoBlock, Stack, Text } from './ui'
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

  const acceptDisabled = prompt.changed && countdown > 0
  const { prefix: fingerprintPrefix, digest: fingerprintDigest } = splitFingerprint(prompt.fingerprint)
  const fingerprintGroups = groupDigest(fingerprintDigest)
  const copyChrome = copyButtonChrome(copyState)

  return (
    <DialogBackdrop onMouseDown={() => onAnswer(false)}>
      <DialogPanel
        size="hostKey"
        ref={dialogRef}
        surface="raised"
        role={prompt.changed ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby="hostkey-modal-h"
        aria-describedby="hostkey-modal-msg"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <DialogTitle id="hostkey-modal-h" layout="baseline-between">
          <span>
            Verify host key for {prompt.host}:{prompt.port}
          </span>
          {remaining > 0 && <InlineText tone="secondary" weight="semibold">1 of {remaining + 1}</InlineText>}
        </DialogTitle>
        <DialogBody id="hostkey-modal-msg">
          {prompt.changed && (
            <DangerPanel variant="alert" role="alert">
              The host key has CHANGED since you last connected. This could indicate a
              man-in-the-middle attack.
            </DangerPanel>
          )}
          {prompt.changed && prompt.previous_fingerprint && (
            <DangerPanel variant="detail" data-testid="hostkey-previous-fingerprint">
              <Text as="div" size="label" weight="label" tone="muted">Previously known fingerprint</Text>
              <MonoBlock
                variant="struck"
                aria-label={`Previous fingerprint, no longer trusted: ${prompt.previous_fingerprint}`}
              >
                {prompt.previous_fingerprint}
              </MonoBlock>
            </DangerPanel>
          )}
          <Stack gap="field">
            <Text as="label" size="label" weight="label" tone="muted">Algorithm</Text>
            <MonoBlock variant="algorithm">{prompt.algorithm}</MonoBlock>
          </Stack>
          <Stack gap="field">
            <div className="flex items-center justify-between">
              <Text as="label" size="label" weight="label" tone="muted">Fingerprint</Text>
              <Tooltip label={copyChrome.label}>
                <Button
                  type="button"
                  data-testid="hostkey-copy"
                  data-copy-state={copyState}
                  variant={copyChrome.warn ? 'legacy-icon-warning' : 'legacy-icon'}
                  aria-label={copyChrome.label}
                  onClick={handleCopyFingerprint}
                >
                  <Icon glyph={copyChrome.icon} role="small" />
                </Button>
              </Tooltip>
            </div>
            <MonoBlock variant="fingerprint" data-testid="hostkey-fingerprint">
              <Text tone="muted">{fingerprintPrefix}</Text>
              {fingerprintGroups.map((g, i) => (
                <Fragment key={i}>
                  <InlineText>{g}</InlineText>
                  {i < fingerprintGroups.length - 1 ? ' ' : ''}
                </Fragment>
              ))}
            </MonoBlock>
            {copyState === 'error' && (
              <Text as="p" size="small" weight="small" tone="warning">
                Copy failed. Select the fingerprint manually.
              </Text>
            )}
          </Stack>
          <Stack gap="field">
            <div className="flex items-center justify-between">
              <Text as="label" size="label" weight="label" tone="muted">Randomart</Text>
              <Button
                type="button"
                data-testid="hostkey-randomart-toggle"
                variant="legacy-ghost-compact"
                aria-expanded={showRandomart}
                aria-controls="host-key-art"
                onClick={() => setShowRandomart((v) => !v)}
              >
                <Icon glyph={IconChevronDown} role="label" />
                {showRandomart ? 'Hide' : 'Show'} visual fingerprint
              </Button>
            </div>
            <MonoBlock
              variant="art"
              id="host-key-art"
              aria-label="Visual host key fingerprint"
              hidden={!showRandomart}
            >
              {prompt.randomart}
            </MonoBlock>
          </Stack>
          <Stack gap={2}>
            <Button
              type="button"
              data-testid="hostkey-explainer-toggle"
              variant="legacy-ghost-compact"
              className="self-start"
              aria-expanded={showExplainer}
              aria-controls="host-key-explainer"
              onClick={() => setShowExplainer((v) => !v)}
            >
              <Icon glyph={IconChevronDown} role="label" />
              {showExplainer ? 'Hide' : 'What is a host key?'}
            </Button>
            <DialogDescription id="host-key-explainer" hidden={!showExplainer}>
              A host key is how an SSH server proves it&apos;s the same machine you connected to
              before. The first time you connect there&apos;s no way to be fully certain, so
              accepting the key trusts this server going forward. If the key ever changes
              unexpectedly, it can mean the server was reinstalled — or it can mean someone is
              intercepting the connection, which is why a changed key gets a harder warning above.
            </DialogDescription>
          </Stack>
        </DialogBody>
        <DialogActions variant="stack">
          {remaining > 0 && onRejectRemaining && (
            <Button type="button" variant="legacy-ghost" className="self-start" onClick={onRejectRemaining}>
              Reject all remaining ({remaining})
            </Button>
          )}
          <div className="flex gap-[var(--space-2)] justify-end">
            <Button
              ref={rejectRef}
              type="button"
              variant="legacy-ghost"
              data-testid="hostkey-reject"
              onClick={() => onAnswer(false)}
            >
              Reject
            </Button>
            <Button
              ref={acceptRef}
              type="button"
              variant={prompt.changed ? 'legacy-danger' : 'legacy-ghost'}
              armed={prompt.changed}
              disabled={acceptDisabled}
              onClick={() => onAnswer(true)}
            >
              {prompt.changed
                ? acceptDisabled
                  ? <>Accept anyway (<Text tabular>{countdown}</Text>)</>
                  : 'Accept anyway'
                : 'Accept'}
            </Button>
          </div>
        </DialogActions>
      </DialogPanel>
    </DialogBackdrop>
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
