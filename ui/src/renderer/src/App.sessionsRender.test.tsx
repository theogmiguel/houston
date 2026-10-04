// @vitest-environment jsdom
import type { ServerMsg } from './houston/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { deliverControl, makeSession, makeWorkspace, renderReadyApp, resetHarness, type AppHarness } from './test/appTestHarness'

const sessionRenders = vi.hoisted(() => ({ a: 0 }))
const counts = vi.hoisted(() => ({ App: 0, Sidebar: 0, LayoutView: 0, unrelatedSessionPane: 0, SidebarRowB: 0 }))
vi.mock('./usePreferences', async (original) => {
  const actual = await original<typeof import('./usePreferences')>()
  return { ...actual, usePreferences: () => { counts.App++; return actual.usePreferences() } }
})
vi.mock('./components/Sidebar', async (original) => {
  const actual = await original<typeof import('./components/Sidebar')>()
  return { ...actual, Sidebar: (props: Parameters<typeof actual.Sidebar>[0]) => { counts.Sidebar++; return <actual.Sidebar {...props} /> } }
})
vi.mock('./components/LayoutView', async (original) => {
  const actual = await original<typeof import('./components/LayoutView')>()
  const { memo } = await import('react')
  return { ...actual, LayoutView: memo((props: Parameters<typeof actual.LayoutView>[0]) => { counts.LayoutView++; return <actual.LayoutView {...props} /> }) }
})
vi.mock('./sessionsStore', async (original) => {
  const actual = await original<typeof import('./sessionsStore')>()
  return { ...actual,
    useSession: (...args: Parameters<typeof actual.useSession>) => {
      if (args[0] === 1) sessionRenders.a++
      if (args[0] === 2) counts.unrelatedSessionPane++
      return actual.useSession(...args)
    },
    useWorkspaceWaiting: (...args: Parameters<typeof actual.useWorkspaceWaiting>) => {
      if (args[0] === '/tmp/other') counts.SidebarRowB++
      return actual.useWorkspaceWaiting(...args)
    },
  }
})
let app: AppHarness | undefined
beforeEach(() => {
  resetHarness()
  localStorage.clear()
  for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] = 0
})
afterEach(() => { app?.unmount(); app = undefined })
async function waitForGridRail(): Promise<void> {
  await vi.waitFor(() => {
    const rows = [...app!.container.querySelectorAll('[data-testid="grid-row"]')]
    expect(rows.some((row) => row.getAttribute('aria-label')?.includes(', '))).toBe(true)
  })
}
it('isolates a status event from App and unrelated pane containers', async () => {
  app = await renderReadyApp({ sessions: [makeSession({ id: 1, status: 'working' }), makeSession({ id: 2, project_dir: '/tmp/other', cwd: '/tmp/other', status: 'working' })], workspaces: [makeWorkspace(), makeWorkspace({ path: '/tmp/other', name: 'other' })] })
  await waitForGridRail()
  expect(counts.unrelatedSessionPane).toBeGreaterThan(0)
  expect(counts.SidebarRowB).toBe(0)
  for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] = 0
  deliverControl({ type: 'agent_status', session: 1, status: 'idle' })
  expect(app.container.querySelector('[data-panekey="1"] .agent-dot')?.className).toContain('text-muted')
  expect(counts).toEqual({ App: 0, Sidebar: 0, LayoutView: 0, unrelatedSessionPane: 0, SidebarRowB: 0 })
})

it('skips duplicate status updates and isolates roster fields while preserving structural updates', async () => {
  app = await renderReadyApp({ sessions: [makeSession({ id: 1, status: 'working' }), makeSession({ id: 2, project_dir: '/tmp/other', cwd: '/tmp/other', status: 'working' })], workspaces: [makeWorkspace(), makeWorkspace({ path: '/tmp/other', name: 'other' })] })
  await waitForGridRail()
  for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] = 0
  sessionRenders.a = 0
  deliverControl({ type: 'agent_status', session: 1, status: 'working' })
  expect(sessionRenders.a).toBe(0)
  const patches: ServerMsg[] = [
    { type: 'live_children_changed', session: 1, live_children: 1, children_waiting: 1 },
    { type: 'compactions_changed', session: 1, compactions: 2 },
    { type: 'session_context', session: 1, context: { used_tokens: 10, window_tokens: 100, used_percent: 10, state: 'idle', source: 'derived', as_of_ms: 1000 } },
  ]
  for (const patch of patches) deliverControl(patch)
  expect(sessionRenders.a).toBeGreaterThan(0)
  expect(counts).toEqual({ App: 0, Sidebar: 0, LayoutView: 0, unrelatedSessionPane: 0, SidebarRowB: 0 })
  expect(app.container.querySelector('[data-panekey="1"] .agent-dot')?.className).toContain('--warn')
  expect(app.container.querySelector('[aria-label="Children need input"]')).toBeNull()
  deliverControl({ type: 'session_renamed', session: 1, title: 'Renamed' })
  expect(counts.App).toBeGreaterThan(0)
  expect(app.container.querySelector('[data-panekey="1"]')?.textContent).toContain('Renamed')
})
