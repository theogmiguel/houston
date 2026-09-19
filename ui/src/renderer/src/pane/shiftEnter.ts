export const SHIFT_ENTER_KEY = 'tr-shift-enter-newline'

export function shiftEnterSequence(
  e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'>,
  enabled: boolean
): string | null {
  if (!enabled) return null
  if (e.key !== 'Enter') return null
  if (!e.shiftKey) return null
  if (e.ctrlKey || e.altKey || e.metaKey) return null
  return BRACKETED_NEWLINE
}

// `\r`, not `\n`, inside the bracketed-paste markers: terminals deliver Enter
// as CR and pasted multi-line text arrives with CR endings, so this is
// byte-identical to a real paste — the exact claim the feature makes.
export const BRACKETED_NEWLINE = '\x1b[200~\r\x1b[201~'

export function shiftEnterEnabled(): boolean {
  try {
    return localStorage.getItem(SHIFT_ENTER_KEY) !== '0'
  } catch {
    return true
  }
}
