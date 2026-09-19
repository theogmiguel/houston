// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type AppHarness,
  deliverControl,
  renderReadyApp,
  resetHarness
} from './test/appTestHarness'
import { flushGhosttyAttach, ghosttyMock } from './test/ghosttySurfaceMock'
import { resetDictationForTests, toggleActiveFor } from './voice/dictation'
import { resetVoiceStoreForTests, voiceIndicatorFor } from './voice/store'
import type { VoiceSettings } from './houston/generated/VoiceSettings'

beforeEach(() => {
  resetHarness()
  resetDictationForTests()
  resetVoiceStoreForTests()
  localStorage.clear()
})

afterEach(() => {
  resetDictationForTests()
  resetVoiceStoreForTests()
})

const MISSING_KEY_MSG = 'No groq API key stored — add one in Settings → Voice, or switch back to the local engine.'

function voiceSettings(overrides: Partial<VoiceSettings> = {}): VoiceSettings {
  return {
    enabled: true,
    engine: { kind: 'cloud', provider: 'groq' },
    output_mode: 'original',
    input_language: null,
    capture_mode: 'toggle',
    input_device: null,
    insert_mode: 'direct',
    vocabulary: '',
    agent_preamble: false,
    mic_policy: 'on_keypress',
    rms_floor: 0.01,
    ...overrides
  }
}

function enableDictation(mode: 'hold' | 'toggle'): void {
  act(() => {
    deliverControl({
      type: 'voice_settings',
      settings: voiceSettings({ capture_mode: mode }),
      cloud_key_present: false,
      keyring_error: null,
      models: []
    })
  })
}

function chordDown(): boolean {
  return ghosttyMock.emitKey(
    new KeyboardEvent('keydown', {
      code: 'Space',
      key: ' ',
      ctrlKey: true,
      shiftKey: true,
      cancelable: true
    })
  )
}

describe('voice failure surfacing (v56)', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('a persistent failure is an app-level banner, not a pane banner', async () => {
    harness = await renderReadyApp()
    const { container } = harness

    act(() => {
      deliverControl({
        type: 'voice_state',
        state: { state: 'error', failure: { kind: 'missing_key', provider: 'groq' } }
      })
    })

    expect(container.textContent).toContain(MISSING_KEY_MSG)
    expect(container.querySelector('[data-testid="voice-indicator"]')).toBeNull()

    act(() => {
      deliverControl({
        type: 'voice_state',
        state: { state: 'error', failure: { kind: 'missing_key', provider: 'groq' } }
      })
    })
    expect(container.textContent.split(MISSING_KEY_MSG).length - 1).toBe(1)
  })

  it('a refused start releases the toggle instead of stranding it', async () => {
    harness = await renderReadyApp()
    await act(async () => {
      await flushGhosttyAttach()
    })
    enableDictation('toggle')
    expect(chordDown()).toBe(false)
    expect(toggleActiveFor()).toBe(1)

    act(() => {
      deliverControl({
        type: 'voice_state',
        state: { state: 'error', failure: { kind: 'missing_key', provider: 'groq' } }
      })
    })

    expect(toggleActiveFor()).toBeNull()
    act(() => {
      chordDown()
    })
    expect(toggleActiveFor()).toBe(1)
  })

  it('a momentary failure still lands on the listening pane, never the app banner', async () => {
    harness = await renderReadyApp()
    await act(async () => {
      await flushGhosttyAttach()
    })
    enableDictation('toggle')
    act(() => {
      chordDown()
    })

    const tooQuietMsg =
      'Too quiet to transcribe — measured RMS 0.0031, floor 0.0100.'
    act(() => {
      deliverControl({
        type: 'voice_state',
        state: { state: 'error', failure: { kind: 'too_quiet', rms: 0.0031, floor: 0.01 } }
      })
    })

    expect(voiceIndicatorFor(1)).toBeNull()
    const toast = harness!.container.querySelector('[data-notice="voice-failure"]') as HTMLElement
    expect(toast).not.toBeNull()
    expect(toast.textContent).toContain(tooQuietMsg)
    expect(toast.getAttribute('data-kind')).toBe('error')

    expect(toast.closest('[aria-label="Workspace notices"]')).toBeNull()
    expect(toast.closest('[aria-label="Pane notices"]')).not.toBeNull()

    const elsewhere = (harness!.container.textContent ?? '').replace(toast.textContent ?? '', '')
    expect(elsewhere).not.toContain('Too quiet')
  })
})
