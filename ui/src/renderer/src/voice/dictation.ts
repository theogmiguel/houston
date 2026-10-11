import type { CaptureMode } from '../houston/generated/CaptureMode'

export interface DictationConfig {
  enabled: boolean
  captureMode: CaptureMode
  start: (session: number) => void
  stop: (session: number) => void
}

let config: DictationConfig | null = null
let toggleActive: number | null = null
let holding: number | null = null

export function configureDictation(next: DictationConfig | null): void {
  config = next
  if (next === null || !next.enabled) toggleActive = null
}

export function dictationEnabled(): boolean {
  return config?.enabled === true
}

export function toggleActiveFor(): number | null {
  return toggleActive
}

export function dictationActiveFor(session: number): boolean {
  return holding === session || toggleActive === session
}

export function voiceChordDown(session: number): boolean {
  if (!config?.enabled) return false
  if (config.captureMode === 'toggle') {
    if (toggleActive === session) {
      toggleActive = null
      config.stop(session)
    } else if (toggleActive !== null) {
      const previous = toggleActive
      toggleActive = null
      config.stop(previous)
    } else {
      toggleActive = session
      config.start(session)
    }
    return true
  }
  if (holding === session) return true
  holding = session
  config.start(session)
  return true
}

export function voiceChordUp(session: number): boolean {
  if (!config?.enabled) return false
  if (config.captureMode === 'toggle') return false
  if (holding !== session) return false
  holding = null
  config.stop(session)
  return true
}

export function abandonDictation(session: number): void {
  if (holding === session) {
    holding = null
    config?.stop(session)
  }
  if (toggleActive === session) {
    toggleActive = null
    config?.stop(session)
  }
}

export function dictationFailed(session: number): void {
  if (holding === session) holding = null
  if (toggleActive === session) toggleActive = null
}

export function resetDictationForTests(): void {
  config = null
  holding = null
  toggleActive = null
}

export function forgetDictationSession(session: number): void {
  abandonDictation(session)
}
