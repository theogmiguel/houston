// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  notifyThroughFocusGate,
  OS_NOTIFICATION_BODY_CAP,
  truncateNotificationBody
} from './notifications'

interface FakeNotificationInstance {
  title: string
  body: string
}

function installFakeNotification(permission: NotificationPermission): {
  instances: FakeNotificationInstance[]
  requestPermission: ReturnType<typeof vi.fn>
} {
  const instances: FakeNotificationInstance[] = []
  const requestPermission = vi.fn(() => new Promise<NotificationPermission>(() => {}))
  class FakeNotification {
    static permission: NotificationPermission = permission
    static requestPermission = requestPermission
    title: string
    body: string
    onclick: (() => void) | null = null
    constructor(title: string, opts?: { body?: string }) {
      this.title = title
      this.body = opts?.body ?? ''
      instances.push(this)
    }
  }
  ;(globalThis as unknown as { Notification: unknown }).Notification = FakeNotification
  return { instances, requestPermission }
}

afterEach(() => {
  delete (globalThis as { Notification?: unknown }).Notification
})

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('fireOsNotification requestPermission memoization (P4 #18 review finding 2)', () => {
  it('two notices while permission is default: requestPermission is called once, and both fire once it resolves granted', async () => {
    const { instances, requestPermission } = installFakeNotification('default')
    let resolveGrant: (p: NotificationPermission) => void = () => {}
    requestPermission.mockImplementation(
      () =>
        new Promise<NotificationPermission>((resolve) => {
          resolveGrant = resolve
        })
    )

    notifyThroughFocusGate(
      () => Promise.resolve(false),
      () => false,
      () => ({ title: 'a', body: 'a-body' })
    )
    notifyThroughFocusGate(
      () => Promise.resolve(false),
      () => false,
      () => ({ title: 'b', body: 'b-body' })
    )

    await flush()

    expect(requestPermission).toHaveBeenCalledTimes(1)
    expect(instances).toHaveLength(0)

    resolveGrant('granted')
    await flush()

    expect(instances).toHaveLength(2)
    expect(instances.map((i) => i.title).sort()).toEqual(['a', 'b'])
  })
})

describe('a rejected focus check (item 12 review)', () => {
  it('fires the notification instead of dropping it, and says why', async () => {
    const { instances } = installFakeNotification('granted')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const quiet = vi.fn((focused: boolean) => focused)

    notifyThroughFocusGate(
      () => Promise.reject(new Error('window_is_focused: window gone')),
      quiet,
      () => ({ title: 'agent finished', body: 'session 3' })
    )
    await flush()

    expect(quiet).toHaveBeenCalledWith(false)
    expect(instances.map((i) => i.title)).toEqual(['agent finished'])
    expect(warn).toHaveBeenCalledWith(
      'notifications: focus check failed, assuming unfocused',
      expect.objectContaining({ message: 'window_is_focused: window gone' })
    )
    warn.mockRestore()
  })
})

describe('OS notification body cap (E-toast-4)', () => {
  it('leaves a body at or under the cap exactly as it is', () => {
    const exact = 'x'.repeat(OS_NOTIFICATION_BODY_CAP)
    expect(truncateNotificationBody(exact)).toBe(exact)
    expect(truncateNotificationBody('short')).toBe('short')
  })

  it('never emits more characters than the cap it states', () => {
    const out = truncateNotificationBody('y'.repeat(OS_NOTIFICATION_BODY_CAP + 500))
    expect(Array.from(out)).toHaveLength(OS_NOTIFICATION_BODY_CAP)
    expect(out.endsWith('…')).toBe(true)
  })

  it('cuts on code points, not UTF-16 units', () => {
    const out = truncateNotificationBody('😀'.repeat(20), 5)
    expect(out).toBe('😀😀😀😀…')
    expect(out).not.toContain('\uFFFD')
  })

  it('is applied at the sink, so every call site inherits it', async () => {
    const { instances } = installFakeNotification('granted')
    notifyThroughFocusGate(
      () => Promise.resolve(false),
      () => false,
      () => ({ title: 't', body: 'z'.repeat(1000) })
    )
    await flush()
    expect(instances).toHaveLength(1)
    expect(Array.from(instances[0].body)).toHaveLength(OS_NOTIFICATION_BODY_CAP)
  })
})
