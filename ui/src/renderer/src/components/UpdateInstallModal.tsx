import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, DialogActions, DialogBackdrop, DialogBody, DialogPanel, DialogTitle } from './ui'
import { IconAlertTriangle, IconCheck, IconRefresh } from './icons'
import { Icon } from './ui/Icon'
import { useFocusRestore, useFocusTrap } from './dialogFocus'
import { daemonStatus, type ManageHandoff } from '../houston/manage'
import type { SessionInfo } from '../houston/generated/SessionInfo'
import type { UpdateRelease } from '../houston/generated/UpdateRelease'
import { summarizeReleaseNotes } from '../releaseNotes'
import {
  isUpdateInstallRunning,
  startUpdateInstall,
  useUpdateInstall,
  useUpdateInstallStopCount,
  type UpdateInstallState
} from '../updateInstall'

export type SessionChoice = 'keep' | 'stop'

type LiveStatus =
  | { kind: 'loading' }
  | { kind: 'ready'; ids: number[]; handoff: ManageHandoff }
  | { kind: 'error'; message: string }

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function sameIds(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  const left = [...a].sort((x, y) => x - y)
  const right = [...b].sort((x, y) => x - y)
  return left.every((id, i) => id === right[i])
}

/** Keep is only a choice while the daemon can hand sessions over and some are live. */
export function effectiveChoice(choice: SessionChoice, live: number, handoffSupported: boolean): SessionChoice {
  if (live > 0 && !handoffSupported) return 'stop'
  return choice
}

export interface InstallStep {
  key: string
  label: string
}

/** The steps an install walks, in order; the stop and move steps exist only when they apply. */
export function installSteps(stopCount: number, keptCount: number): InstallStep[] {
  const steps: InstallStep[] = [
    { key: 'download', label: 'Download' },
    { key: 'verify', label: 'Verify signature' }
  ]
  if (stopCount > 0) steps.push({ key: 'stop', label: `Stop ${plural(stopCount, 'session')}` })
  steps.push({ key: 'install', label: 'Install' }, { key: 'reopen', label: 'Reopen Houston' })
  if (keptCount > 0) {
    steps.push({ key: 'move', label: `Move ${plural(keptCount, 'session')} to the new daemon` })
  }
  return steps
}

/** Which step is running; every step before it is done, `steps.length` means all done. */
export function currentStepIndex(install: UpdateInstallState, steps: InstallStep[]): number {
  const at = (key: string): number => steps.findIndex((s) => s.key === key)
  switch (install.kind) {
    case 'downloading':
      return at('download')
    case 'verifying':
      return at('verify')
    case 'stopping':
      return at('stop')
    case 'installing':
      return at('install')
    case 'installed':
      return at('reopen')
    default:
      return -1
  }
}

function downloadPercent(install: UpdateInstallState): number | null {
  if (install.kind !== 'downloading') return null
  if (install.total === null || install.total <= 0) return null
  return Math.min(100, Math.floor((install.downloaded / install.total) * 100))
}

function sessionName(s: SessionInfo | undefined, id: number): string {
  if (!s) return `Session ${id}`
  return s.title || s.codename || `Session ${id}`
}

const CALLOUT_CLS =
  'grid grid-cols-[16px_minmax(0,1fr)] gap-[var(--space-2-5)] rounded-[var(--tr-radius-sm)] border p-[var(--space-3)] [font-size:var(--tr-text-small-size)] leading-[var(--tr-text-small-leading)] text-[var(--text-secondary)]'
const CALLOUT_WARN_CLS = `${CALLOUT_CLS} border-[color-mix(in_srgb,var(--warn)_45%,var(--border))] bg-[color-mix(in_srgb,var(--warn)_9%,var(--card-bg))]`
const CALLOUT_STOP_CLS = `${CALLOUT_CLS} border-[color-mix(in_srgb,var(--stop)_45%,var(--border))] bg-[color-mix(in_srgb,var(--stop)_8%,var(--card-bg))]`

const NOTES_CLS =
  'm-0 rounded-[var(--tr-radius-sm)] border border-[var(--divider)] bg-[var(--card-bg)] py-[var(--space-2-5)] px-[var(--space-3)] [font-size:var(--tr-text-small-size)] text-[var(--text-secondary)]'

const BULLET = /^\s*[-*•]\s+/

// Bullet lines become list items; any other summary keeps its own line breaks.
function ReleaseSummary({ summary }: { summary: string }): React.JSX.Element {
  const lines = summary.split('\n').filter((l) => l.trim() !== '')
  if (lines.length > 0 && lines.every((l) => BULLET.test(l))) {
    return (
      <ul
        data-testid="update-release-summary"
        className={`${NOTES_CLS} grid list-disc gap-[2px] pl-[var(--space-6)]`}
      >
        {lines.map((l, i) => (
          <li key={i} className="break-words">
            {l.replace(BULLET, '')}
          </li>
        ))}
      </ul>
    )
  }
  return (
    <div data-testid="update-release-summary" className={`${NOTES_CLS} whitespace-pre-wrap break-words`}>
      {summary}
    </div>
  )
}

const OPTION_CLS =
  'grid grid-cols-[18px_minmax(0,1fr)] gap-[var(--space-2-5)] rounded-[var(--tr-radius-md)] border p-[var(--space-3)] cursor-pointer bg-[var(--card-bg)] hover:border-[var(--border-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]'

// Literal class strings: Tailwind only generates classes it can read verbatim.
const RADIO_INK = {
  accent: {
    card: 'border-[color-mix(in_srgb,var(--accent)_55%,var(--border))] bg-[color-mix(in_srgb,var(--accent)_6%,var(--card-bg))]',
    ring: 'border-[var(--accent)]',
    dot: 'bg-[var(--accent)]'
  },
  stop: {
    card: 'border-[color-mix(in_srgb,var(--stop)_55%,var(--border))] bg-[color-mix(in_srgb,var(--stop)_6%,var(--card-bg))]',
    ring: 'border-[var(--stop)]',
    dot: 'bg-[var(--stop)]'
  }
} as const

// A drawn radio: a native one takes its box from the OS theme, never ours.
function RadioCard({
  choice,
  checked,
  tone,
  onSelect,
  title,
  desc
}: {
  choice: SessionChoice
  checked: boolean
  tone: 'accent' | 'stop'
  onSelect: () => void
  title: React.ReactNode
  desc: string
}): React.JSX.Element {
  const ink = RADIO_INK[tone]
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      data-choice={choice}
      tabIndex={checked ? 0 : -1}
      onClick={onSelect}
      className={`${OPTION_CLS} w-full whitespace-normal text-left ${checked ? ink.card : 'border-[var(--border)]'}`}
    >
      <span
        aria-hidden="true"
        className={`relative top-[2px] grid h-[16px] w-[16px] place-items-center rounded-full border-[1.5px] ${
          checked ? ink.ring : 'border-[var(--border-hover)]'
        }`}
      >
        {checked && <span className={`h-[8px] w-[8px] rounded-full ${ink.dot}`} />}
      </span>
      <span className="grid min-w-0 gap-[2px]">
        <span className="flex flex-wrap items-center gap-[var(--space-2)] font-semibold text-[var(--text-primary)]">
          {title}
        </span>
        <span className="text-[var(--text-secondary)] [font-size:var(--tr-text-small-size)]">
          {desc}
        </span>
      </span>
    </button>
  )
}

function Callout({
  tone,
  children
}: {
  tone: 'warn' | 'stop'
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      role={tone === 'stop' ? 'alert' : 'status'}
      className={tone === 'stop' ? CALLOUT_STOP_CLS : CALLOUT_WARN_CLS}
    >
      <span className={tone === 'stop' ? 'text-[var(--stop)]' : 'text-[var(--warn)]'}>
        <Icon glyph={IconAlertTriangle} role="ui" />
      </span>
      <div>{children}</div>
    </div>
  )
}

function SessionList({
  ids,
  sessions
}: {
  ids: number[]
  sessions: SessionInfo[]
}): React.JSX.Element {
  const byId = new Map(sessions.map((s) => [s.id, s]))
  return (
    <ul
      data-testid="update-session-list"
      className="m-0 list-none overflow-hidden rounded-[var(--tr-radius-sm)] border border-[var(--divider)] bg-[var(--card-bg)] p-0"
    >
      {ids.map((id) => {
        const s = byId.get(id)
        return (
          <li
            key={id}
            className="grid h-[32px] grid-cols-[minmax(0,1fr)_auto] items-center gap-[var(--space-2-5)] px-[var(--space-2-5)] [font-size:var(--tr-text-small-size)] [&:not(:first-child)]:border-t [&:not(:first-child)]:border-t-[var(--divider)]"
          >
            <span className="truncate text-[var(--text-primary)]">
              {sessionName(s, id)}
              {s && <span className="text-[var(--text-muted)]"> · {s.agent}</span>}
            </span>
            <span className="font-mono tabular-nums text-[var(--text-muted)]">#{id}</span>
          </li>
        )
      })}
    </ul>
  )
}

function StepList({
  steps,
  active,
  percent
}: {
  steps: InstallStep[]
  active: number
  percent: number | null
}): React.JSX.Element {
  return (
    <>
      <ol data-testid="update-steps" className="m-0 grid list-none gap-[var(--space-2-5)] p-0">
        {steps.map((step, i) => {
          const done = i < active
          const now = i === active
          return (
            <li
              key={step.key}
              data-state={done ? 'done' : now ? 'now' : 'todo'}
              aria-current={now ? 'step' : undefined}
              className={`grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-[var(--space-2-5)] ${
                now
                  ? 'font-semibold text-[var(--text-primary)]'
                  : done
                    ? 'text-[var(--text-secondary)]'
                    : 'text-[var(--text-muted)]'
              }`}
            >
              <span
                aria-hidden
                className={`grid h-[16px] w-[16px] place-items-center rounded-full border-[1.5px] ${
                  done
                    ? 'border-[var(--ok)] bg-[var(--ok)] text-white'
                    : now
                      ? 'border-[var(--accent)]'
                      : 'border-[var(--border-hover)]'
                }`}
              >
                {done && <Icon glyph={IconCheck} role="small" />}
              </span>
              <span>{step.label}</span>
              <span className="font-mono tabular-nums text-[var(--text-muted)] [font-size:var(--tr-text-small-size)]">
                {step.key === 'download' && now && percent !== null ? `${percent}%` : ''}
              </span>
            </li>
          )
        })}
      </ol>
      {active === 0 && (
        <div
          role="progressbar"
          aria-label="Download progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? undefined}
          className="h-[4px] overflow-hidden rounded-[var(--tr-radius-input)] bg-[var(--divider)]"
        >
          <div
            className="h-full bg-[var(--accent)] motion-safe:transition-[width]"
            style={{ width: `${percent ?? 0}%` }}
          />
        </div>
      )}
      <p className="m-0 text-[var(--text-secondary)] [font-size:var(--tr-text-small-size)]">
        The signature is checked against Houston&apos;s signing key before anything is installed.
      </p>
    </>
  )
}

interface Props {
  release: UpdateRelease
  currentVersion: string
  sessions: SessionInfo[]
  /** Close without dismissing the offer; an install in flight keeps running. */
  onClose: () => void
  /** Dismiss the offer like the About panel's Later, then close. */
  onLater: () => void
  onOpenExternal: (url: string) => void
}

export function UpdateInstallModal({
  release,
  currentVersion,
  sessions,
  onClose,
  onLater,
  onOpenExternal
}: Props): React.JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null)
  const laterRef = useRef<HTMLButtonElement>(null)
  const install = useUpdateInstall()
  const stopCount = useUpdateInstallStopCount()
  const [status, setStatus] = useState<LiveStatus>({ kind: 'loading' })
  const [choice, setChoice] = useState<SessionChoice>('keep')
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const version = release.version

  useFocusRestore(dialogRef, laterRef)
  const trapTab = useFocusTrap(dialogRef)

  const refresh = useCallback(async (): Promise<Exclude<LiveStatus, { kind: 'loading' }>> => {
    try {
      const s = await daemonStatus()
      return { kind: 'ready', ids: s.live_sessions.ids, handoff: s.handoff }
    } catch (err) {
      return { kind: 'error', message: err instanceof Error ? err.message : String(err) }
    }
  }, [])

  useEffect(() => {
    let alive = true
    void refresh().then((next) => {
      if (alive) setStatus(next)
    })
    return () => {
      alive = false
    }
  }, [refresh])

  const running = isUpdateInstallRunning(install) || (install.kind === 'installed' && install.version === version)
  const failed = install.kind === 'failed' && install.version === version ? install : null
  const ids = status.kind === 'ready' ? status.ids : []
  const live = ids.length
  const handoffSupported = status.kind === 'ready' && status.handoff.supported
  const mode = effectiveChoice(choice, live, handoffSupported)
  const stopMode = live > 0 && mode === 'stop'

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }
    trapTab(e)
  }

  const confirm = async (): Promise<void> => {
    if (status.kind !== 'ready') return
    setBusy(true)
    setNotice(null)
    try {
      if (!stopMode) {
        void startUpdateInstall(version, { mode: 'keep' })
        return
      }
      const fresh = await refresh()
      if (fresh.kind === 'error') {
        setNotice(`Could not confirm the running sessions, so nothing was stopped: ${fresh.message}`)
        return
      }
      if (!sameIds(fresh.ids, ids)) {
        setStatus(fresh)
        setNotice(
          `The running sessions changed while this was open: ${plural(fresh.ids.length, 'session')} ` +
            `now, ${plural(ids.length, 'session')} before. Review the list and confirm again; nothing was stopped.`
        )
        return
      }
      void startUpdateInstall(version, { mode: 'stop_all', expected: fresh.ids })
    } finally {
      setBusy(false)
    }
  }

  const steps = installSteps(stopCount, stopCount === 0 ? live : 0)
  const header = running ? `Installing Houston ${version}` : `Install Houston ${version}`
  const retry = (): void => {
    setStatus({ kind: 'loading' })
    void refresh().then(setStatus)
  }

  return (
    <DialogBackdrop onMouseDown={onClose}>
      <DialogPanel
        size="update"
        ref={dialogRef}
        data-testid="update-install-modal"
        role={stopMode ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby="update-install-h"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <DialogTitle id="update-install-h" layout="between">
          <span>{header}</span>
          <span className="rounded-[var(--tr-radius-sm)] border border-[var(--border)] px-[6px] py-[2px] font-mono text-[var(--text-muted)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)]">
            {currentVersion} → {version}
          </span>
        </DialogTitle>
        <DialogBody variant="plain" className="grid gap-[var(--space-3)] overflow-auto px-5 py-[18px]">
          {running ? (
            <StepList steps={steps} active={currentStepIndex(install, steps)} percent={downloadPercent(install)} />
          ) : (
            <OfferBody
              failed={failed}
              notes={release.notes}
              notice={notice}
              status={status}
              version={version}
              mode={mode}
              sessions={sessions}
              onChoose={setChoice}
            />
          )}
        </DialogBody>
        <DialogActions variant="plain" className="flex flex-wrap items-center justify-end gap-2 px-5 pb-5">
          {running ? (
            <>
              <span className="mr-auto text-[var(--text-muted)] [font-size:var(--tr-text-small-size)]">
                Houston reopens by itself when this finishes.
              </span>
              <Button
                ref={laterRef}
                type="button"
                data-testid="update-hide"
                variant="legacy-ghost"
                onClick={onClose}
              >
                Hide
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                data-testid="update-modal-notes"
                variant="legacy-ghost"
                className="mr-auto"
                onClick={() => onOpenExternal(release.notes_url)}
              >
                Release notes
              </Button>
              <Button
                ref={laterRef}
                type="button"
                data-testid="update-modal-later"
                variant="legacy-ghost"
                onClick={onLater}
              >
                Later
              </Button>
              <OfferAction
                status={status.kind}
                stopMode={stopMode}
                failed={failed !== null}
                live={live}
                busy={busy}
                onConfirm={() => void confirm()}
                onRetry={retry}
              />
            </>
          )}
        </DialogActions>
      </DialogPanel>
    </DialogBackdrop>
  )
}

type Failure = Extract<UpdateInstallState, { kind: 'failed' }>

function OfferBody({
  failed,
  notes,
  notice,
  status,
  version,
  mode,
  sessions,
  onChoose
}: {
  failed: Failure | null
  notes: string
  notice: string | null
  status: LiveStatus
  version: string
  mode: SessionChoice
  sessions: SessionInfo[]
  onChoose: (choice: SessionChoice) => void
}): React.JSX.Element {
  const summary = summarizeReleaseNotes(notes)
  return (
    <>
      {failed && (
        <Callout tone="stop">
          <b className="font-semibold text-[var(--text-primary)]">The last attempt did not install.</b>{' '}
          <span data-testid="update-failure">{failed.error}</span>
        </Callout>
      )}
      {summary !== null && <ReleaseSummary summary={summary} />}
      {notice !== null && <Callout tone="warn">{notice}</Callout>}
      {status.kind === 'loading' && (
        <p className="m-0 text-[var(--text-secondary)]">Checking which sessions are running…</p>
      )}
      {status.kind === 'error' && (
        <Callout tone="warn">
          Could not read the daemon&apos;s live sessions, so the choice cannot be shown: {status.message}
        </Callout>
      )}
      {status.kind === 'ready' && (
        <SessionsChoice status={status} version={version} mode={mode} sessions={sessions} onChoose={onChoose} />
      )}
    </>
  )
}

function SessionsChoice({
  status,
  version,
  mode,
  sessions,
  onChoose
}: {
  status: Extract<LiveStatus, { kind: 'ready' }>
  version: string
  mode: SessionChoice
  sessions: SessionInfo[]
  onChoose: (choice: SessionChoice) => void
}): React.JSX.Element {
  const live = status.ids.length
  if (live === 0) {
    return (
      <p className="m-0 text-[var(--text-secondary)] [font-size:var(--tr-text-body-size)] leading-relaxed">
        Houston closes, installs {version} and reopens. No sessions are running, so nothing is
        interrupted.
      </p>
    )
  }
  if (!status.handoff.supported) {
    return (
      <>
        <Callout tone="warn">
          <b className="font-semibold text-[var(--text-primary)]">This update has to stop every session.</b>{' '}
          The daemon cannot move sessions to the new build this time, so they cannot be kept running.
        </Callout>
        <SessionList ids={status.ids} sessions={sessions} />
        <details className="text-[var(--text-muted)] [font-size:var(--tr-text-small-size)]">
          <summary className="cursor-pointer">Why sessions cannot be kept</summary>
          <div className="pt-[var(--space-1)]">
            <code
              data-testid="update-handoff-reason"
              className="block whitespace-pre-wrap break-words rounded-[var(--tr-radius-sm)] bg-[var(--content-bg)] p-[var(--space-2)] font-mono text-[var(--text-secondary)]"
            >
              {status.handoff.reason}
            </code>
          </div>
        </details>
      </>
    )
  }
  const onArrow = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return
    e.preventDefault()
    const next = mode === 'keep' ? 'stop' : 'keep'
    onChoose(next)
    e.currentTarget.querySelector<HTMLElement>(`[data-choice="${next}"]`)?.focus()
  }
  return (
    <>
      <p className="m-0 text-[var(--text-secondary)] [font-size:var(--tr-text-body-size)] leading-relaxed">
        Houston closes and reopens on {version}. Choose what happens to your {plural(live, 'live session')}.
      </p>
      <div role="radiogroup" aria-label="Sessions during the update" className="grid gap-[var(--space-2)]" onKeyDown={onArrow}>
        <RadioCard
          choice="keep"
          checked={mode === 'keep'}
          tone="accent"
          onSelect={() => onChoose('keep')}
          title={
            <>
              Keep sessions running
              <span className="[font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] uppercase tracking-[0.1em] text-[var(--accent)]">
                Recommended
              </span>
            </>
          }
          desc="Agents keep working while Houston restarts. Sessions move to the new daemon; if that fails, they stay where they are."
        />
        <RadioCard
          choice="stop"
          checked={mode === 'stop'}
          tone="stop"
          onSelect={() => onChoose('stop')}
          title="Stop everything and update"
          desc={`Ends all ${live} sessions. Use it for a clean start.`}
        />
      </div>
      {mode === 'stop' && <SessionList ids={status.ids} sessions={sessions} />}
    </>
  )
}

function OfferAction({
  status,
  stopMode,
  failed,
  live,
  busy,
  onConfirm,
  onRetry
}: {
  status: LiveStatus['kind']
  stopMode: boolean
  failed: boolean
  live: number
  busy: boolean
  onConfirm: () => void
  onRetry: () => void
}): React.JSX.Element | null {
  if (status === 'error') {
    return (
      <Button type="button" variant="legacy-primary" onClick={onRetry}>
        Check again
      </Button>
    )
  }
  if (status !== 'ready') return null
  if (stopMode) {
    return (
      <Button
        type="button"
        data-testid="update-confirm-stop"
        variant="legacy-danger-solid"
        disabled={busy}
        onClick={onConfirm}
      >
        <><Icon glyph={IconAlertTriangle} role="ui" />{`Stop ${plural(live, 'session')} and ${failed ? 'try again' : 'install'}`}</>
      </Button>
    )
  }
  return (
    <Button
      type="button"
      data-testid="update-confirm-keep"
      variant="legacy-primary"
      disabled={busy}
      onClick={onConfirm}
    >
      <><Icon glyph={IconRefresh} role="ui" />{failed ? 'Try again' : 'Install and reopen'}</>
    </Button>
  )
}
