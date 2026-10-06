import { useState } from 'react'
import type { HoustonClient, SessionInfo } from '../houston/client'
import { ConfirmModal } from './ConfirmModal'
import { Icon } from './ui/Icon'
import { IconClose, IconHistory, IconRespawn, type IconComponent } from './icons'
import { Tooltip } from './ui/Tooltip'

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
    : [entry(IconRespawn, 'restart')]
}

export function restartTooltip(info: SessionInfo): string {
  if (info.agent === 'ssh') return 'Reconnect (opens the SSH dialog prefilled)'
  return info.resumable === true
    ? 'Restart in the same conversation'
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

/** Why the pane started fresh instead of resuming, until the user dismisses it. */
export function ResumeNotice({
  notice,
  buttonClassName
}: {
  notice: string | null | undefined
  buttonClassName: string
}): React.JSX.Element | null {
  const [dismissed, setDismissed] = useState(false)
  if (!notice || dismissed) return null
  return (
    <div
      data-testid="resume-notice"
      className="flex items-center gap-2 flex-none py-[3px] px-2 border-b border-[var(--border)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)]"
    >
      <span className="min-w-0 flex-1 truncate">{notice}</span>
      <Tooltip label="Dismiss">
        <button
          className={buttonClassName}
          aria-label="Dismiss notice"
          onClick={(e) => {
            e.stopPropagation()
            setDismissed(true)
          }}
        >
          <Icon glyph={IconClose} role="ui" />
        </button>
      </Tooltip>
    </div>
  )
}
