export interface NotifySpec {
  title: string
  body: string
  onClick?: () => void
  soundUrl?: string
}

export const OS_NOTIFICATION_BODY_CAP = 180

export function truncateNotificationBody(
  body: string,
  cap: number = OS_NOTIFICATION_BODY_CAP
): string {
  const chars = Array.from(body)
  if (chars.length <= cap) return body
  return `${chars.slice(0, cap - 1).join('')}…`
}

let pendingPermissionRequest: Promise<NotificationPermission> | null = null

function fireOsNotification(spec: NotifySpec): void {
  const fire = (): void => {
    const n = new Notification(spec.title, { body: truncateNotificationBody(spec.body) })
    if (spec.onClick) n.onclick = spec.onClick
    if (spec.soundUrl) playChime(spec.soundUrl)
  }
  if (Notification.permission === 'granted') {
    fire()
  } else if (Notification.permission === 'default') {
    if (!pendingPermissionRequest) {
      pendingPermissionRequest = Notification.requestPermission().finally(() => {
        pendingPermissionRequest = null
      })
    }
    void pendingPermissionRequest.then((perm) => {
      if (perm === 'granted') fire()
    })
  }
}

// `isFocused` is an OS window-focus check (a bridge round trip), not
// `document.hasFocus()`: the document's focus diverges from the window's
// whenever a child webview holds input, which would silence real notices.
export function notifyThroughFocusGate(
  isFocused: () => Promise<boolean>,
  quiet: (focused: boolean) => boolean,
  buildSpec: () => NotifySpec
): void {
  if (typeof Notification === 'undefined') return
  void isFocused()
    .catch((err: unknown) => {
      console.warn('notifications: focus check failed, assuming unfocused', err)
      return false
    })
    .then((focused) => {
      if (quiet(focused)) return
      fireOsNotification(buildSpec())
    })
}

export function notificationsPermissionDenied(): boolean {
  return typeof Notification !== 'undefined' && Notification.permission === 'denied'
}

export function playChime(url: string): void {
  const audio = new Audio(url)
  audio.play()?.catch(() => {})
}
