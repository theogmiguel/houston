import { useSyncExternalStore } from 'react'
import { NAVIGABLE_SETTINGS_SECTIONS, type SettingsSectionId } from './settingsSections'

const SECTION_KEY = 'tr-settings-section'

const DEFAULT_SECTION: SettingsSectionId = 'appearance'

function isNavigable(v: unknown): v is SettingsSectionId {
  return NAVIGABLE_SETTINGS_SECTIONS.some((s) => s.id === v)
}

function load(): SettingsSectionId {
  try {
    const raw = localStorage.getItem(SECTION_KEY)
    return isNavigable(raw) ? raw : DEFAULT_SECTION
  } catch {
    return DEFAULT_SECTION
  }
}

let open = false
let section: SettingsSectionId = typeof localStorage !== 'undefined' ? load() : DEFAULT_SECTION
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

export function setSettingsOpen(next: boolean): void {
  if (next === open) return
  open = next
  emit()
}

export function toggleSettingsOpen(): void {
  open = !open
  emit()
}

export function isSettingsOpen(): boolean {
  return open
}

export function setSettingsSection(next: SettingsSectionId): void {
  if (!isNavigable(next) || next === section) return
  section = next
  try {
    localStorage.setItem(SECTION_KEY, next)
  } catch {
  }
  emit()
}

export function openSettings(at?: SettingsSectionId): void {
  if (at) setSettingsSection(at)
  setSettingsOpen(true)
}

export function closeSettings(): void {
  setSettingsOpen(false)
}

export function setSettingsNavForTests(next: {
  open?: boolean
  section?: SettingsSectionId
}): void {
  if (next.open !== undefined) open = next.open
  if (next.section !== undefined && isNavigable(next.section)) section = next.section
  emit()
}

export function useSettingsOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => open,
    () => false
  )
}

export function useSettingsSection(): SettingsSectionId {
  return useSyncExternalStore(
    subscribe,
    () => section,
    () => DEFAULT_SECTION
  )
}
