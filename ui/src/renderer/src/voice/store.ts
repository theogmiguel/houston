import { useSyncExternalStore } from 'react'
import type { VoiceFailure } from '../houston/generated/VoiceFailure'

export type VoiceIndicator =
  | { kind: 'listening' }
  | { kind: 'transcribing' }
  | { kind: 'pending'; text: string }

const indicators = new Map<number, VoiceIndicator>()
const indicatorListeners = new Set<() => void>()
let pageError: string | null = null
const pageErrorListeners = new Set<() => void>()

function notifyIndicators(): void {
  for (const l of indicatorListeners) l()
}

function notifyPageError(): void {
  for (const l of pageErrorListeners) l()
}

export function setVoiceIndicator(session: number, indicator: VoiceIndicator | null): void {
  if (indicator === null) {
    if (!indicators.delete(session)) return
  } else {
    indicators.set(session, indicator)
  }
  notifyIndicators()
}

export function clearVoiceIndicators(): void {
  if (indicators.size === 0) return
  indicators.clear()
  notifyIndicators()
}

export function voiceIndicatorFor(session: number): VoiceIndicator | null {
  return indicators.get(session) ?? null
}

export function useVoiceIndicator(session: number): VoiceIndicator | null {
  return useSyncExternalStore(
    (onChange) => {
      indicatorListeners.add(onChange)
      return () => indicatorListeners.delete(onChange)
    },
    () => indicators.get(session) ?? null
  )
}

let level: number | null = null
const levelListeners = new Set<() => void>()

export function setVoiceLevel(rms: number | null): void {
  if (level === rms) return
  level = rms
  for (const l of levelListeners) l()
}

export function useVoiceLevel(): number | null {
  return useSyncExternalStore(
    (onChange) => {
      levelListeners.add(onChange)
      return () => levelListeners.delete(onChange)
    },
    () => level
  )
}

export function useVoiceActivity(): { kind: 'listening' | 'transcribing'; session: number } | null {
  return useSyncExternalStore(
    (onChange) => {
      indicatorListeners.add(onChange)
      return () => indicatorListeners.delete(onChange)
    },
    getVoiceActivity
  )
}

let activityCache: { kind: 'listening' | 'transcribing'; session: number } | null = null

function getVoiceActivity(): { kind: 'listening' | 'transcribing'; session: number } | null {
  let found: { kind: 'listening' | 'transcribing'; session: number } | null = null
  for (const [session, ind] of indicators) {
    if (ind.kind === 'listening' || ind.kind === 'transcribing') {
      found = { kind: ind.kind, session }
      break
    }
  }
  if (found?.kind === activityCache?.kind && found?.session === activityCache?.session) {
    return activityCache
  }
  activityCache = found
  return activityCache
}

export function setVoicePageError(message: string | null): void {
  if (pageError === message) return
  pageError = message
  notifyPageError()
}

export function useVoicePageError(): string | null {
  return useSyncExternalStore(
    (onChange) => {
      pageErrorListeners.add(onChange)
      return () => pageErrorListeners.delete(onChange)
    },
    () => pageError
  )
}

export type VoiceInsert = (text: string) => boolean

const inserters = new Map<number, VoiceInsert>()

export function registerVoiceInsert(session: number, insert: VoiceInsert): () => void {
  inserters.set(session, insert)
  return () => {
    if (inserters.get(session) === insert) inserters.delete(session)
  }
}

export type VoiceNotice = (message: string) => void

const noticers = new Map<number, VoiceNotice>()

export function registerVoiceNotice(session: number, notice: VoiceNotice): () => void {
  noticers.set(session, notice)
  return () => {
    if (noticers.get(session) === notice) noticers.delete(session)
  }
}

export function showVoiceNotice(session: number, message: string): boolean {
  const notice = noticers.get(session)
  if (!notice) return false
  notice(message)
  return true
}

export function insertVoiceText(session: number, text: string): boolean {
  const insert = inserters.get(session)
  if (!insert) return false
  return insert(text)
}

export function resetVoiceStoreForTests(): void {
  indicators.clear()
  inserters.clear()
  noticers.clear()
  pageError = null
  level = null
  activityCache = null
}

export function voiceFailureMessage(failure: VoiceFailure): string {
  switch (failure.kind) {
    case 'no_model':
      return `No speech model installed (${failure.model_id}) — download it in Settings → Voice.`
    case 'missing_key':
      return `No ${failure.provider} API key stored — add one in Settings → Voice, or switch back to the local engine.`
    case 'device_unavailable':
      return `Microphone unavailable: ${failure.device}`
    case 'too_quiet':
      return `Too quiet to transcribe — measured RMS ${failure.rms.toFixed(4)}, floor ${failure.floor.toFixed(4)}.`
    case 'too_short':
      return `Too short to transcribe — ${failure.seconds.toFixed(2)}s captured, ${failure.minimum.toFixed(2)}s minimum.`
    case 'ring_buffer_overrun':
      return `Audio dropped: ${failure.dropped} samples were lost, so the transcript has a gap.`
    case 'no_speech':
      return 'No speech detected.'
    case 'target_gone':
      return `Pane ${failure.session} closed before the transcript arrived — the text was dropped, not sent somewhere else.`
    case 'engine':
      return failure.message
  }
}

export function isPersistentVoiceFailure(failure: VoiceFailure): boolean {
  return (
    failure.kind === 'no_model' ||
    failure.kind === 'missing_key' ||
    failure.kind === 'device_unavailable'
  )
}
