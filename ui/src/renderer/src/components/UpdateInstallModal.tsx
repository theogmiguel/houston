import { MascotSurfaceMount } from '../mascot/MascotMount'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Callout, ChoiceCard, DetailsNote, DialogActions, DialogBackdrop, DialogBody, DialogDescription, DialogPanel, DialogTitle, InsetList, InsetRow, MonoBlock, NotesItem, NotesPanel, ProgressBar, ProgressSteps, Text, VersionTag } from './ui'
import { IconAlertTriangle, IconRefresh } from './icons'
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

const BULLET = /^\s*[-*•]\s+/

// Bullet lines become list items; any other summary keeps its own line breaks.
function ReleaseSummary({ summary }: { summary: string }): React.JSX.Element {
  const lines = summary.split('\n').filter((l) => l.trim() !== '')
  if (lines.length > 0 && lines.every((l) => BULLET.test(l))) {
    return (
      <NotesPanel list data-testid="update-release-summary">
        {lines.map((l, i) => (
          <NotesItem key={i}>{l.replace(BULLET, '')}</NotesItem>
        ))}
      </NotesPanel>
    )
  }
  return <NotesPanel data-testid="update-release-summary">{summary}</NotesPanel>
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
    <InsetList data-testid="update-session-list">
      {ids.map((id) => {
        const s = byId.get(id)
        return (
          <InsetRow
            key={id}
            primary={
              <>
                {sessionName(s, id)}
                {s && <Text tone="muted"> · {s.agent}</Text>}
              </>
            }
            trailing={`#${id}`}
          />
        )
      })}
    </InsetList>
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
      <ProgressSteps
        data-testid="update-steps"
        steps={steps.map((step, i) => ({
          key: step.key,
          label: step.label,
          state: i < active ? 'done' : i === active ? 'now' : 'todo',
          trailing: step.key === 'download' && i === active && percent !== null ? `${percent}%` : ''
        }))}
      />
      {active === 0 && <ProgressBar percent={percent} label="Download progress" />}
      <Text as="p" size="small" tone="secondary" flush>
        The signature is checked against Houston&apos;s signing key before anything is installed.
      </Text>
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
          <Text size="subhead" weight="semibold" tone="primary" className="flex-1">{header}</Text>
          <VersionTag>
            {currentVersion} → {version}
          </VersionTag>
        </DialogTitle>
        <DialogBody variant="stacked">
          {!running && <MascotSurfaceMount mood="party" />}
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
        <DialogActions variant="wrap">
          {running ? (
            <>
              <Text size="small" tone="muted" className="flex-1">
                Houston reopens by itself when this finishes.
              </Text>
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
                onClick={() => onOpenExternal(release.notes_url)}
              >
                Release notes
              </Button>
              <span className="flex-1" />
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
          <Text as="b" weight="semibold" tone="primary">The last attempt did not install.</Text>{' '}
          <span data-testid="update-failure">{failed.error}</span>
        </Callout>
      )}
      {summary !== null && <ReleaseSummary summary={summary} />}
      {notice !== null && <Callout tone="warn">{notice}</Callout>}
      {status.kind === 'loading' && (
        <Text as="p" tone="secondary" flush>Checking which sessions are running…</Text>
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
      <DialogDescription as="p">
        Houston closes, installs {version} and reopens. No sessions are running, so nothing is
        interrupted.
      </DialogDescription>
    )
  }
  if (!status.handoff.supported) {
    return (
      <>
        <Callout tone="warn">
          <Text as="b" weight="semibold" tone="primary">This update has to stop every session.</Text>{' '}
          The daemon cannot move sessions to the new build this time, so they cannot be kept running.
        </Callout>
        <SessionList ids={status.ids} sessions={sessions} />
        <DetailsNote summary="Why sessions cannot be kept">
          <MonoBlock variant="reason" data-testid="update-handoff-reason">
            {status.handoff.reason}
          </MonoBlock>
        </DetailsNote>
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
      <DialogDescription as="p">
        Houston closes and reopens on {version}. Choose what happens to your {plural(live, 'live session')}.
      </DialogDescription>
      <div role="radiogroup" aria-label="Sessions during the update" className="grid gap-[var(--space-2)]" onKeyDown={onArrow}>
        <ChoiceCard
          choice="keep"
          checked={mode === 'keep'}
          tone="accent"
          onSelect={() => onChoose('keep')}
          title="Keep sessions running"
          badge="Recommended"
          desc="Agents keep working while Houston restarts. Sessions move to the new daemon; if that fails, they stay where they are."
        />
        <ChoiceCard
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
