import { useEffect, useState } from 'react'
import { isTauri } from '../../houston/host'
import { nativeNotificationsSupported } from '../../houston/bridge'
import type { DesktopNotificationMode } from '../../usePreferences'
import { Select } from '../Select'
import { Icon } from '../Icon'
import { Caption } from '../ui/Caption'
import { IconCheck } from '../icons'
import { SettingsList, Toggle } from '../settingsPrimitives'
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
  windows,
  unsupportedPlatform,
  unavailable,
  nativeMode,
  supported
}: {
  delivery: { allowed: boolean; error?: string } | null
  tauri: boolean
  windows: boolean
  unsupportedPlatform: boolean
  unavailable: boolean
  nativeMode: boolean
  supported: boolean | null
}): string {
  if (delivery?.allowed) return 'Allowed by the desktop'
  if (delivery) return 'The desktop refused this notification. Enable notifications for Houston in desktop settings.'
  if (tauri && unsupportedPlatform) return `Not available on ${windows ? 'Windows' : 'macOS'} yet`
  if (unavailable) return 'Desktop notification service is unavailable or lacks action support. Enable notifications for Houston in desktop settings.'
  if (nativeMode && supported === null) return 'Checking desktop notification support…'
  if (!tauri) return 'Desktop notifications are available in the Linux desktop app.'
  if (nativeMode) return 'Desktop notification service available'
  return 'Desktop notifications are off.'
}

function desktopStatusTone(delivery: { allowed: boolean; error?: string } | null): string {
  if (delivery?.allowed) return 'text-[var(--ok)]'
  if (delivery?.error) return 'text-[var(--stop)]'
  if (delivery) return 'text-[var(--warn)]'
  return 'text-[var(--text-muted)]'
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
  const windows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)
  const macos = typeof navigator !== 'undefined' && /Macintosh|Mac OS/i.test(navigator.userAgent)
  const unsupportedPlatform = windows || macos
  const [supported, setSupported] = useState<boolean | null>(() => tauri && unsupportedPlatform ? false : null)

  useEffect(() => {
    const asksForDesktopNotification = desktopMode === 'notifications' || desktopMode === 'notifications-sound'
    if (!tauri || unsupportedPlatform || !asksForDesktopNotification) {
      if (unsupportedPlatform) setSupported(false)
      else if (!asksForDesktopNotification) setSupported(null)
      return
    }
    let current = true
    void nativeNotificationsSupported().then((value) => {
      if (current) setSupported(value)
    })
    return () => { current = false }
  }, [desktopMode, tauri, unsupportedPlatform])

  const unavailable = tauri && supported === false
  const nativeMode = desktopMode === 'notifications' || desktopMode === 'notifications-sound'
  const supportStatus = desktopStatusMessage({
    delivery,
    tauri,
    windows,
    unsupportedPlatform,
    unavailable,
    nativeMode,
    supported
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
                When an agent finishes a turn or needs your input while Houston is in the background. Clicking one opens that pane. The pane name, agent and workspace go to the desktop’s notification service on this machine; nothing else is sent.
              </span>
              <Caption tone="secondary">
                <span role="status" data-testid="desktop-notification-status" className={`inline-flex items-center gap-[5px] ${desktopStatusTone(delivery)}`}>
                  {delivery?.allowed && <Icon glyph={IconCheck} role="small" />}
                  {delivery?.error ? `Desktop notification failed: ${delivery.error}` : supportStatus}
                </span>
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
          Child panes report to the agent that started them, not to you. The taskbar icon counts the panes waiting on you.
        </Caption>
      </div>
      </div>
    </>
  )
}
