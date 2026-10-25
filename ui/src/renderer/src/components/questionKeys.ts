import { useEffect, useRef } from 'react'

export type QuestionKeyAction = { kind: 'type-instead' } | { kind: 'option'; id: string }

/** Which action a typed key means: option 1..n pick that option, n + 1 is the type-instead row. */
export function questionKeyAction(
  key: string,
  options: readonly { id: string }[] | undefined
): QuestionKeyAction | null {
  const n = Number(key)
  if (!Number.isInteger(n) || n < 1) return null
  if (n === (options?.length ?? 0) + 1) return { kind: 'type-instead' }
  const opt = options?.[n - 1]
  return opt ? { kind: 'option', id: opt.id } : null
}

/** Digits typed into a field, or with a modifier, belong to that field or shortcut. */
export function isDigitTarget(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return false
  const target = e.target
  return !(
    target instanceof HTMLElement &&
    target.closest('input, textarea, select, [contenteditable="true"]') !== null
  )
}

interface QuestionKeysConfig {
  active: boolean
  multi: boolean
  options: readonly { id: string }[] | undefined
  /** Whether this card takes a number key now; several cards can be mounted at once. */
  ownsShortcuts?: () => boolean
  onToggleOption?: (id: string) => void
  onSelectOption?: (id: string) => void
  onTypeInstead?: () => void
}

/** Number keys answer the card's options while it is `active`. */
export function useQuestionKeys({
  active,
  multi,
  options,
  ownsShortcuts,
  onToggleOption,
  onSelectOption,
  onTypeInstead
}: QuestionKeysConfig): void {
  const owns = useRef(ownsShortcuts)
  owns.current = ownsShortcuts

  useEffect(() => {
    if (!active) return
    const handler = (e: KeyboardEvent): void => {
      if (!isDigitTarget(e) || owns.current?.() === false) return
      const action = questionKeyAction(e.key, options)
      if (action === null) return
      if (action.kind === 'type-instead') onTypeInstead?.()
      else if (multi) onToggleOption?.(action.id)
      else onSelectOption?.(action.id)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [active, options, multi, onToggleOption, onSelectOption, onTypeInstead])
}
