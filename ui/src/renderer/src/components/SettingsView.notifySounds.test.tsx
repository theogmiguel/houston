// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsView } from './SettingsView'
import { setSettingsNavForTests } from '../settingsNav'
import { NOTIFY_KIND_ROWS, NOTIFY_KINDS_DEFAULT } from '../notifyPrefs'
import { NOTICE_SEVERITY_SOUND } from './noticeSeverity'
import { baseSettingsViewProps } from './settingsViewTestFixtures'

describe('Settings — notification sounds', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  function render(props: Partial<React.ComponentProps<typeof SettingsView>>): void {
    act(() => {
      root.render(<SettingsView {...baseSettingsViewProps()} {...props} />)
    })
    act(() => setSettingsNavForTests({ section: 'notifications' }))
  }

  it('gives every kind row its own preview and reports that row severity', () => {
    const onNotifyPreview = vi.fn()
    render({ notifyEnabled: true, onNotifyPreview })
    for (const r of NOTIFY_KIND_ROWS) {
      const btn = host.querySelector<HTMLButtonElement>(`[data-testid="notify-preview-${r.kind}"]`)
      expect(btn, r.kind).not.toBeNull()
      act(() => btn!.click())
    }
    expect(onNotifyPreview.mock.calls.map((c) => c[0])).toEqual(NOTIFY_KIND_ROWS.map((r) => r.kind))
  })

  it('previews a row whose toggle is off', () => {
    const onNotifyPreview = vi.fn()
    render({
      notifyEnabled: true,
      notifyKinds: { ...NOTIFY_KINDS_DEFAULT, error: false },
      onNotifyPreview
    })
    const btn = host.querySelector<HTMLButtonElement>('[data-testid="notify-preview-error"]')!
    expect(btn.disabled).toBe(false)
    act(() => btn.click())
    expect(onNotifyPreview).toHaveBeenCalledWith('error')
  })

  it('maps each severity to its own distinct asset', () => {
    const urls = Object.values(NOTICE_SEVERITY_SOUND)
    expect(urls.every((u) => typeof u === 'string' && u.length > 0)).toBe(true)
    expect(new Set(urls).size).toBe(urls.length)
  })
})
