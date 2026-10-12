// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deliverControl, makeSession, makeWorkspace, renderReadyApp, resetHarness, type AppHarness } from './test/appTestHarness'
import { leaf, type LayoutNode } from './layout/tree'

const readiness = vi.hoisted(() => ({
  snapshot: { sessionSlots: new Set<number>(), workspaces: false, discovering: false },
  listeners: new Set<() => void>()
}))
vi.mock('./houston/environments', async (importOriginal) => ({
  ...await importOriginal<typeof import('./houston/environments')>(),
  getEnvironmentRosterPending: () => readiness.snapshot,
  subscribeEnvironmentRosterPending: (listener: () => void) => {
    readiness.listeners.add(listener)
    return () => { readiness.listeners.delete(listener) }
  }
}))

const LOCAL = '/tmp/project'
const WSL = '/home/test/project'
const origin = 0x80000000 + 7
const firstReplacement = 0x80000000 + 17
const secondReplacement = 0x80000000 + 27
const localWorkspace = () => makeWorkspace({ path: LOCAL, name: 'Local project' })
const wslWorkspace = () => makeWorkspace({ path: WSL, name: 'WSL project' })
const localSession = () => makeSession({ id: 1, project_dir: LOCAL })
const wslSession = (id: number) => makeSession({ id, agent: 'claude', project_dir: WSL, session_origin: origin, resumable: true, status: 'working' })
const saved: LayoutNode = {
  kind: 'split', dir: 'row', weights: [70, 30],
  children: [leaf(origin, 'saved-wsl-slot'), leaf(1, 'saved-local-slot')]
}
let app: AppHarness | undefined

function pending(slots: number[], workspaces = true, discovering = false): void {
  act(() => {
    readiness.snapshot = { sessionSlots: new Set(slots), workspaces, discovering }
    for (const listener of readiness.listeners) listener()
  })
}

beforeEach(() => {
  resetHarness()
  localStorage.clear()
  pending([], false)
})
afterEach(() => { app?.unmount(); app = undefined })

function selectedName(): string | null {
  return app!.container.querySelector('.witem[role="button"][aria-current="true"]')?.textContent ?? null
}
function allTree(): LayoutNode {
  return JSON.parse(localStorage.getItem('tr-layout:all')!).tree as LayoutNode
}
async function openAll(): Promise<void> {
  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true })))
  await vi.waitFor(() => expect(app!.container.querySelector('[data-testid="command-palette"]')).not.toBeNull())
  const search = app!.container.querySelector<HTMLInputElement>('[data-testid="command-palette-search"]')!
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(search, 'All workspaces')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const all = [...app!.container.querySelectorAll('[data-testid="command-palette-row"]')].find((row) => row.textContent?.includes('All workspaces'))
  expect(all).toBeDefined()
  await act(async () => {
    all!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    await Promise.resolve()
    all!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await Promise.resolve()
  })
}
async function localHello(): Promise<void> {
  app = await renderReadyApp({ sessions: [localSession()], workspaces: [localWorkspace()] })
}

describe('renderer recovery with a partial environment roster', () => {
  it('keeps the remembered WSL selection until its workspace list arrives', async () => {
    pending([0])
    localStorage.setItem('tr-selected-workspace', WSL)
    await localHello()
    expect(localStorage.getItem('tr-selected-workspace')).toBe(WSL)
    expect(selectedName() ?? '').not.toContain('Local project')
    deliverControl({ type: 'workspace_list', workspaces: [localWorkspace(), wslWorkspace()] })
    pending([], false)
    expect(selectedName()).toContain('WSL project')
    expect(localStorage.getItem('tr-selected-workspace')).toBe(WSL)
  })

  it('does not open onboarding for an empty local hello while WSL discovery is pending', async () => {
    pending([], true, true)
    localStorage.setItem('tr-selected-workspace', WSL)
    app = await renderReadyApp({ sessions: [], workspaces: [] })
    expect(localStorage.getItem('tr-selected-workspace')).toBe(WSL)
    expect(app.container.querySelector('.grid-slot')?.getAttribute('aria-hidden')).not.toBe('true')
    deliverControl({ type: 'workspace_list', workspaces: [wslWorkspace()] })
    pending([], false)
    expect(selectedName()).toContain('WSL project')
  })

  it('keeps an explicit local switch made while the remembered WSL workspace is pending', async () => {
    pending([0])
    localStorage.setItem('tr-selected-workspace', WSL)
    await localHello()
    const row = [...app!.container.querySelectorAll('.witem[role="button"]')].find((item) => item.textContent?.includes('Local project'))!
    act(() => (row as HTMLElement).click())
    deliverControl({ type: 'workspace_list', workspaces: [localWorkspace(), wslWorkspace()] })
    pending([], false)
    expect(selectedName()).toContain('Local project')
    expect(localStorage.getItem('tr-selected-workspace')).toBe(LOCAL)
  })

  it('falls back after the configured environment is removed or its authoritative roster omits the saved workspace', async () => {
    pending([0])
    localStorage.setItem('tr-selected-workspace', WSL)
    await localHello()
    deliverControl({ type: 'workspace_list', workspaces: [localWorkspace()] })
    pending([], false)
    expect(selectedName()).toContain('Local project')
  })

  it('opening All before WSL hello keeps pane IDs, origins and split weights through two offline replacements', async () => {
    pending([0])
    localStorage.setItem('tr-layout:all', JSON.stringify({ tree: saved, cols: 2 }))
    await localHello()
    await openAll()
    expect(allTree()).toEqual(saved)

    deliverControl({ type: 'session_list', sessions: [localSession(), wslSession(firstReplacement)] })
    pending([], true)
    expect(allTree()).toEqual({ ...saved, children: [{ ...leaf(firstReplacement, 'saved-wsl-slot'), session_origin: origin }, leaf(1, 'saved-local-slot')] })

    pending([0])
    deliverControl({ type: 'session_list', sessions: [localSession()] })
    expect(allTree()).toMatchObject({ weights: [70, 30], children: [{ session: firstReplacement, id: 'saved-wsl-slot', session_origin: origin }, { session: 1 }] })
    deliverControl({ type: 'session_list', sessions: [localSession(), wslSession(secondReplacement)] })
    pending([], false)
    deliverControl({ type: 'workspace_list', workspaces: [localWorkspace(), wslWorkspace()] })
    expect(allTree()).toEqual({ ...saved, children: [{ ...leaf(secondReplacement, 'saved-wsl-slot'), session_origin: origin }, leaf(1, 'saved-local-slot')] })
  })

  it('an explicit close retires the pending slot while another WSL roster is still offline', async () => {
    pending([0, 1])
    localStorage.setItem('tr-layout:all', JSON.stringify({ tree: saved, cols: 2 }))
    await localHello()
    await openAll()
    deliverControl({ type: 'session_removed', session: origin })
    expect(allTree()).toEqual(leaf(1, 'saved-local-slot'))
  })

  it('an authoritative missing WSL session is pruned even when another environment stays offline', async () => {
    pending([0, 1])
    localStorage.setItem('tr-layout:all', JSON.stringify({ tree: saved, cols: 2 }))
    await localHello()
    await openAll()
    deliverControl({ type: 'session_list', sessions: [localSession()] })
    pending([1])
    expect(allTree()).toEqual(leaf(1, 'saved-local-slot'))
  })

  it('persists an explicit close in saved All even when All was never opened', async () => {
    pending([0])
    localStorage.setItem('tr-layout:all', JSON.stringify({ tree: saved, cols: 2 }))
    await localHello()
    deliverControl({ type: 'session_removed', session: origin })
    expect(allTree()).toEqual(leaf(1, 'saved-local-slot'))
    app!.unmount()
    app = undefined
    await localHello()
    await openAll()
    expect(allTree()).toEqual(leaf(1, 'saved-local-slot'))
  })
})
