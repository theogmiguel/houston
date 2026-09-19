// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsView, type OrchestrationStateView } from './SettingsView'
import { setSettingsNavForTests } from '../settingsNav'
import { SETTINGS_ROW_REGISTRY } from '../settingsRowRegistry'
import type { SettingsSectionId } from '../settingsSections'
import { baseSettingsViewProps, headlessRoleViewFixture, hostInfoFixture } from './settingsViewTestFixtures'
import type { VoiceSettings } from '../houston/generated/VoiceSettings'
import type { KeymapOverrides } from '../houston/client'

const { daemonStatusMock } = vi.hoisted(() => ({ daemonStatusMock: vi.fn() }))
vi.mock('../houston/manage', async () => {
  const actual = await vi.importActual<typeof import('../houston/manage')>('../houston/manage')
  return { ...actual, daemonStatus: daemonStatusMock }
})

const { trayStateMock } = vi.hoisted(() => ({ trayStateMock: vi.fn() }))
vi.mock('../houston/tray', async () => {
  const actual = await vi.importActual<typeof import('../houston/tray')>('../houston/tray')
  return { ...actual, trayState: trayStateMock }
})

;(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test'

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function voiceSettingsFixture(): VoiceSettings {
  return {
    enabled: false,
    engine: { kind: 'cloud', provider: 'groq' },
    output_mode: 'original',
    input_language: null,
    capture_mode: 'hold',
    input_device: null,
    insert_mode: 'direct',
    vocabulary: '',
    agent_preamble: true,
    mic_policy: 'persistent',
    rms_floor: 0.01
  }
}

function orchestrationStateFixture(): OrchestrationStateView {
  return {
    caps: { max_live_children: 4, max_spawn_depth: 4 },
    enabled: true,
    acpAgents: []
  }
}

const SECTION_OVERRIDES: Partial<
  Record<SettingsSectionId, Partial<React.ComponentProps<typeof SettingsView>>>
> = {
  'headless-roles': {
    headlessWriter: headlessRoleViewFixture({ role: 'writer' })
  },
  orchestration: {
    orchestrationState: orchestrationStateFixture(),
    hostInfo: hostInfoFixture()
  },
  voice: { voiceSettings: voiceSettingsFixture() },
  diagnostics: { hostInfo: hostInfoFixture() }
}

describe('settingsRowRegistry — every registered title actually renders', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)

    daemonStatusMock.mockReset()
    daemonStatusMock.mockResolvedValue({
      manage_version: 1,
      protocol_version: 92,
      build: 'abc1234',
      pid: 4321,
      started_at: new Date().toISOString(),
      live_sessions: { count: 0, ids: [] },
      routines_enabled: 0,
      clients_connected: 1,
      handoff: { supported: true, reason: '' },
      reap: { armed: false, deadline_ms: null }
    })
    trayStateMock.mockReset()
    trayStateMock.mockResolvedValue({
      available: true,
      reason: null,
      keepInTray: true,
      hidesOnClose: true
    })

    ;(globalThis as unknown as { Notification: { permission: string } }).Notification = {
      permission: 'denied'
    }
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    setSettingsNavForTests({ section: 'appearance' })
    delete (globalThis as { Notification?: unknown }).Notification
  })

  it.each(Object.entries(SETTINGS_ROW_REGISTRY) as [SettingsSectionId, readonly string[]][])(
    '%s: every registered row title renders',
    async (section, titles) => {
      act(() => setSettingsNavForTests({ section }))
      act(() => {
        root.render(
          <SettingsView
            {...baseSettingsViewProps()}
            keymapOverrides={{ bindings: {}, shortcuts_enabled: true } as KeymapOverrides}
            {...(SECTION_OVERRIDES[section] ?? {})}
          />
        )
      })
      await flush()

      for (const title of titles) {
        const row = Array.from(
          host.querySelectorAll<HTMLElement>('[data-settings-row-name]')
        ).find((r) => r.getAttribute('data-settings-row-name') === title)
        expect(row, `"${section} › ${title}" has no matching rendered row`).not.toBeUndefined()
      }
    }
  )
})
