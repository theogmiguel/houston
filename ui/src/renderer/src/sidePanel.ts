export type SideTab =
  | { kind: 'scm' }
  | { kind: 'files'; root?: string }
  | { kind: 'tasks'; compose?: boolean; openId?: number }
  | { kind: 'overview'; orchestrator: number }
  | { kind: 'browser'; id: string; url: string }

export interface SideState { tabs: SideTab[]; active: number }
export const SIDE_OPEN_EVENT = 'houston:side-open'
export const TERMINAL_FOCUS_EVENT = 'houston:terminal-focus'
export const SIDE_BROWSER_MOVE_EVENT = 'houston:side-browser-move'
export const SIDE_SELECT_EVENT = 'houston:side-select'
export type SideOpen = { kind: 'overview'; orchestrator: number } | { kind: 'tasks'; compose?: boolean; openId?: number } | { kind: 'files'; root: string; path: string; line?: number; col?: number } | { kind: 'browser'; id: string; url: string; workspace: string; revealOnly?: boolean }

export function openSideBrowser(id: string, url: string, workspace: string, revealOnly = false): void {
  window.dispatchEvent(new CustomEvent<SideOpen>(SIDE_OPEN_EVENT, { detail: { kind: 'browser', id, url, workspace, ...(revealOnly ? { revealOnly: true } : {}) } }))
}

// `compose` opens the tab with the create-task editor already up, which is
// what the palette's "New task" wants and a plain tab click does not; `openId`
// is a terminal `HOU-n` link asking for one task's detail.
export function openSideTasks(compose = false, openId?: number): void {
  window.dispatchEvent(new CustomEvent<SideOpen>(SIDE_OPEN_EVENT, { detail: { kind: 'tasks', ...(compose ? { compose: true } : {}), ...(openId !== undefined ? { openId } : {}) } }))
}

export function moveBrowserToGrid(id: string, url: string, workspace: string): void {
  window.dispatchEvent(new CustomEvent(SIDE_BROWSER_MOVE_EVENT, { detail: { id, url, workspace } }))
}

export function openSideOverview(orchestrator: number): void {
  window.dispatchEvent(new CustomEvent<SideOpen>(SIDE_OPEN_EVENT, { detail: { kind: 'overview', orchestrator } }))
}

export function selectOverviewChild(parent: number, child: number | null): void {
  window.dispatchEvent(new CustomEvent(SIDE_SELECT_EVENT, { detail: { parent, child } }))
  window.dispatchEvent(new CustomEvent(TERMINAL_FOCUS_EVENT, { detail: { session: child ?? parent } }))
}

export function loadSideState(workspace: string): SideState {
  const fallback: SideState = { tabs: [{ kind: 'scm' }, { kind: 'files' }, { kind: 'tasks' }], active: 0 }
  try {
    const value = JSON.parse(localStorage.getItem(`tr-side:${workspace}`) ?? 'null') as SideState | null
    if (!value || !Array.isArray(value.tabs)) return fallback
    const tabs: SideTab[] = [{ kind: 'scm' }, { kind: 'files', root: value.tabs.find((tab) => tab?.kind === 'files')?.root }, { kind: 'tasks' }]
    for (const tab of value.tabs) {
      if (tab?.kind === 'browser' && typeof tab.id === 'string' && typeof tab.url === 'string' && !tabs.some((item) => item.kind === 'browser' && item.id === tab.id)) tabs.push(tab)
      if (tab?.kind === 'overview' && Number.isSafeInteger(tab.orchestrator) && !tabs.some((item) => item.kind === 'overview' && item.orchestrator === tab.orchestrator)) tabs.push(tab)
    }
    return { tabs, active: Number.isInteger(value.active) && value.active >= 0 && value.active < tabs.length ? value.active : 0 }
  } catch { return fallback }
}

export function saveSideState(workspace: string, state: SideState): void {
  localStorage.setItem(`tr-side:${workspace}`, JSON.stringify(state))
}

export function reviewCheckoutDir(child: { project_dir: string; worktree?: { path: string } | null } | null): string | undefined {
  return child?.worktree?.path ?? child?.project_dir
}
