import { useEffect, useState } from 'react'
import { isTauri } from '../../houston/host'
import { nativeNotificationSupport, type NativeNotificationSupport } from '../../houston/bridge'
import type { DesktopNotificationMode } from '../../usePreferences'
import { Select } from '../ui/Select'
import { Icon } from '../ui/Icon'
import { Caption } from '../ui/Caption'
import { StatusNote, type StatusNoteTone } from '../ui/StatusNote'
import { IconCheck } from '../icons'
import { SettingsList, Toggle } from '../ui/settingsPrimitives'
import { SectionHead, Row } from './shared'

const DESKTOP_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'notifications', label: 'Notifications only' },
  { value: 'sound', label: 'Sound only' },
  { value: 'notifications-sound', label: 'Notifications with sound' }
] as const

function desktopStatusMessage({
  delivery,
  tauri,
  unsupportedPlatform,
  nativeMode,
  support
}: {
  delivery: { allowed: boolean; error?: string } | null
  tauri: boolean
  unsupportedPlatform: boolean
  nativeMode: boolean
  support: NativeNotificationSupport | null
}): string {
  if (delivery?.allowed) return 'Allowed by the desktop'
  if (delivery) return 'The desktop refused this notification. Enable notifications for Houston in desktop settings.'
  if (tauri && unsupportedPlatform) return 'Not available on macOS yet'
  if (tauri && support?.supported === false) {
    return support.reason
      ? `Desktop notifications are unavailable: ${support.reason}`
      : 'Desktop notification service is unavailable or lacks action support. Enable notifications for Houston in desktop settings.'
  }
  if (nativeMode && support === null) return 'Checking desktop notification support…'
  if (!tauri) return 'Desktop notifications are available in the Linux and Windows desktop apps.'
  if (nativeMode) return 'Desktop notification service available'
  return 'Desktop notifications are off.'
}

function desktopStatusTone(delivery: { allowed: boolean; error?: string } | null): StatusNoteTone {
  if (delivery?.allowed) return 'ok'
  if (delivery?.error) return 'stop'
  if (delivery) return 'warn'
  return 'muted'
}

export function NotificationsSection({
  desktopMode,
  onDesktopMode,
  inApp,
  onInApp,
  delivery
}: {
  desktopMode: DesktopNotificationMode
  onDesktopMode: (mode: DesktopNotificationMode) => void
  inApp: boolean
  onInApp: (enabled: boolean) => void
  delivery: { allowed: boolean; error?: string } | null
}): React.JSX.Element {
  const tauri = isTauri()
  const unsupportedPlatform = typeof navigator !== 'undefined' && /Macintosh|Mac OS/i.test(navigator.userAgent)
  const [support, setSupport] = useState<NativeNotificationSupport | null>(() =>
    tauri && unsupportedPlatform ? { supported: false, reason: null } : null
  )

  useEffect(() => {
    const asksForDesktopNotification = desktopMode === 'notifications' || desktopMode === 'notifications-sound'
    if (!tauri || unsupportedPlatform || !asksForDesktopNotification) {
      if (unsupportedPlatform) setSupport({ supported: false, reason: null })
      else if (!asksForDesktopNotification) setSupport(null)
      return
    }
    let current = true
    void nativeNotificationSupport().then((value) => {
      if (current) setSupport(value)
    })
    return () => { current = false }
  }, [desktopMode, tauri, unsupportedPlatform])

  const unavailable = tauri && support?.supported === false
  const nativeMode = desktopMode === 'notifications' || desktopMode === 'notifications-sound'
  const supportStatus = desktopStatusMessage({
    delivery,
    tauri,
    unsupportedPlatform,
    nativeMode,
    support
  })

  return (
    <>
      <SectionHead title="Notifications" />
      <div className="grid gap-[var(--space-3)]">
        <SettingsList>
        <Row
          title="Desktop notifications"
          desc={
            <div className="grid gap-[var(--space-1)]">
              <span>
                When an agent finishes a turn or needs your input while Houston is in the background. Clicking one opens that pane. The pane name, agent, workspace and reason for input go to the desktop’s notification service on this machine; nothing else is sent.
              </span>
              <Caption tone="secondary">
                <StatusNote data-testid="desktop-notification-status" tone={desktopStatusTone(delivery)}>
                  {delivery?.allowed && <Icon glyph={IconCheck} role="small" />}
                  {delivery?.error ? `Desktop notification failed: ${delivery.error}` : supportStatus}
                </StatusNote>
              </Caption>
            </div>
          }
        >
          <div style={{ width: 210 }}>
            <Select
              aria-label="Desktop notifications"
              data-testid="desktop-notification-mode"
              value={desktopMode}
              width="full"
              options={DESKTOP_OPTIONS.map((option) => ({
                ...option,
                disabled: unavailable && (option.value === 'notifications' || option.value === 'notifications-sound')
              }))}
              onChange={(value) => onDesktopMode(value as DesktopNotificationMode)}
            />
          </div>
        </Row>
        <Row
          title="In-app notifications"
          desc="While Houston is focused, show a short notice when an agent that is not on screen finishes or needs your input. Panes on screen only change their status dot."
        >
          <Toggle
            aria-label="In-app notifications"
            data-testid="in-app-notification-switch"
            on={inApp}
            onChange={onInApp}
          />
        </Row>
        </SettingsList>
      <div data-testid="notification-children-note">
        <Caption>
          Child panes ask their orchestrator first. Only requests addressed to you trigger notifications and taskbar attention; requests escalated to you show their reason.
        </Caption>
      </div>
      </div>
    </>
  )
}
