// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionInfo } from '../houston/client'

vi.mock('../pane/TerminalPane', () => ({ TerminalPane: () => null }))
vi.mock('../houston/bridge', () => ({
  listShells: async () => [],
  pathKind: async () => 'none',
  pickDirectory: async () => null,
  showItemInFolder: async () => {}
}))

import { rememberRailGitFacts } from './git/railGitCache'
import { BranchChip } from './SessionPane'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const primary = { root: '/home/dev/app', kind: 'primary', branch: 'main', head: null } as const
const worktree = (slug: string) => ({ root: `/home/dev/app/.houston/worktrees/${slug}`, kind: { worktree: { slug } }, branch: `houston/${slug}`, head: null }) as never
const child = (id: number, codename: string, slug: string): SessionInfo => ({
  id, codename, agent: 'claude', state: 'running', title: `task-${id}`, cwd: `/home/dev/app/.houston/worktrees/${slug}/src`,
  project_dir: '/home/dev/app', checkout: worktree(slug), delegation: { role: slug }
}) as unknown as SessionInfo

let container: HTMLDivElement
let root: Root
const focused: number[] = []

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  focused.length = 0
  rememberRailGitFacts(new Map([
    ['/home/dev/app', { added: 900, deleted: 90, ahead: 9, behind: 0, changedFiles: 4 }],
    ['/home/dev/app/.houston/worktrees/alpha', { added: 12, deleted: 3, ahead: 2, behind: 0, changedFiles: 2 }]
  ]))
  root = createRoot(container)
  act(() => root.render(
    <BranchChip checkout={primary} worktreeChildren={[child(2, 'Rey', 'alpha'), child(3, 'Cruz', 'beta')]} onFocusChild={(id) => focused.push(id)} />
  ))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  rememberRailGitFacts(new Map())
})

const countButton = (): HTMLButtonElement => container.querySelector('button[aria-label="2 child worktrees"]')!
const open = (): void => { act(() => countButton().click()) }
const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-worktree-row]')]

it("lists each child's own branch and diff, never the parent's", () => {
  open()
  const [rey, cruz] = rows()
  expect(rey.textContent).toContain('houston/alpha')
  expect(rey.textContent).toContain('↑2')
  expect(rey.textContent).toContain('+12')
  expect(rey.textContent).toContain('−3')
  expect(rey.textContent).not.toContain('900')
  expect(rey.textContent).not.toContain('main')
  expect(cruz.textContent).toContain('houston/beta')
})

it('shows only the branch when the cache has no entry, and hides zero stats', () => {
  rememberRailGitFacts(new Map([['/home/dev/app/.houston/worktrees/alpha', { added: 0, deleted: 0, ahead: 0, behind: 0, changedFiles: 0 }]]))
  open()
  const [rey, cruz] = rows()
  expect(rey.textContent).toBe('Reyalphahouston/alpha')
  expect(cruz.textContent).toBe('Cruzbetahouston/beta')
})

it('names this pane checkout and its root in the header', () => {
  open()
  const panel = document.querySelector('[role="dialog"]')!
  expect(panel.textContent).toContain('Primary checkout · ~/app')
  expect(panel.textContent).toContain('Child worktrees · 2')
})

it('focuses the child pane when its row is clicked and closes the popover', () => {
  open()
  act(() => rows()[1].click())
  expect(focused).toEqual([3])
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('moves between rows with the arrow keys', () => {
  open()
  expect(document.activeElement).toBe(rows()[0])
  act(() => { rows()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
  expect(document.activeElement).toBe(rows()[1])
})

it('returns focus to the count button on Escape', () => {
  open()
  act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(document.activeElement).toBe(countButton())
})
