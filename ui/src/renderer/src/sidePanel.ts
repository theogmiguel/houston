import { loadInspectorTabs, saveInspectorTabs, saveBrowserTabUrl } from './scmPanel'
/// A task the palette already assembled from a terminal selection.
export interface TaskDraft { title: string; description: string }

export const SIDE_OPEN_EVENT = 'houston:side-open'
export const TASKS_OPEN_EVENT = 'houston:tasks-open'
export const TERMINAL_FOCUS_EVENT = 'houston:terminal-focus'
export const SIDE_SELECT_EVENT = 'houston:side-select'
export type SideOpen = { kind: 'overview'; orchestrator: number } | { kind: 'files'; root: string; path: string; line?: number; col?: number } | { kind: 'browser'; id: string; url: string; workspace: string; action?: 'open' | 'reveal' | 'close' }

export function openSideBrowser(id: string, url: string, workspace: string, action: 'open' | 'reveal' | 'close' = 'open'): void {
  updateSideBrowser(id, url, workspace, action)
  window.dispatchEvent(new CustomEvent<SideOpen>(SIDE_OPEN_EVENT, { detail: { kind: 'browser', id, url, workspace, action } }))
}

export function updateSideBrowser(id: string, url: string, workspace: string, action: 'open' | 'reveal' | 'close'): void {
  const state = loadInspectorTabs(workspace)
  const surface = `browser:${id}` as const
  if (action === 'close') {
    state.openTabs = state.openTabs.filter((tab) => tab !== surface)
    if (state.active === surface) state.active = state.openTabs.at(-1) ?? null
    localStorage.removeItem(`tr-inspector-browser-url:${workspace}:${id}`)
  } else if (action === 'open') {
    saveBrowserTabUrl(workspace, id, url)
    if (!state.openTabs.includes(surface)) state.openTabs.push(surface)
    state.active = surface
  } else if (state.openTabs.includes(surface)) state.active = surface
  saveInspectorTabs(workspace, state)
}

// Opens the Tasks page, optionally focused on a task or a task draft.
export function openSideTasks(compose = false, openId?: number, create?: TaskDraft): void {
  window.dispatchEvent(new CustomEvent(TASKS_OPEN_EVENT, { detail: { compose, ...(openId !== undefined ? { openId } : {}), ...(create !== undefined ? { create } : {}) } }))
}

export function openSideOverview(orchestrator: number): void {
  window.dispatchEvent(new CustomEvent<SideOpen>(SIDE_OPEN_EVENT, { detail: { kind: 'overview', orchestrator } }))
}

export function selectOverviewChild(parent: number, child: number | null): void {
  window.dispatchEvent(new CustomEvent(SIDE_SELECT_EVENT, { detail: { parent, child } }))
  window.dispatchEvent(new CustomEvent(TERMINAL_FOCUS_EVENT, { detail: { session: child ?? parent } }))
}

export function reviewCheckoutDir(child: { project_dir: string; worktree?: { path: string } | null } | null): string | undefined {
  return child?.worktree?.path ?? child?.project_dir
}
