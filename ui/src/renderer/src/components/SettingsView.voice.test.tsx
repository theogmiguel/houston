// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsView } from './SettingsView'
import { setSettingsNavForTests } from '../settingsNav'
import { NOTIFY_KINDS_DEFAULT } from '../notifyPrefs'
import type { KeymapOverrides } from '../houston/client'
import type { VoiceModelState } from '../houston/generated/VoiceModelState'
import type { VoiceSettings } from '../houston/generated/VoiceSettings'
import { resetVoiceStoreForTests, setVoicePageError } from '../voice/store'
import { NAVIGABLE_SETTINGS_SECTIONS } from '../settingsSections'
import { selectOptionValues, selectValue } from '../test/selectHarness'

;(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test'

function baseProps(): React.ComponentProps<typeof SettingsView> {
  return {
    update: null,
    onUpdateCheckNow: () => {},
    onUpdatePolicySet: () => {},
    onOpenExternal: () => {},
    usage: null,
    usageLoading: false,
    usageError: null,
    onUsageRequest: () => {},
    voiceSettings: null,
    voiceCloudKeyPresent: false,
    voiceKeyringError: null,
    voiceModels: [],
    voiceDevices: [],
    onVoiceSettingsSet: () => {},
    onVoiceKeySet: () => {},
    onVoiceKeyClear: () => {},
    onVoiceDevicesRefresh: () => {},
    onVoiceModelDownload: () => {},
    onVoiceModelDelete: () => {},
    onVoiceLevelMonitor: () => {},
    agentProfiles: null,
    onAgentProfileUpsert: () => {},
    onAgentProfileDelete: () => {},
    onAgentProfileSetActive: () => {},
    chromeTheme: 'graphite',
    onChromeTheme: () => {},
    theme: 'warm-espresso',
    fontSize: 14,
    onFontSize: () => {},
    fontMin: 8,
    fontMax: 24,
    fontDefault: 14,
    fontFamilyId: 'nerd',
    shiftEnterNewline: true,
    openLinksInPane: false,
    notifyKinds: NOTIFY_KINDS_DEFAULT,
    onNotifyKinds: () => {},
    onOpenLinksInPane: () => {},
    onShiftEnterNewline: () => {},
    onFontFamilyId: () => {},
    uiZoom: 1,
    onUiZoom: () => {},
    zoomMin: 0.5,
    zoomMax: 2,
    zoomStep: 0.1,
    onTheme: () => {},
    shellIntegration: true,
    onShellIntegration: () => {},
    osc52: true,
    onOsc52: () => {},
    copyOnSelect: false,
    onCopyOnSelect: () => {},
    stripBoxGlyphs: true,
    onStripBoxGlyphs: () => {},
    orchestrationState: null,
    onOpenAcpPane: () => {},
    historyWorkspace: null,
    historyWorkspaceName: null,
    historyCount: null,
    onClearHistory: () => {},
    historyIgnoreGlobs: null,
    headlessWriter: null,
    onHeadlessRoleSet: () => {},
    onHistoryIgnoreGlobsSet: () => {},
    onOpenLogsFolder: () => {},
    onContact: () => {},
    onOpenLicense: () => {},
    onRestoreBudgetSet: () => {},
    sessionPolicy: null,
    onSessionPolicy: () => {},
    orchestrationEnabled: true,
    onOrchestrationEnabled: () => {},
    onOrchestrationCapsSet: () => {},
    onMailboxRetentionSet: () => {},
    hostInfo: null,
    agentHooks: null,
    onOpenHooks: () => {},
    onAgentHooksSet: () => {},
    onAgentHooksRefresh: () => {},
    onRevealSessionDb: () => {},
    keymapOverrides: { bindings: {}, shortcuts_enabled: true } as KeymapOverrides,
    onKeymapOverrides: () => {},
    notifyEnabled: false,
    onNotifyEnabled: () => {},
    notifySound: true,
    onNotifySound: () => {},
    onNotifyPreview: () => {}
  }
}

function voiceSettings(overrides: Partial<VoiceSettings> = {}): VoiceSettings {
  return {
    enabled: false,
    engine: { kind: 'local', model_id: 'ggml-small' },
    output_mode: 'original',
    input_language: null,
    capture_mode: 'hold',
    input_device: null,
    insert_mode: 'direct',
    vocabulary: '',
    agent_preamble: true,
    mic_policy: 'persistent',
    rms_floor: 0.01,
    ...overrides
  }
}

function model(overrides: Partial<VoiceModelState> = {}): VoiceModelState {
  return {
    id: 'ggml-small',
    display_name: 'Small (multilingual)',
    size_bytes: 487_601_967,
    status: { kind: 'not_downloaded' },
    cooldown_remaining_ms: null,
    ...overrides
  }
}

function openVoice(_container: HTMLDivElement): void {
  act(() => setSettingsNavForTests({ section: 'voice' }))
}

function rowByTitle(container: HTMLDivElement, title: string): HTMLElement {
  const row = Array.from(
    container.querySelectorAll<HTMLElement>('[data-testid="settings-row"]')
  ).find((r) => r.querySelectorAll('div')[1]?.textContent === title)
  if (!row) throw new Error(`no settings row titled ${JSON.stringify(title)}`)
  return row
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('Settings › Voice (v55)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    resetVoiceStoreForTests()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('is reachable by searching for what a user would actually type', () => {
    const voice = NAVIGABLE_SETTINGS_SECTIONS.find((s) => s.id === 'voice')
    expect(voice, 'Voice must still be a navigable section').toBeTruthy()
    for (const term of ['microphone', 'dictation', 'whisper', 'stt']) {
      expect(
        voice!.keywords.some((k) => k.includes(term)),
        `Voice's keywords must include something matching "${term}"`
      ).toBe(true)
    }
  })

  it('says it is still asking rather than rendering defaults it guessed', () => {
    act(() => root.render(<SettingsView {...baseProps()} />))
    openVoice(container)
    expect(container.textContent).toContain('Asking the daemon for the Voice settings')
  })

  it('round-trips the master switch, and its copy says what turning it off does', () => {
    const seen: VoiceSettings[] = []
    act(() =>
      root.render(
        <SettingsView
          {...baseProps()}
          voiceSettings={voiceSettings()}
          onVoiceSettingsSet={(s) => seen.push(s)}
        />
      )
    )
    openVoice(container)
    const row = rowByTitle(container, 'Enable dictation')
    expect(row.textContent).toContain('none is opened at startup')
    act(() => {
      row.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(seen).toHaveLength(1)
    expect(seen[0].enabled).toBe(true)

    act(() =>
      root.render(
        <SettingsView
          {...baseProps()}
          voiceSettings={voiceSettings({ enabled: true })}
          voiceModels={[model({ status: { kind: 'downloaded', size_bytes: 487_601_967 } })]}
          onVoiceSettingsSet={(s) => seen.push(s)}
        />
      )
    )
    openVoice(container)
    const on = rowByTitle(container, 'Enable dictation')
    expect(on.textContent).toContain('closes the microphone stream')
    act(() => {
      on.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(seen[1].enabled).toBe(false)
  })

  it('shows the agent-preamble control disabled WITH its reason under Original', () => {
    act(() =>
      root.render(<SettingsView {...baseProps()} voiceSettings={voiceSettings()} />)
    )
    openVoice(container)
    const row = rowByTitle(container, 'Tell the agent it is a translation')
    expect(row.textContent).toContain('Only applies with Output set to English')
    expect(row.querySelector('button')!.hasAttribute('disabled')).toBe(true)
  })

  it('enables the agent-preamble control under English, and explains where it goes', () => {
    act(() =>
      root.render(
        <SettingsView {...baseProps()} voiceSettings={voiceSettings({ output_mode: 'english' })} />
      )
    )
    openVoice(container)
    const row = rowByTitle(container, 'Tell the agent it is a translation')
    expect(row.querySelector('button')!.hasAttribute('disabled')).toBe(false)
    expect(row.textContent).toContain('nothing is written to the agent’s own config')
  })

  it('puts the microphone disclosure beside the control, not in a tooltip', () => {
    act(() =>
      root.render(<SettingsView {...baseProps()} voiceSettings={voiceSettings()} />)
    )
    openVoice(container)
    const row = rowByTitle(container, 'Microphone')
    expect(row.textContent).toContain('Held open the whole time dictation is enabled')
    expect(row.textContent).toContain('never opens at startup')
  })

  it('renders the model roster and the live meter itself — no rail pointer', () => {
    const asked: string[] = []
    act(() =>
      root.render(
        <SettingsView
          {...baseProps()}
          voiceSettings={voiceSettings()}
          voiceModels={[model()]}
          onVoiceModelDownload={(id) => asked.push(id)}
        />
      )
    )
    openVoice(container)
    expect(
      container.querySelector('[data-testid="settings-voice-manage-models-pointer"]'),
      'the rail pointer is gone with the rail row'
    ).toBeNull()
    expect(container.querySelector('[data-testid="settings-voice-meter"]')).not.toBeNull()
    const download = container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-voice-model-download"]'
    )!
    act(() => download.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(asked).toEqual(['ggml-small'])
  })

  it('shows no model roster on the cloud engine, but keeps the meter', () => {
    act(() =>
      root.render(
        <SettingsView
          {...baseProps()}
          voiceSettings={voiceSettings({ engine: { kind: 'cloud', provider: 'groq' } })}
          voiceModels={[model()]}
        />
      )
    )
    openVoice(container)
    expect(container.querySelector('[data-testid="settings-voice-model-download"]')).toBeNull()
    expect(
      container.querySelector('[data-testid="settings-voice-meter"]'),
      'the microphone gate is engine-independent'
    ).not.toBeNull()
  })

  it('never renders a stored key back — not masked, not truncated', () => {
    act(() =>
      root.render(
        <SettingsView
          {...baseProps()}
          voiceSettings={voiceSettings({ engine: { kind: 'cloud', provider: 'groq' } })}
          voiceCloudKeyPresent
        />
      )
    )
    openVoice(container)
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Groq API key"]')!
    expect(input.value).toBe('')
    expect(input.type).toBe('password')
    expect(container.textContent).toContain('Key set')
    expect(container.textContent).not.toMatch(/gsk_|\u2022{4}|\*{4}/)
  })

  it('sends a typed key once and clears the draft immediately', () => {
    const sent: string[] = []
    act(() =>
      root.render(
        <SettingsView
          {...baseProps()}
          voiceSettings={voiceSettings({ engine: { kind: 'cloud', provider: 'groq' } })}
          onVoiceKeySet={(_p, key) => sent.push(key)}
        />
      )
    )
    openVoice(container)
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Groq API key"]')!
    typeInto(input, 'gsk_secret_value')
    const save = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Save key'
    )!
    act(() => save.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(sent).toEqual(['gsk_secret_value'])
    const after = container.querySelector<HTMLInputElement>('input[aria-label="Groq API key"]')!
    expect(after.value).toBe('')
  })

  it('offers the way out for a stored key, and only when there is one', () => {
    const cleared: string[] = []
    act(() =>
      root.render(
        <SettingsView
          {...baseProps()}
          voiceSettings={voiceSettings({ engine: { kind: 'cloud', provider: 'groq' } })}
          voiceCloudKeyPresent={false}
          onVoiceKeyClear={(p) => cleared.push(p)}
        />
      )
    )
    openVoice(container)
    const remove = () =>
      Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent === 'Remove key'
      ) as HTMLButtonElement
    expect(remove().disabled).toBe(true)

    act(() =>
      root.render(
        <SettingsView
          {...baseProps()}
          voiceSettings={voiceSettings({ engine: { kind: 'cloud', provider: 'groq' } })}
          voiceCloudKeyPresent
          onVoiceKeyClear={(p) => cleared.push(p)}
        />
      )
    )
    openVoice(container)
    expect(remove().disabled).toBe(false)
    act(() => remove().dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(cleared).toEqual(['groq'])
  })

  it('says the keychain is unreachable rather than letting it read as "no key"', () => {
    act(() =>
      root.render(
        <SettingsView
          {...baseProps()}
          voiceSettings={voiceSettings({ engine: { kind: 'cloud', provider: 'groq' } })}
          voiceCloudKeyPresent={false}
          voiceKeyringError="the name org.freedesktop.secrets was not provided"
        />
      )
    )
    openVoice(container)
    const row = container.querySelector<HTMLElement>('[data-testid="voice-key-row"]')!
    expect(row.getAttribute('data-keyring')).toBe('unreachable')

    const text = container.textContent ?? ''
    expect(text).toContain('org.freedesktop.secrets')
    expect(text, 'the cause must not be reported as the user having no key').not.toContain(
      'No key.'
    )

    act(() =>
      root.render(
        <SettingsView
          {...baseProps()}
          voiceSettings={voiceSettings({ engine: { kind: 'cloud', provider: 'groq' } })}
          voiceCloudKeyPresent={false}
          voiceKeyringError={null}
        />
      )
    )
    openVoice(container)
    expect(
      container.querySelector<HTMLElement>('[data-testid="voice-key-row"]')!.getAttribute(
        'data-keyring'
      )
    ).toBe('ok')
    expect(container.textContent ?? '').toContain('No key.')
  })

  it('shows a stored key as a mask, and keeps the field itself empty', () => {
    const set = () =>
      act(() =>
        root.render(
          <SettingsView
            {...baseProps()}
            voiceSettings={voiceSettings({ engine: { kind: 'cloud', provider: 'groq' } })}
            voiceCloudKeyPresent
            voiceKeyringError={null}
          />
        )
      )
    set()
    openVoice(container)
    const field = (): HTMLInputElement =>
      container.querySelector<HTMLInputElement>('[aria-label="Groq API key"]')!
    expect(field().placeholder).toBe('••••••••••••••••')
    expect(field().value).toBe('')
    expect(
      Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Save key')
        ?.disabled
    ).toBe(true)

    act(() =>
      root.render(
        <SettingsView
          {...baseProps()}
          voiceSettings={voiceSettings({ engine: { kind: 'cloud', provider: 'groq' } })}
          voiceCloudKeyPresent={false}
          voiceKeyringError={null}
        />
      )
    )
    openVoice(container)
    expect(field().placeholder).toBe('gsk_…')

    act(() =>
      root.render(
        <SettingsView
          {...baseProps()}
          voiceSettings={voiceSettings({ engine: { kind: 'cloud', provider: 'groq' } })}
          voiceCloudKeyPresent
          voiceKeyringError="the name org.freedesktop.secrets was not provided"
        />
      )
    )
    openVoice(container)
    expect(field().placeholder).toBe('gsk_…')
  })

  it('links to the chord in Shortcuts rather than duplicating a rebind control', () => {
    act(() => root.render(<SettingsView {...baseProps()} voiceSettings={voiceSettings()} />))
    openVoice(container)
    const row = rowByTitle(container, 'Dictation key')
    expect(row.textContent).toContain('Ctrl+Shift+Space')
    act(() => {
      row.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.textContent).toContain('Click a key to rebind it')
  })

  it('does not re-enumerate audio devices on every render', () => {
    let refreshes = 0
    const props = { ...baseProps(), voiceSettings: voiceSettings({ enabled: true }) }
    act(() => root.render(<SettingsView {...props} onVoiceDevicesRefresh={() => refreshes++} />))
    openVoice(container)
    expect(refreshes).toBe(1)
    for (let i = 0; i < 5; i++) {
      act(() => root.render(<SettingsView {...props} onVoiceDevicesRefresh={() => refreshes++} />))
    }
    expect(refreshes, 'one enumeration per page open, not per render').toBe(1)
  })

  it('says dictation cannot run yet when it is on with no model downloaded', () => {
    act(() =>
      root.render(
        <SettingsView
          {...baseProps()}
          voiceSettings={voiceSettings({ enabled: true })}
          voiceModels={[model({ status: { kind: 'not_downloaded' } })]}
        />
      )
    )
    openVoice(container)
    expect(container.querySelector('[data-testid="settings-voice-not-ready"]')).not.toBeNull()
    expect(container.textContent).toContain('cannot run yet')
    expect(rowByTitle(container, 'Enable dictation').textContent).toContain(
      'nothing can be transcribed yet'
    )
  })

  it('says nothing of the sort once the model is on disk', () => {
    act(() =>
      root.render(
        <SettingsView
          {...baseProps()}
          voiceSettings={voiceSettings({ enabled: true })}
          voiceModels={[model({ status: { kind: 'downloaded', size_bytes: 487_601_967 } })]}
        />
      )
    )
    openVoice(container)
    expect(container.querySelector('[data-testid="settings-voice-not-ready"]')).toBeNull()
  })

  it('warns the same way for a cloud engine with no key', () => {
    act(() =>
      root.render(
        <SettingsView
          {...baseProps()}
          voiceSettings={voiceSettings({ enabled: true, engine: { kind: 'cloud', provider: 'groq' } })}
          voiceCloudKeyPresent={false}
        />
      )
    )
    openVoice(container)
    expect(container.querySelector('[data-testid="settings-voice-not-ready"]')?.textContent).toContain(
      'no API key'
    )
  })

  it('gives §11’s persistent failures a home on this page', () => {
    act(() => root.render(<SettingsView {...baseProps()} voiceSettings={voiceSettings()} />))
    openVoice(container)
    expect(container.querySelector('[data-testid="settings-voice-error"]')).toBeNull()
    act(() => setVoicePageError('Microphone unavailable: Blue Yeti (Device or resource busy)'))
    expect(
      container.querySelector('[data-testid="settings-voice-error"]')!.textContent
    ).toContain('Device or resource busy')
  })

  it('keeps a stored device visible in the picker after it stops enumerating', () => {
    act(() =>
      root.render(
        <SettingsView
          {...baseProps()}
          voiceSettings={voiceSettings({ input_device: 'alsa:unplugged-mic' })}
          voiceDevices={[{ id: 'alsa:default', label: 'Built-in Audio', is_default: true }]}
        />
      )
    )
    openVoice(container)
    expect(selectValue(container, 'settings-voice-device')).toBe(
      'alsa:unplugged-mic (not present)'
    )
    expect(selectOptionValues(container, 'settings-voice-device')).toContain('alsa:unplugged-mic')
  })
})
