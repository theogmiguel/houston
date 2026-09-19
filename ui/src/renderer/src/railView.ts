import { useSyncExternalStore } from 'react'

export const RAIL_VIEWS = ['skills', 'routines', 'mcp'] as const

export type RailView = (typeof RAIL_VIEWS)[number]

export const RAIL_VIEW_LABEL: Readonly<Record<RailView, string>> = Object.freeze({
  skills: 'Skills',
  routines: 'Routines',
  mcp: 'Connections'
})

const HIDDEN_KEY = 'tr-rail-views-hidden'

const EMPTY: ReadonlySet<RailView> = new Set()

function isRailView(v: unknown): v is RailView {
  return (RAIL_VIEWS as readonly unknown[]).includes(v)
}

function loadHidden(): ReadonlySet<RailView> {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY)
    if (raw === null) return new Set()
    const parsed: unknown = JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? parsed.filter(isRailView) : [])
  } catch {
    return new Set()
  }
}

let view: RailView | null = null
let hidden: ReadonlySet<RailView> =
  typeof localStorage !== 'undefined' ? loadHidden() : new Set()
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

export function setRailView(next: RailView | null): void {
  if (next === view) return
  view = next
  emit()
}

export function toggleRailView(next: RailView): void {
  setRailView(view === next ? null : next)
}

export function getRailView(): RailView | null {
  return view
}

export function isRailViewHidden(v: RailView): boolean {
  return hidden.has(v)
}

export function setRailViewHidden(v: RailView, next: boolean): void {
  if (hidden.has(v) === next) return
  const updated = new Set(hidden)
  if (next) updated.add(v)
  else updated.delete(v)
  hidden = updated
  if (next && view === v) view = null
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...updated]))
  } catch {
  }
  emit()
}

export function setRailViewForTests(next: {
  view?: RailView | null
  hidden?: readonly RailView[]
}): void {
  if (next.view !== undefined) view = next.view
  if (next.hidden !== undefined) hidden = new Set(next.hidden)
  emit()
}

export function useRailView(): RailView | null {
  return useSyncExternalStore(
    subscribe,
    () => view,
    () => null
  )
}

export function useHiddenRailViews(): ReadonlySet<RailView> {
  return useSyncExternalStore(
    subscribe,
    () => hidden,
    () => EMPTY
  )
}
