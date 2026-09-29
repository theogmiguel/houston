import { useCallback, useEffect, useRef, useState } from 'react'
import { BTN_DANGER_SOLID, BTN_GHOST, BTN_PRIMARY } from './buttonChrome'
import { MODAL_SCRIM_CLS } from './overlayChrome'
import { IconAlertTriangle, IconCheck, IconRefresh } from './icons'
import { Icon } from './Icon'
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
  'm-0 list-disc rounded-[var(--tr-radius-sm)] border border-[var(--divider)] bg-[var(--card-bg)] py-[var(--space-2-5)] pr-[var(--space-3)] pl-[var(--space-6)] [font-size:var(--tr-text-small-size)] text-[var(--text-secondary)]'

const OPTION_CLS =
  'grid grid-cols-[18px_minmax(0,1fr)] gap-[var(--space-2-5)] rounded-[var(--tr-radius-md)] border p-[var(--space-3)] cursor-pointer bg-[var(--card-bg)] hover:border-[var(--border-hover)] focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--accent)]'

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
      className="m-0 list-none overflow-hidden rounded-[var(--tr-radius-sm)] border border-[var(--divider)] p-0"
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
          className="h-[4px] overflow-hidden rounded-[4px] bg-[var(--divider)]"
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
  const stepIndex = currentStepIndex(install, steps)
  const header = running ? `Installing Houston ${version}` : `Install Houston ${version}`

  let body: React.ReactNode
  let action: React.ReactNode = null
  if (running) {
    body = <StepList steps={steps} active={stepIndex} percent={downloadPercent(install)} />
  } else {
    const summary = summarizeReleaseNotes(release.notes)
    const actionLabel = (base: string): string => (failed ? 'Try again' : base)
    const stopLabel = failed
      ? `Stop ${plural(live, 'session')} and try again`
      : `Stop ${plural(live, 'session')} and install`
    body = (
      <>
        {failed && (
          <Callout tone="stop">
            <b className="font-semibold text-[var(--text-primary)]">The last attempt did not install.</b>{' '}
            <span data-testid="update-failure">{failed.error}</span>
          </Callout>
        )}
        {summary !== null && (
          <div
            data-testid="update-release-summary"
            className={`${NOTES_CLS} whitespace-pre-wrap break-words`}
          >
            {summary}
          </div>
        )}
        {notice !== null && <Callout tone="warn">{notice}</Callout>}
        {status.kind === 'loading' && (
          <p className="m-0 text-[var(--text-secondary)]">Checking which sessions are running…</p>
        )}
        {status.kind === 'error' && (
          <Callout tone="warn">
            Could not read the daemon&apos;s live sessions, so the choice cannot be shown: {status.message}
          </Callout>
        )}
        {status.kind === 'ready' && live === 0 && (
          <p className="m-0 text-[var(--text-secondary)] [font-size:var(--tr-text-body-size)] leading-relaxed">
            Houston closes, installs {version} and reopens. No sessions are running, so nothing is
            interrupted.
          </p>
        )}
        {status.kind === 'ready' && live > 0 && !handoffSupported && (
          <>
            <Callout tone="warn">
              <b className="font-semibold text-[var(--text-primary)]">
                This update has to stop every session.
              </b>{' '}
              The daemon cannot move sessions to the new build this time, so they cannot be kept
              running.
            </Callout>
            <SessionList ids={ids} sessions={sessions} />
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
        )}
        {status.kind === 'ready' && live > 0 && handoffSupported && (
          <>
            <p className="m-0 text-[var(--text-secondary)] [font-size:var(--tr-text-body-size)] leading-relaxed">
              Houston closes and reopens on {version}. Choose what happens to your{' '}
              {plural(live, 'live session')}.
            </p>
            <div role="radiogroup" aria-label="Sessions during the update" className="grid gap-[var(--space-2)]">
              <label
                className={`${OPTION_CLS} ${
                  mode === 'keep'
                    ? 'border-[color-mix(in_srgb,var(--accent)_55%,var(--border))] bg-[color-mix(in_srgb,var(--accent)_6%,var(--card-bg))]'
                    : 'border-[var(--border)]'
                }`}
              >
                <input
                  type="radio"
                  name="update-sessions"
                  value="keep"
                  checked={mode === 'keep'}
                  onChange={() => setChoice('keep')}
                  className="relative top-[2px] accent-[var(--accent)]"
                />
                <span className="grid gap-[2px]">
                  <span className="flex flex-wrap items-center gap-[var(--space-2)] font-semibold text-[var(--text-primary)]">
                    Keep sessions running
                    <span className="[font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] uppercase tracking-[0.1em] text-[var(--accent)]">
                      Recommended
                    </span>
                  </span>
                  <span className="text-[var(--text-secondary)] [font-size:var(--tr-text-small-size)]">
                    Agents keep working while Houston restarts. Sessions move to the new daemon; if
                    that fails, they stay where they are.
                  </span>
                </span>
              </label>
              <label
                className={`${OPTION_CLS} ${
                  mode === 'stop'
                    ? 'border-[color-mix(in_srgb,var(--stop)_55%,var(--border))] bg-[color-mix(in_srgb,var(--stop)_6%,var(--card-bg))]'
                    : 'border-[var(--border)]'
                }`}
              >
                <input
                  type="radio"
                  name="update-sessions"
                  value="stop"
                  checked={mode === 'stop'}
                  onChange={() => setChoice('stop')}
                  className="relative top-[2px] accent-[var(--stop)]"
                />
                <span className="grid gap-[2px]">
                  <span className="font-semibold text-[var(--text-primary)]">
                    Stop everything and update
                  </span>
                  <span className="text-[var(--text-secondary)] [font-size:var(--tr-text-small-size)]">
                    Ends all {live} sessions. Use it for a clean start.
                  </span>
                </span>
              </label>
            </div>
            {mode === 'stop' && <SessionList ids={ids} sessions={sessions} />}
          </>
        )}
      </>
    )
    if (status.kind === 'ready') {
      action = stopMode ? (
        <button
          type="button"
          data-testid="update-confirm-stop"
          className={`btn ${BTN_DANGER_SOLID} inline-flex items-center gap-[var(--space-1-5)]`}
          disabled={busy}
          onClick={() => void confirm()}
        >
          <Icon glyph={IconAlertTriangle} role="ui" />
          {stopLabel}
        </button>
      ) : (
        <button
          type="button"
          data-testid="update-confirm-keep"
          className={`btn ${BTN_PRIMARY} inline-flex items-center gap-[var(--space-1-5)]`}
          disabled={busy}
          onClick={() => void confirm()}
        >
          <Icon glyph={IconRefresh} role="ui" />
          {actionLabel('Install and reopen')}
        </button>
      )
    } else if (status.kind === 'error') {
      action = (
        <button
          type="button"
          className={`btn ${BTN_PRIMARY}`}
          onClick={() => {
            setStatus({ kind: 'loading' })
            void refresh().then(setStatus)
          }}
        >
          Check again
        </button>
      )
    }
  }

  return (
    <div className={MODAL_SCRIM_CLS} onMouseDown={onClose}>
      <div
        ref={dialogRef}
        data-testid="update-install-modal"
        className="pop flex max-h-[92vh] w-[460px] max-w-[92vw] flex-col bg-[var(--raised)] border border-[var(--border)] rounded-[var(--tr-radius-md)] shadow-[var(--shadow-2,0_24px_64px_rgba(0,0,0,0.55),0_2px_8px_rgba(0,0,0,0.4))] motion-safe:animate-[panel-in_var(--animate-t-panel)_var(--animate-ease-panel)] [.anim-out_&]:motion-safe:animate-[panel-out_var(--animate-t-fast)_var(--animate-ease-panel)_forwards]"
        role={stopMode ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby="update-install-h"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div
          id="update-install-h"
          className="flex items-center justify-between gap-3 border-b border-border px-3.5 py-[11px] [font-size:var(--tr-text-subhead-size)] [font-weight:var(--tr-text-subhead-weight)] [letter-spacing:var(--tr-text-subhead-tracking)] text-text-primary"
        >
          <span>{header}</span>
          <span className="rounded-[var(--tr-radius-sm)] border border-[var(--border)] px-[6px] py-[2px] font-mono text-[var(--text-muted)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)]">
            {currentVersion} → {version}
          </span>
        </div>
        <div className="grid gap-[var(--space-3)] overflow-auto px-5 py-[18px]">{body}</div>
        <div className="flex flex-wrap items-center justify-end gap-2 px-5 pb-5">
          {running ? (
            <>
              <span className="mr-auto text-[var(--text-muted)] [font-size:var(--tr-text-small-size)]">
                Houston reopens by itself when this finishes.
              </span>
              <button
                ref={laterRef}
                type="button"
                data-testid="update-hide"
                className={`btn ${BTN_GHOST}`}
                onClick={onClose}
              >
                Hide
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                data-testid="update-modal-notes"
                className={`btn ${BTN_GHOST} mr-auto`}
                onClick={() => onOpenExternal(release.notes_url)}
              >
                Release notes
              </button>
              <button
                ref={laterRef}
                type="button"
                data-testid="update-modal-later"
                className={`btn ${BTN_GHOST}`}
                onClick={onLater}
              >
                Later
              </button>
              {action}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
