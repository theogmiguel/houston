import { useState } from 'react'
import type { HoustonClient, SessionInfo } from '../houston/client'
import { isLive } from '../houston/client'
import { ConfirmModal } from './ConfirmModal'
import { IconHistory, IconRespawn, type IconComponent } from './icons'
import { PaneFooterNotice } from './ui/PaneFooterNotice'
import { usePaneOpState } from '../houston/paneOpsContext'
import { recoveryReason } from './recoveryReason'

export type RestartMode = 'restart' | 'resume' | 'fresh'

const COPY: Record<RestartMode, { label: string; message: (title: string) => string }> = {
  restart: {
    label: 'Restart',
    message: (title) =>
      `Restart ${title}? The CLI running in this pane is killed and started fresh in the same directory — anything it has not written to disk is lost.`
  },
  resume: {
    label: 'Resume conversation',
    message: (title) =>
      `Restart ${title} in the same conversation? The CLI running in this pane is killed and reopened on the conversation it was running — anything it has not written to disk is lost.`
  },
  fresh: {
    label: 'Start fresh',
    message: (title) =>
      `Restart ${title} fresh? The CLI running in this pane is killed and a fresh CLI starts in the same directory, without this conversation — anything it has not written to disk is lost.`
  }
}

export interface RestartEntry {
  glyph: IconComponent
  label: string
  run: () => void
}

function recoveryHusk(info: SessionInfo, live: boolean): boolean {
  return !live && (info.restore_deferred != null || info.resume_notice != null)
}

/** The pane menu's Restart rows. A live pane confirms first; an ended one restarts at once. */
export function restartEntries({
  info,
  live,
  client,
  shellIntegration,
  confirm,
  reconnect
}: {
  info: SessionInfo
  live: boolean
  client: HoustonClient
  shellIntegration: boolean
  confirm: (mode: RestartMode) => void
  reconnect: () => void
}): RestartEntry[] {
  if (info.agent === 'ssh' && !live) {
    return [{ glyph: IconRespawn, label: 'Reconnect…', run: reconnect }]
  }
  const entry = (glyph: IconComponent, mode: RestartMode): RestartEntry => ({
    glyph,
    label: COPY[mode].label,
    run: () => {
      if (live) confirm(mode)
      else if (mode === 'fresh') {
        client.respawnSession(info.id, shellIntegration, undefined, undefined, undefined, true)
      } else client.respawnSession(info.id, shellIntegration)
    }
  })
  return info.resumable === true
    ? [entry(IconHistory, 'resume'), entry(IconRespawn, 'fresh')]
    : recoveryHusk(info, live)
      ? [entry(IconRespawn, 'restart'), entry(IconRespawn, 'fresh')]
      : [entry(IconRespawn, 'restart')]
}

export function restartTooltip(info: SessionInfo): string {
  if (info.agent === 'ssh') return 'Reconnect (opens the SSH dialog prefilled)'
  return info.resumable === true
    ? 'Restart in the same conversation'
    : recoveryHusk(info, isLive(info.state))
      ? 'Retry session recovery'
      : 'Restart (a fresh CLI in the same folder)'
}

export function RestartConfirm({
  mode,
  info,
  client,
  shellIntegration,
  onClose
}: {
  mode: RestartMode
  info: SessionInfo
  client: HoustonClient
  shellIntegration: boolean
  onClose: () => void
}): React.JSX.Element {
  return (
    <ConfirmModal
      message={COPY[mode].message(info.title)}
      confirmLabel={COPY[mode].label}
      onConfirm={() => {
        onClose()
        if (mode === 'fresh') {
          client.respawnSession(info.id, shellIntegration, undefined, undefined, true, true)
        } else client.respawnSession(info.id, shellIntegration, undefined, undefined, true)
      }}
      onCancel={onClose}
    />
  )
}

/** A pane the daemon left as a husk: not running, with a recorded reason it was not restored. */
export function isRestoreHusk(info: SessionInfo, live: boolean): boolean {
  return !live && info.restore_deferred != null
}

export function paneDimming(info: SessionInfo, live: boolean, ended: string | null): boolean | 'body' {
  return isRestoreHusk(info, live) ? 'body' : Boolean(ended)
}

/** The footer a pane shows when its conversation was not resumed; the reason is in a tooltip, never a title. */
export function RecoveryFooter({
  info,
  live,
  client,
  shellIntegration,
  onReconnectSsh
}: {
  info: SessionInfo
  live: boolean
  client: HoustonClient
  shellIntegration: boolean
  onReconnectSsh: (id: number) => void
}): React.JSX.Element | null {
  const { error, respawning } = usePaneOpState(info.id)
  const [dismissed, setDismissed] = useState(false)
  if (isRestoreHusk(info, live)) {
    const tone = error ? 'danger' : 'default'
    if (info.agent === 'ssh') {
      return (
        <PaneFooterNotice
          data-testid="recovery-footer"
          tone={tone}
          sentence={error ?? 'SSH sessions reconnect manually.'}
          reason={info.resume_notice}
          primary={{ label: 'Reconnect', onClick: () => onReconnectSsh(info.id) }}
        />
      )
    }
    return (
      <PaneFooterNotice
        data-testid="recovery-footer"
        tone={tone}
        sentence={error ?? 'This conversation could not be resumed.'}
        reason={recoveryReason(info)}
        primary={{ label: 'Try again', disabled: respawning, onClick: () => client.respawnSession(info.id, shellIntegration) }}
        secondary={{
          label: 'New conversation',
          disabled: respawning,
          onClick: () => client.respawnSession(info.id, shellIntegration, undefined, undefined, undefined, true)
        }}
      />
    )
  }
  if (!info.resume_notice || dismissed) return null
  return (
    <PaneFooterNotice
      data-testid="resume-notice"
      sentence="Started a new conversation; the previous one could not be resumed."
      reason={recoveryReason(info)}
      onDismiss={() => setDismissed(true)}
    />
  )
}
