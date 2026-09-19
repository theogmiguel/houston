import { useSyncExternalStore } from 'react'

const listeners = new Set<() => void>()
function emit(): void {
  for (const l of listeners) l()
}
function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

// Out-of-range falls back to `def`, never clamps: a stored value outside these
// bounds came from an older build with different bounds, and clamping would pin
// the user to a number they never chose and cannot see explained.
function loadBounded(key: string, def: number, min: number, max: number): number {
  try {
    const n = Number(localStorage.getItem(key))
    return Number.isFinite(n) && n >= min && n <= max ? Math.trunc(n) : def
  } catch {
    return def
  }
}

function save(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value))
  } catch {
  }
}

const PASS_THROUGH_KEY = 'tr-pass-through-to-terminal'

const PASS_THROUGH_DEFAULT = false

let passThrough: boolean =
  typeof localStorage !== 'undefined'
    ? (() => {
        try {
          const raw = localStorage.getItem(PASS_THROUGH_KEY)
          return raw === null ? PASS_THROUGH_DEFAULT : raw === '1'
        } catch {
          return PASS_THROUGH_DEFAULT
        }
      })()
    : PASS_THROUGH_DEFAULT

export function passKeysToTerminal(): boolean {
  return passThrough
}

export function setPassKeysToTerminal(next: boolean): void {
  if (next === passThrough) return
  passThrough = next
  try {
    localStorage.setItem(PASS_THROUGH_KEY, next ? '1' : '0')
  } catch {
  }
  emit()
}

export function usePassKeysToTerminal(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => passThrough,
    () => PASS_THROUGH_DEFAULT
  )
}

const IDLE_QUIET_KEY = 'tr-idle-quiet-ms'

export const IDLE_QUIET_MS_DEFAULT = 400
export const IDLE_QUIET_MS_MIN = 100
export const IDLE_QUIET_MS_MAX = 30_000

let idleQuietMs: number =
  typeof localStorage !== 'undefined'
    ? loadBounded(IDLE_QUIET_KEY, IDLE_QUIET_MS_DEFAULT, IDLE_QUIET_MS_MIN, IDLE_QUIET_MS_MAX)
    : IDLE_QUIET_MS_DEFAULT

export function idleQuietMsDefault(): number {
  return idleQuietMs
}

export function setIdleQuietMsDefault(next: number): void {
  const v = Math.trunc(next)
  if (!Number.isFinite(v) || v < IDLE_QUIET_MS_MIN || v > IDLE_QUIET_MS_MAX || v === idleQuietMs) {
    return
  }
  idleQuietMs = v
  save(IDLE_QUIET_KEY, v)
  emit()
}

export function useIdleQuietMsDefault(): number {
  return useSyncExternalStore(
    subscribe,
    () => idleQuietMs,
    () => IDLE_QUIET_MS_DEFAULT
  )
}

const STACK_CAP_KEY = 'tr-panes-per-stack'

export const STACK_CAP_DEFAULT = 4
export const STACK_CAP_MIN = 2
export const STACK_CAP_MAX = 8

let stackCap: number =
  typeof localStorage !== 'undefined'
    ? loadBounded(STACK_CAP_KEY, STACK_CAP_DEFAULT, STACK_CAP_MIN, STACK_CAP_MAX)
    : STACK_CAP_DEFAULT

export function stackCapacity(): number {
  return stackCap
}

export function setStackCapacity(next: number): void {
  const v = Math.trunc(next)
  if (!Number.isFinite(v) || v < STACK_CAP_MIN || v > STACK_CAP_MAX || v === stackCap) return
  stackCap = v
  save(STACK_CAP_KEY, v)
  emit()
}

export function useStackCapacity(): number {
  return useSyncExternalStore(
    subscribe,
    () => stackCap,
    () => STACK_CAP_DEFAULT
  )
}

export function setPaneCapsForTests(next: {
  passThrough?: boolean
  idleQuietMs?: number
  stackCap?: number
}): void {
  if (next.passThrough !== undefined) passThrough = next.passThrough
  if (next.idleQuietMs !== undefined) idleQuietMs = next.idleQuietMs
  if (next.stackCap !== undefined) stackCap = next.stackCap
  emit()
}
