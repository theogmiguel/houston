import { useSyncExternalStore } from 'react'
import { LEGACY_SETTINGS_SECTION, NAVIGABLE_SETTINGS_SECTIONS, type SettingsSectionId } from './settingsSections'

const SECTION_KEY = 'tr-settings-section'

const DEFAULT_SECTION: SettingsSectionId = 'appearance'

function isNavigable(v: unknown): v is SettingsSectionId {
  return NAVIGABLE_SETTINGS_SECTIONS.some((s) => s.id === v)
}

function canonical(v: unknown): SettingsSectionId | null {
  if (isNavigable(v)) return v
  if (typeof v === 'string') return LEGACY_SETTINGS_SECTION[v] ?? null
  return null
}

function load(): SettingsSectionId {
  try {
    const raw = localStorage.getItem(SECTION_KEY)
    return canonical(raw) ?? DEFAULT_SECTION
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

export function setSettingsSection(next: SettingsSectionId | string): void {
  const target = canonical(next)
  if (!target || target === section) return
  section = target
  try {
    localStorage.setItem(SECTION_KEY, target)
  } catch {
  }
  emit()
}

export function settingsSectionLabel(): string {
  return NAVIGABLE_SETTINGS_SECTIONS.find((item) => item.id === section)?.label ?? ''
}

export function shouldIgnoreInputKey(target: HTMLElement, event: KeyboardEvent, settingsOpen: boolean): boolean {
  return (
    ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName) &&
    event.key !== 'Escape' &&
    !(settingsOpen && event.ctrlKey && event.key === ',')
  )
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
  section?: SettingsSectionId | string
}): void {
  if (next.open !== undefined) open = next.open
  if (next.section !== undefined) section = canonical(next.section) ?? section
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
