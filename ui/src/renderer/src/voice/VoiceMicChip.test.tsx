// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DictationIndicator } from './DictationIndicator'
import { VoiceMicChip } from './VoiceMicChip'
import {
  registerVoiceNotice,
  resetVoiceStoreForTests,
  setVoiceIndicator,
  showVoiceNotice
} from './store'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

const noTitle = (): string | null => null

function chip(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-testid="voice-mic-chip"]')
}

describe('VoiceMicChip', () => {
  it('renders nothing at all when no pane is dictating', () => {
    act(() => root.render(<VoiceMicChip paneTitle={noTitle} />))
    expect(chip()).toBeNull()
  })

  it('appears while listening and names the pane the text will land in', () => {
    act(() => root.render(<VoiceMicChip paneTitle={(s) => (s === 4 ? 'bold-otter' : null)} />))
    act(() => setVoiceIndicator(4, { kind: 'listening' }))
    const el = chip()!
    expect(el).not.toBeNull()
    expect(el.getAttribute('data-voice-state')).toBe('listening')
    expect(el.getAttribute('aria-label')).toContain('bold-otter')
    expect(el.getAttribute('aria-label')).toContain('Ctrl+Shift+Space')
  })

  it('falls back to the pane id when the title cannot be resolved', () => {
    act(() => root.render(<VoiceMicChip paneTitle={noTitle} />))
    act(() => setVoiceIndicator(9, { kind: 'listening' }))
    expect(chip()!.getAttribute('aria-label')).toContain('pane 9')
  })

  it('stays up, unblinking, through transcription', () => {
    act(() => root.render(<VoiceMicChip paneTitle={noTitle} />))
    act(() => setVoiceIndicator(1, { kind: 'transcribing' }))
    const el = chip()!
    expect(el.getAttribute('data-voice-state')).toBe('transcribing')
    expect(el.className, 'only recording blinks').not.toContain('dot-pulse')
  })

  it('blinks while recording, and is announced rather than only shown', () => {
    act(() => root.render(<VoiceMicChip paneTitle={noTitle} />))
    act(() => setVoiceIndicator(1, { kind: 'listening' }))
    const el = chip()!
    expect(el.className).toContain('dot-pulse')
    expect(el.getAttribute('role')).toBe('status')
  })

  it('goes away when the dictation ends', () => {
    act(() => root.render(<VoiceMicChip paneTitle={noTitle} />))
    act(() => setVoiceIndicator(1, { kind: 'listening' }))
    expect(chip()).not.toBeNull()
    act(() => setVoiceIndicator(1, null))
    expect(chip()).toBeNull()
  })

  it('ignores the one state that stayed in the pane', () => {
    act(() => root.render(<VoiceMicChip paneTitle={noTitle} />))
    act(() => setVoiceIndicator(1, { kind: 'pending', text: 'hello there' }))
    expect(chip()).toBeNull()
  })
})

describe('DictationIndicator — what stays over the pane', () => {
  it('no longer covers the terminal while listening or transcribing', () => {
    act(() => root.render(<DictationIndicator session={1} />))
    act(() => setVoiceIndicator(1, { kind: 'listening' }))
    expect(container.querySelector('[data-testid="voice-indicator"]')).toBeNull()
    act(() => setVoiceIndicator(1, { kind: 'transcribing' }))
    expect(container.querySelector('[data-testid="voice-indicator"]')).toBeNull()
  })

  it('still shows a transcript awaiting approval, next to the prompt it is for', () => {
    act(() => root.render(<DictationIndicator session={1} />))
    act(() => setVoiceIndicator(1, { kind: 'pending', text: 'deploy the thing' }))
    expect(container.querySelector('[data-testid="voice-pending"]')?.textContent).toBe(
      'deploy the thing'
    )
  })

  it('no longer paints a failure across the pane', () => {
    act(() => root.render(<DictationIndicator session={1} />))
    act(() => showVoiceNotice(1, 'Too short to transcribe — 0.09s captured, 0.30s minimum.'))
    expect(container.querySelector('[data-testid="voice-indicator"]')).toBeNull()
    expect(container.querySelector('[data-testid="voice-error"]')).toBeNull()
  })
})

describe('momentary failures reach the pane that was listening', () => {
  it('delivers the message, numbers and all, to that pane and no other', () => {
    const pane1: string[] = []
    const pane2: string[] = []
    registerVoiceNotice(1, (m) => pane1.push(m))
    registerVoiceNotice(2, (m) => pane2.push(m))

    expect(showVoiceNotice(1, 'Too short to transcribe — 0.09s captured, 0.30s minimum.')).toBe(
      true
    )
    expect(pane1).toEqual(['Too short to transcribe — 0.09s captured, 0.30s minimum.'])
    expect(pane2).toEqual([])
  })

  it('reports a miss so the caller can fall back to app scope', () => {
    expect(showVoiceNotice(99, 'Too quiet to transcribe — measured RMS 0.0031, floor 0.0100.')).toBe(
      false
    )
  })

  it('stops delivering once the pane unregisters', () => {
    const seen: string[] = []
    const off = registerVoiceNotice(7, (m) => seen.push(m))
    off()
    expect(showVoiceNotice(7, 'No speech detected.')).toBe(false)
    expect(seen).toEqual([])
  })
})
