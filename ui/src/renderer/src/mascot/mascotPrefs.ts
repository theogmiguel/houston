import { useSyncExternalStore } from 'react'

export interface MascotPrefs {
  enabled: boolean
  style: 'rig' | 'pixel'
  colors: 'classic' | 'aurora' | 'sunset' | 'mono'
  hat: 'none' | 'beanie' | 'cap' | 'crown'
  holidays: boolean
  sounds: boolean
  breaks: boolean
  nap: boolean
  background: boolean
}
export const DEFAULT_PREFS: MascotPrefs = { enabled: true, style: 'rig', colors: 'classic', hat: 'none', holidays: true, sounds: false, breaks: false, nap: true, background: false }
const choices = { style: ['rig', 'pixel'], colors: ['classic', 'aurora', 'sunset', 'mono'], hat: ['none', 'beanie', 'cap', 'crown'] }
export function readMascotPrefs(storage: Pick<Storage, 'getItem'> | undefined): MascotPrefs {
  const result = { ...DEFAULT_PREFS }
  for (const key of Object.keys(result) as (keyof MascotPrefs)[]) {
    try {
      const raw = storage?.getItem(`tr-mascot-${key}`)
      if (typeof result[key] === 'boolean') {
        if (raw === '1' || raw === '0') Object.assign(result, { [key]: raw === '1' })
      } else if (key in choices && raw && choices[key as keyof typeof choices].includes(raw)) Object.assign(result, { [key]: raw })
    } catch { /* Storage can be unavailable in a restricted webview. */ }
  }
  return result
}
export function mascotFirstSeen(): string {
  const date = new Date()
  const today = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`
  try {
    const stored=localStorage.getItem('tr-mascot-first-seen')
    if(stored && /^\d{4}-\d{2}-\d{2}$/.test(stored) && Number.isFinite(new Date(stored).getTime())) return stored
    localStorage.setItem('tr-mascot-first-seen',today)
  } catch { /* Retain the local clock fallback when storage is unavailable. */ }
  return today
}
const firstSeen = mascotFirstSeen()
export const getMascotFirstSeen = (): string => firstSeen
let prefs = readMascotPrefs(typeof localStorage === 'undefined' ? undefined : localStorage)
const listeners = new Set<() => void>()
const subscribe = (cb: () => void): (() => void) => { listeners.add(cb); return () => { listeners.delete(cb) } }
export const getMascotPrefs = (): MascotPrefs => prefs
export function setMascotPrefs(next: Partial<MascotPrefs>): void {
  prefs = { ...prefs, ...next }
  if(!prefs.enabled)pendingAction=undefined
  for (const key of Object.keys(next) as (keyof MascotPrefs)[]) {
    try { localStorage.setItem(`tr-mascot-${key}`, typeof prefs[key] === 'boolean' ? prefs[key] ? '1' : '0' : String(prefs[key])) } catch { /* Keep the current session usable without storage. */ }
  }
  listeners.forEach((cb) => cb())
}
export function setMascotPrefsForTests(next: MascotPrefs): void { prefs = next; listeners.forEach((cb) => cb()) }
export const useMascotPrefs = (): MascotPrefs => useSyncExternalStore(subscribe, getMascotPrefs, () => DEFAULT_PREFS)
export type MascotAction = 'pet' | 'hi' | 'disco' | 'game' | 'intro'
let pendingAction: MascotAction | undefined
export function consumeMascotAction(): MascotAction | undefined { const action=pendingAction;pendingAction=undefined;return action }
export function requestMascotAction(action: MascotAction): void {
  if (prefs.enabled) {pendingAction=action;window.dispatchEvent(new CustomEvent('houston-mascot-action', { detail: action }))}
}
