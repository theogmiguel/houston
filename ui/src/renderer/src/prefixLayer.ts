import type { KeymapOverrides } from './houston/generated/KeymapOverrides'
import { isModifierKeydown, prefixShortcut, resolveGlobalMatch } from './keymap'

// After the prefix chord, the next key is a Houston shortcut even while a terminal owns
// the keyboard; then the layer is down. An external store, so the pane handler, the app
// dispatcher and the hint overlay share one state without props through the tree.

// The layer waits for a key while the hint is up: a 1 s timeout left the hint readable
// for 750 ms. This is only a safety net, so a forgotten prefix does not turn a key
// typed minutes later into a command.
export const PREFIX_TIMEOUT_MS = 8000

// The hint appears only when the second key does not come at once, so a practiced
// `prefix, key` never flashes it.
export const PREFIX_HINT_DELAY_MS = 250

type Listener = () => void

let armed = false
let timer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<Listener>()

function emit(): void {
  for (const l of listeners) l()
}

export const prefixLayer = {
  isArmed(): boolean {
    return armed
  },
  arm(): void {
    if (timer) clearTimeout(timer)
    armed = true
    timer = setTimeout(() => {
      timer = null
      if (!armed) return
      armed = false
      emit()
    }, PREFIX_TIMEOUT_MS)
    emit()
  },
  disarm(): void {
    if (timer) clearTimeout(timer)
    timer = null
    if (!armed) return
    armed = false
    emit()
  },
  subscribe(l: Listener): () => void {
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }
}

// ghostty stops propagation of every key it encodes, so the pane re-emits the key that
// follows the prefix on `window`. The clone has no target element, so the dispatcher's
// input/textarea guard lets it through.
export const LAYER_KEY_MARK = 'houstonPrefixLayer'

export function forwardLayerKey(e: KeyboardEvent): void {
  const clone = new KeyboardEvent('keydown', {
    key: e.key,
    code: e.code,
    ctrlKey: e.ctrlKey,
    altKey: e.altKey,
    shiftKey: e.shiftKey,
    metaKey: e.metaKey,
    repeat: e.repeat,
    bubbles: false,
    cancelable: true
  })
  Object.defineProperty(clone, LAYER_KEY_MARK, { value: true })
  window.dispatchEvent(clone)
}

// True when the layer took the key; false when it is the terminal's, including a second
// prefix press (it sends the chord itself) and any prefix while the pane is dictating,
// so the prefix never arms over a dictation in progress.
export function claimLayerKey(
  e: KeyboardEvent,
  overrides: KeymapOverrides,
  dictating: boolean
): boolean {
  if (dictating) return false
  if (resolveGlobalMatch(prefixShortcut, overrides)(e)) {
    if (armed) {
      prefixLayer.disarm()
      return false
    }
    prefixLayer.arm()
    return true
  }
  if (armed && !isModifierKeydown(e)) {
    forwardLayerKey(e)
    return true
  }
  return false
}

export function isLayerKey(e: KeyboardEvent): boolean {
  return (e as unknown as Record<string, unknown>)[LAYER_KEY_MARK] === true
}
