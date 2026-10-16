import { useEffect, useRef } from 'react'
import type { KeymapOverrides } from '../../houston/generated/KeymapOverrides'
import { selectPane } from '../../keymap'
import { shouldIgnoreInputKey } from '../../settingsNav'

/** The digit 1..9 of an Alt-only chord, or null when the event is not one this feature may claim. */
export function altDigitOf(event: KeyboardEvent, overrides: KeymapOverrides): number | null {
  if (event.defaultPrevented || !event.altKey || event.ctrlKey || event.shiftKey || event.metaKey) return null
  const digit = /^Digit([1-9])$/.exec(event.code)?.[1] ?? (/^[1-9]$/.test(event.key) ? event.key : undefined)
  if (!digit) return null
  const target = event.target
  if (target instanceof HTMLElement && (shouldIgnoreInputKey(target, event, false) || target.isContentEditable)) return null
  // Pane selection rebound to a bare Alt chord owns it; shortcuts switched off release every chord.
  const paneChord = overrides.bindings[selectPane.id]
  if (!overrides.shortcuts_enabled || (paneChord?.alt && !paneChord.ctrl && !paneChord.shift && !paneChord.meta)) return null
  return Number(digit)
}

/** Alt+1..9 selects the Nth entry of `order`, whichever element has focus. */
export function useAltDigitJump<T>(order: readonly T[], select: ((entry: T) => void) | undefined, enabled: boolean, overrides: KeymapOverrides): void {
  const latest = useRef({ order, select, enabled, overrides })
  latest.current = { order, select, enabled, overrides }
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const { order: current, select: choose, enabled: on, overrides: keymap } = latest.current
      const digit = on ? altDigitOf(event, keymap) : null
      const entry = digit === null ? undefined : current[digit - 1]
      if (entry === undefined || !choose) return
      event.preventDefault()
      choose(entry)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
