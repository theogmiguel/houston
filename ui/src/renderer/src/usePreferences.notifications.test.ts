// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { DESKTOP_NOTIFICATION_MODE_KEY, IN_APP_NOTIFICATIONS_KEY, usePreferences } from './usePreferences'

describe('notification preferences', () => {
  beforeEach(() => localStorage.clear())

  it('defaults both channels off and persists changes', () => {
    const { result, unmount } = renderHook(() => usePreferences())
    expect(result.current.desktopNotificationMode).toBe('off')
    expect(result.current.inAppNotifications).toBe(false)

    act(() => {
      result.current.setDesktopNotificationMode('notifications-sound')
      result.current.setInAppNotifications(true)
    })
    expect(localStorage.getItem(DESKTOP_NOTIFICATION_MODE_KEY)).toBe('notifications-sound')
    expect(localStorage.getItem(IN_APP_NOTIFICATIONS_KEY)).toBe('1')
    unmount()

    const reloaded = renderHook(() => usePreferences())
    expect(reloaded.result.current.desktopNotificationMode).toBe('notifications-sound')
    expect(reloaded.result.current.inAppNotifications).toBe(true)
  })
})
