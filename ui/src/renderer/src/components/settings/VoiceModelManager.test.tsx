// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { VoiceLevelMeter, VoiceModelRoster } from './VoiceModelManager'
import { resetVoiceStoreForTests, setVoiceLevel } from '../../voice/store'
import type { VoiceModelState } from '../../houston/generated/VoiceModelState'
import { DEFAULT_RMS_FLOOR } from '../../houston/generated/DEFAULTS'

function model(overrides: Partial<VoiceModelState> = {}): VoiceModelState {
  return {
    id: 'ggml-small',
    display_name: 'Small (multilingual)',
    size_bytes: 487_601_967,
    status: { kind: 'not_downloaded' },
    cooldown_remaining_ms: null,
    linked: false,
    ...overrides
  }
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function baseProps(): React.ComponentProps<typeof VoiceModelRoster> {
  return {
    voiceModels: [],
    selectedModelId: null,
    onVoiceModelDownload: () => {},
    onVoiceModelDelete: () => {}
  }
}

function meterProps(): React.ComponentProps<typeof VoiceLevelMeter> {
  return {
    voiceSettings: { enabled: false, rms_floor: DEFAULT_RMS_FLOOR },
    onRmsFloorSet: () => {},
    onVoiceLevelMonitor: () => {}
  }
}

function setDocumentHidden(hidden: boolean): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible')
  })
  document.dispatchEvent(new Event('visibilitychange'))
}
function restoreDocumentVisibility(): void {
  delete (document as unknown as Record<string, unknown>).visibilityState
}

describe('VoiceModelRoster — the model roster', () => {
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

  it('offers a download for a model that is not installed, naming what it costs', () => {
    const asked: string[] = []
    act(() =>
      root.render(
        <VoiceModelRoster
          {...baseProps()}
          voiceModels={[model()]}
          onVoiceModelDownload={(id) => asked.push(id)}
        />
      )
    )
    expect(container.textContent).toMatch(/465\.0 MB to fetch/)
    act(() => {
      container
        .querySelector<HTMLElement>('[data-testid="settings-voice-model-download"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(asked).toEqual(['ggml-small'])
  })

  it('offers a delete for an installed model, naming the disk it frees', () => {
    const asked: string[] = []
    act(() =>
      root.render(
        <VoiceModelRoster
          {...baseProps()}
          voiceModels={[model({ status: { kind: 'downloaded', size_bytes: 487_601_967 } })]}
          onVoiceModelDelete={(id) => asked.push(id)}
        />
      )
    )
    const del = container.querySelector<HTMLElement>('[data-testid="settings-voice-model-delete"]')!
    expect(del.textContent).toContain('frees 465.0 MB')
    act(() => del.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(asked).toEqual([])
    expect(del.textContent).toBe('Click again to delete')
    act(() => del.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(asked).toEqual(['ggml-small'])
  })

  it('disarms an armed model-delete on blur', () => {
    const asked: string[] = []
    act(() =>
      root.render(
        <VoiceModelRoster
          {...baseProps()}
          voiceModels={[model({ status: { kind: 'downloaded', size_bytes: 487_601_967 } })]}
          onVoiceModelDelete={(id) => asked.push(id)}
        />
      )
    )
    const del = container.querySelector<HTMLElement>('[data-testid="settings-voice-model-delete"]')!
    act(() => del.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(del.textContent).toBe('Click again to delete')
    act(() => del.dispatchEvent(new Event('focusout', { bubbles: true })))
    expect(del.textContent).toContain('frees 465.0 MB')
    act(() => del.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(asked).toEqual([])
  })

  it('shows a failed verification verbatim and refuses to retry while cooling down', () => {
    act(() =>
      root.render(
        <VoiceModelRoster
          {...baseProps()}
          voiceModels={[
            model({
              status: { kind: 'failed', reason: 'sha-256 mismatch for ggml-small' },
              cooldown_remaining_ms: 120_000
            })
          ]}
        />
      )
    )
    expect(container.textContent).toContain('sha-256 mismatch for ggml-small Repeated failures')
    expect(container.textContent).toContain('the next attempt is allowed in 120s')
    const retry = container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-voice-model-download"]'
    )!
    expect(retry.disabled).toBe(true)
  })

  it('marks the selected model as the one dictation uses', () => {
    act(() =>
      root.render(
        <VoiceModelRoster
          {...baseProps()}
          voiceModels={[model({ status: { kind: 'downloaded', size_bytes: 487_601_967 } })]}
          selectedModelId="ggml-small"
        />
      )
    )
    expect(container.textContent).toContain('This is the model dictation uses.')
  })

  it('selects an installed model separately from downloading it and exposes no selection', () => {
    const selected: string[] = []
    const downloaded: string[] = []
    act(() => root.render(<VoiceModelRoster {...baseProps()}
      voiceModels={[model({ status: { kind: 'downloaded', size_bytes: 487_601_967 } })]}
      onVoiceModelSelect={(id) => selected.push(id)}
      onVoiceModelDownload={(id) => downloaded.push(id)} />))
    expect(container.textContent).toContain('No local model selected')
    const use = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Use model')!
    act(() => use.click())
    expect(selected).toEqual(['ggml-small'])
    expect(downloaded).toEqual([])
  })

  it('offers explicit link and copy, names unsupported Parakeet and reports partial results', () => {
    const reused: unknown[] = []
    act(() => root.render(<VoiceModelRoster {...baseProps()} voiceModels={[model()]}
      voiceScanLimited
      voiceExternalModels={[
        { path: '/handy/model.bin', source: 'Handy', model_id: 'ggml-small', unsupported_reason: null },
        { path: '/handy/parakeet.onnx', source: 'Handy', model_id: null, unsupported_reason: 'Parakeet is not supported by the local Whisper engine' }
      ]}
      onVoiceModelReuse={(...args) => reused.push(args)} />))
    expect(container.textContent).toContain('Scan limit reached')
    expect(container.textContent).toContain('Parakeet · Unsupported')
    expect(container.textContent).toContain('SHA-256 matched')
    for (const label of ['Link', 'Copy']) {
      act(() => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)!.click())
    }
    expect(reused).toEqual([['ggml-small', '/handy/model.bin', false], ['ggml-small', '/handy/model.bin', true]])
  })

  it('removing a linked model advertises no external disk deletion', () => {
    act(() => root.render(<VoiceModelRoster {...baseProps()}
      voiceModels={[model({ linked: true, status: { kind: 'downloaded', size_bytes: 487_601_967 } })]} />))
    expect(container.textContent).toContain('Houston disk usage: 0 B')
    expect(container.textContent).toContain('Remove link')
    expect(container.textContent).not.toContain('frees 465.0 MB')
  })

  it('the Windows refusal exposes sizes without offering unusable downloads or selection', () => {
    act(() => root.render(<VoiceModelRoster {...baseProps()}
      voiceModels={[model({ unavailable_reason: 'Local Whisper is unavailable on Windows' })]} />))
    expect(container.textContent).toContain('465.0 MB')
    expect(container.textContent).toContain('Windows')
    expect(container.querySelector('[data-testid="settings-voice-model-download"]')).toBeNull()
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Use model')).toBe(false)
  })
})

describe('VoiceLevelMeter — microphone lifecycle', () => {
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

  it('opens the microphone on mount when dictation is on, and closes it on unmount', () => {
    const calls: boolean[] = []
    act(() =>
      root.render(
        <VoiceLevelMeter
          {...meterProps()}
          voiceSettings={{ enabled: true, rms_floor: DEFAULT_RMS_FLOOR }}
          onVoiceLevelMonitor={(on) => calls.push(on)}
        />
      )
    )
    expect(calls).toEqual([true])
    act(() => root.unmount())
    expect(calls).toEqual([true, false])
  })

  it('never opens the microphone for the meter while dictation is off', () => {
    const calls: boolean[] = []
    act(() =>
      root.render(
        <VoiceLevelMeter
          {...meterProps()}
          voiceSettings={{ enabled: false, rms_floor: DEFAULT_RMS_FLOOR }}
          onVoiceLevelMonitor={(on) => calls.push(on)}
        />
      )
    )
    expect(calls, 'the master switch gates the meter too').toEqual([])
    expect(container.textContent).toContain('Turn dictation on to see the live level')
  })

  it('closes the microphone while the window is hidden and reopens it on return', () => {
    const calls: boolean[] = []
    act(() =>
      root.render(
        <VoiceLevelMeter
          {...meterProps()}
          voiceSettings={{ enabled: true, rms_floor: DEFAULT_RMS_FLOOR }}
          onVoiceLevelMonitor={(on) => calls.push(on)}
        />
      )
    )
    expect(calls).toEqual([true])
    act(() => setDocumentHidden(true))
    expect(calls, 'a hidden window must not hold the microphone').toEqual([true, false])
    act(() => setDocumentHidden(true))
    expect(calls).toEqual([true, false])
    act(() => setDocumentHidden(false))
    expect(calls).toEqual([true, false, true])
    restoreDocumentVisibility()
  })

  it('does not open the microphone at all if the window is already hidden', () => {
    const calls: boolean[] = []
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden'
    })
    act(() =>
      root.render(
        <VoiceLevelMeter
          {...meterProps()}
          voiceSettings={{ enabled: true, rms_floor: DEFAULT_RMS_FLOOR }}
          onVoiceLevelMonitor={(on) => calls.push(on)}
        />
      )
    )
    expect(calls).toEqual([])
    restoreDocumentVisibility()
  })

  it('does not restart the monitor when the callback identity changes', () => {
    const calls: boolean[] = []
    const props = { ...meterProps(), voiceSettings: { enabled: true, rms_floor: DEFAULT_RMS_FLOOR } }
    act(() => root.render(<VoiceLevelMeter {...props} onVoiceLevelMonitor={(on) => calls.push(on)} />))
    expect(calls).toEqual([true])
    for (let i = 0; i < 5; i++) {
      act(() => root.render(<VoiceLevelMeter {...props} onVoiceLevelMonitor={(on) => calls.push(on)} />))
    }
    expect(calls, 'five re-renders must not touch the microphone').toEqual([true])
  })
})

describe('VoiceLevelMeter — the volume gate (v56)', () => {
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

  it('draws the threshold against the live level and round-trips a new one', () => {
    const seen: number[] = []
    act(() =>
      root.render(
        <VoiceLevelMeter
          {...meterProps()}
          voiceSettings={{ enabled: true, rms_floor: DEFAULT_RMS_FLOOR }}
          onRmsFloorSet={(n) => seen.push(n)}
        />
      )
    )
    act(() => setVoiceLevel(0.08))
    expect(container.querySelector('[data-testid="settings-voice-meter"]')).not.toBeNull()
    expect(container.textContent).toContain('0.010')
    expect(container.textContent).toContain('(default)')

    const slider = container.querySelector<HTMLInputElement>('[data-testid="settings-voice-rms-floor"]')!
    typeInto(slider, '0.045')
    expect(seen.at(-1)).toBeCloseTo(0.045, 5)
  })

  it('says "no signal" rather than showing a real zero when nothing is streaming', () => {
    act(() =>
      root.render(
        <VoiceLevelMeter
          {...meterProps()}
          voiceSettings={{ enabled: true, rms_floor: DEFAULT_RMS_FLOOR }}
        />
      )
    )
    expect(container.textContent).toContain('no signal')
  })

  it('offers a way back to the default once the threshold has been moved', () => {
    const seen: number[] = []
    act(() =>
      root.render(
        <VoiceLevelMeter
          {...meterProps()}
          voiceSettings={{ enabled: true, rms_floor: 0.09 }}
          onRmsFloorSet={(n) => seen.push(n)}
        />
      )
    )
    expect(container.textContent).not.toContain('(default)')
    const reset = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Reset')!
    act(() => reset.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(seen.at(-1)).toBe(DEFAULT_RMS_FLOOR)
  })
})
