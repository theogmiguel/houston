// 3 reloads inside 10 minutes is the hard stop: when the app boots with the
// budget already spent, main.tsx renders the halt screen instead of the app,
// handing control back rather than spinning a crash/reload loop forever.
const KEY = 'tr-reload-times'
const BUDGET = 3
const WINDOW_MS = 10 * 60_000

function recent(): number[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    if (!Array.isArray(raw)) return []
    return raw.filter((t): t is number => typeof t === 'number' && Date.now() - t < WINDOW_MS)
  } catch {
    return []
  }
}

export function recordAndReload(): void {
  localStorage.setItem(KEY, JSON.stringify([...recent(), Date.now()]))
  window.location.reload()
}

export function reloadStormDetected(): boolean {
  return recent().length >= BUDGET
}

export function resetReloadBudget(): void {
  localStorage.removeItem(KEY)
}
