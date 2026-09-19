import type { CaptureMode } from '../houston/generated/CaptureMode'
import type { VoiceOutputMode } from '../houston/generated/VoiceOutputMode'

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
  preambled.clear()
}

const preambled = new Set<number>()

export function forgetDictationSession(session: number): void {
  preambled.delete(session)
  abandonDictation(session)
}

// Prepended to the dictated text rather than installed as a system-prompt note:
// nothing is written into the agent CLI's own config, and turning the setting
// off removes it with no cleanup step.
export const AGENT_PREAMBLE =
  'The following was dictated in Brazilian Portuguese and machine-translated to English; ' +
  'treat wording quirks as transcription artefacts, and write your final answer back in ' +
  'Brazilian Portuguese.'

export interface InsertionPolicy {
  outputMode: VoiceOutputMode
  agentPreamble: boolean
}

export function buildDictationInsert(
  text: string,
  policy: InsertionPolicy,
  alreadyPreambled: boolean
): string {
  const body = text.trim()
  if (body === '') return ''
  const wantsPreamble =
    policy.agentPreamble && policy.outputMode === 'english' && !alreadyPreambled
  return wantsPreamble ? `${AGENT_PREAMBLE} ${body} ` : `${body} `
}

export function dictationTextFor(
  session: number,
  text: string,
  policy: InsertionPolicy
): string {
  const already = preambled.has(session)
  const out = buildDictationInsert(text, policy, already)
  if (out !== '' && !already && policy.agentPreamble && policy.outputMode === 'english') {
    preambled.add(session)
  }
  return out
}
