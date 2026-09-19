import { BTN_GHOST } from '../buttonChrome'
import { notificationsPermissionDenied } from '../../notifications'
import { NOTIFY_KIND_ROWS, type NotifyKinds } from '../../notifyPrefs'
import type { NoticeSeverity } from '../noticeSeverity'
import { SettingsList, Toggle } from '../settingsPrimitives'
import { Row, SubHead } from './shared'

export interface NotificationsSectionProps {
  notifyKinds: NotifyKinds
  onNotifyKinds: (kinds: NotifyKinds) => void
  notifyEnabled: boolean
  onNotifyEnabled: (on: boolean) => void
  notifySound: boolean
  onNotifySound: (on: boolean) => void
  onNotifyPreview: (severity: NoticeSeverity) => void
}

export function NotificationsSection({
  notifyKinds,
  onNotifyKinds,
  notifyEnabled,
  onNotifyEnabled,
  notifySound,
  onNotifySound,
  onNotifyPreview
}: NotificationsSectionProps): React.JSX.Element {
  return (
    <>
      <div className="mb-[var(--space-5)]">
        <div className="text-[length:var(--tr-text-heading-size)] font-[var(--tr-text-heading-weight)] tracking-[var(--tr-text-heading-tracking)] leading-[1.25] text-[var(--text-primary)]">Notifications</div>
        <div className="mt-[var(--space-1-5)] text-[length:var(--tr-text-base)] leading-[1.6] text-[var(--text-muted)] max-w-[72ch]">
          Pop an OS notification when an agent finishes, needs input, or hits an error —
          for every detected agent, not just HoustonSwarm.
        </div>
      </div>
      <SubHead>When to notify</SubHead>
      <SettingsList>
        <Row
          title="Desktop notifications"
          desc="OS-permission-gated. Suppressed while you are looking at the session it is about."
        >
          <Toggle on={notifyEnabled} onChange={onNotifyEnabled} />
        </Row>
        {NOTIFY_KIND_ROWS.map((r) => (
          <Row key={r.kind} title={r.label} desc={r.desc} indent>
            <div className="flex items-center gap-[var(--space-2)]">
              {}
              <button
                type="button"
                className={`btn ${BTN_GHOST}`}
                onClick={() => onNotifyPreview(r.kind)}
                data-testid={`notify-preview-${r.kind}`}
                aria-label={`Play the ${r.label} sound`}
              >
                Play
              </button>
              <Toggle
                on={notifyKinds[r.kind]}
                disabled={!notifyEnabled}
                onChange={(on) => onNotifyKinds({ ...notifyKinds, [r.kind]: on })}
              />
            </div>
          </Row>
        ))}
        <Row title="Play sound" desc="Each alert type has its own sound — play one to hear it">
          <Toggle on={notifySound} onChange={onNotifySound} />
        </Row>
        {notificationsPermissionDenied() && (
          <Row
            title="Blocked by the OS"
            desc="Denied at the OS level. Nothing shows until you re-allow it there."
          />
        )}
      </SettingsList>
    </>
  )
}
