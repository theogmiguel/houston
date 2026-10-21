import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { KeymapOverridesContext } from '../../layout/keymapOverridesContext'
import { chordMatchesEvent, diffFindShortcut } from '../../keymap'
import type { KeymapOverrides } from '../../houston/generated/KeymapOverrides'
import { findInDiff, lineMarkKey, marksByLine, stepMatch, type DiffFindResult, type DiffFindSource, type DiffMarksLookup } from './diffFind'

export interface DiffFindController {
  open: boolean
  term: string
  caseSensitive: boolean
  result: DiffFindResult
  active: number
  truncated: boolean
  lookup: DiffMarksLookup | null
  inputRef: React.RefObject<HTMLInputElement | null>
  rootRef: (element: HTMLElement | null) => void
  onKeyDownCapture: (event: React.KeyboardEvent) => void
  setTerm: (term: string) => void
  toggleCase: () => void
  step: (delta: 1 | -1) => void
  close: () => void
}

export function diffFindMatches(event: KeyboardEvent, overrides: KeymapOverrides): boolean {
  if (!overrides.shortcuts_enabled) return false
  return chordMatchesEvent(overrides.bindings[diffFindShortcut.id] ?? diffFindShortcut.chord!, event)
}

const EMPTY: DiffFindResult = { matches: [], capped: false }

/** Find over loaded patch text; `onReveal` opens a collapsed source before its match scrolls into view. */
export function useDiffFind(sources: readonly DiffFindSource[], onReveal?: (key: string) => void): DiffFindController {
  const overrides = useContext(KeymapOverridesContext)
  const [open, setOpen] = useState(false)
  const [term, setTermState] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const rootRef = useRef<HTMLElement | null>(null)
  const revealRef = useRef(onReveal)
  revealRef.current = onReveal
  const scrollPending = useRef(false)

  const result = useMemo(() => (open ? findInDiff(sources, term, caseSensitive) : EMPTY), [open, sources, term, caseSensitive])
  const index = result.matches.length === 0 ? 0 : Math.min(active, result.matches.length - 1)
  const current = result.matches[index]
  const byLine = useMemo(() => marksByLine(result.matches, index), [result, index])
  const lookup = useMemo<DiffMarksLookup | null>(() => (open && term.length > 0 ? (key, line) => byLine.get(lineMarkKey(key, line)) : null), [open, term, byLine])

  useEffect(() => {
    if (!current) return
    revealRef.current?.(current.key)
    scrollPending.current = true
  }, [current?.key, current?.line, current?.start]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!scrollPending.current) return
    const mark = rootRef.current?.querySelector('[data-diff-find-active]')
    if (!mark) return
    scrollPending.current = false
    mark.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  })

  const focusInput = (): void => {
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }

  return {
    open,
    term,
    caseSensitive,
    result,
    active: index,
    truncated: sources.some((source) => source.truncated),
    lookup,
    inputRef,
    rootRef: (element) => { rootRef.current = element },
    onKeyDownCapture: (event) => {
      if (!diffFindMatches(event.nativeEvent, overrides)) return
      event.preventDefault()
      event.stopPropagation()
      setOpen(true)
      focusInput()
    },
    setTerm: (next) => {
      setTermState(next)
      setActive(0)
    },
    toggleCase: () => {
      setCaseSensitive((value) => !value)
      setActive(0)
    },
    step: (delta) => {
      scrollPending.current = true
      const total = result.matches.length
      setActive((current) => stepMatch(Math.min(current, Math.max(0, total - 1)), total, delta))
    },
    close: () => {
      setOpen(false)
      rootRef.current?.focus({ preventScroll: true })
    }
  }
}
