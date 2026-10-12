import { agentAttentionFor } from '../useAgentAttention'
// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar, preloadRailOptionsMenu } from './Sidebar'
import { setSettingsNavForTests, isSettingsOpen } from '../settingsNav'
import { RAIL_VIEWS, setRailViewForTests } from '../railView'
import type { TagInfo } from '../houston/generated/TagInfo'
import type { SessionInfo, Workspace } from '../houston/client'

beforeAll(() => preloadRailOptionsMenu())

function ws(path: string, name = path): Workspace {
  return { path, name } as Workspace
}

function noop(): void {}

function taggedSession(id: number, path: string, tags: number[]): SessionInfo {
  return { id, project_dir: path, state: 'running', tags } as unknown as SessionInfo
}

const TAGS: TagInfo[] = [
  { id: 1, name: 'code review', color: '#a78bfa' },
  { id: 2, name: 'wait-human', color: '#f59e0b' }
]

function baseProps(
  overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}
): React.ComponentProps<typeof Sidebar> {
  return {
    workspaces: [ws('/a', 'alpha')],
    sessions: [taggedSession(11, '/a', [1, 2])],
    selected: '/a',
    selectedGridId: 'a1',
    tags: TAGS,
    gridsByWorkspace: {
      '/a': [
        { id: 'a1', name: 'alpha main', sessionIds: [11], tagIds: [1, 2], count: 1, state: 'working' }
      ]
    },
    customColors: {},
    colorIndexByPath: {},
    renaming: null,
    onSelect: noop,
    onAddWorkspace: noop,
    onRemoveWorkspace: noop,
    onRenameStart: noop,
    onRenameSubmit: noop,
    onRenameCancel: noop,
    onChangeColor: noop,
    onReorderWorkspace: noop,
    pinnedWorkspaces: new Set(),
    onTogglePinWorkspace: noop,
    onSshConnect: noop,
    chromeTheme: 'graphite',
    onToggleChromeTheme: noop,
    ...overrides
  } as React.ComponentProps<typeof Sidebar>
}

let container: HTMLElement
let root: Root

function render(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}): void {
  act(() => {
    root.render(<Sidebar {...baseProps(overrides)} />)
  })
}

const q = (sel: string): HTMLElement | null => container.querySelector(sel)
const rows = (): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[data-testid="rail-nav-row"]')
]

beforeEach(() => {
  setRailViewForTests({ view: null, hidden: [] })
  setSettingsNavForTests({ open: false, section: 'appearance' })
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('the rail nav block', () => {
  it('Search is a button onto the palette, not a second text field', () => {
    const onOpenPalette = vi.fn()
    render({ onOpenPalette, paletteChord: 'Ctrl+K' })
    const search = q('[data-testid="rail-search"]') as HTMLButtonElement
    expect(search).not.toBeNull()
    expect(search.tagName).toBe('BUTTON')
    expect(container.querySelector('[data-testid="rail-search"] input')).toBeNull()
    act(() => search.click())
    expect(onOpenPalette).toHaveBeenCalledTimes(1)
  })

  it('the chord rides inside the row, split into caps, and is simply absent when unknown', () => {
    render({ paletteChord: 'Ctrl+K' })
    expect(q('[data-testid="rail-search"]')?.textContent).toContain('Ctrl K')
    render({ paletteChord: null })
    expect(q('[data-testid="rail-search"]')?.textContent?.trim()).toBe('Search or run a command')
  })

  it('navigation rows label all four work views', () => {
    render()
    expect(rows().map((r) => r.getAttribute('data-view'))).toEqual(RAIL_VIEWS)
    expect(rows().map((r) => r.textContent)).toEqual(['Tasks', 'Pull requests', 'Routines', 'Usage'])
    expect(q('.railfoot button[aria-label="Usage"]')).toBeNull()
  })

  it('shows the task turn count in warning ink and omits zero', () => {
    render({ taskTurnCount: 2 })
    const count = rows().find((row) => row.getAttribute('data-view') === 'tasks')?.querySelector('.tabular-nums')
    expect(count?.textContent).toBe('2')
    expect(count?.className).toContain('text-[var(--warn)]')
    render({ taskTurnCount: 0 })
    expect(rows().find((row) => row.getAttribute('data-view') === 'tasks')?.textContent).toBe('Tasks')
  })

  it('puts setup attention on the Settings footer action as a neutral count rather than a retired Harness row', () => {
    render({ agentAttention: agentAttentionFor({ agentHooks: null, skills: null, reviews: [], checks: [['github', { state: 'failed', message: 'missing npx' }]] }) })
    expect(q('[data-testid="rail-settings"]')?.getAttribute('aria-label')).toBe('Settings, 1 agent setting needs you')
    const count = q('[data-testid="rail-settings-attention"]')
    expect(count?.textContent).toBe('+1')
    expect(count?.className).toContain('text-[var(--text-muted)]')
    expect(rows().some((row) => row.getAttribute('data-view') === 'harness')).toBe(false)
  })

  it('groups Settings with one highlight and Escape clears the filter before leaving', () => {
    setSettingsNavForTests({ open: true, section: 'agents-mcp' })
    render()
    expect(Array.from(container.querySelectorAll('[aria-label="Settings sections"] h3')).map((node) => node.textContent)).toEqual(['Agents', 'App', 'Work', 'Devices', 'System'])
    expect(q('[data-testid="rail-settings"]')?.getAttribute('aria-current')).toBeNull()
    expect(container.querySelectorAll('[data-testid="settings-section-row"][aria-current]')).toHaveLength(1)
    const input = container.querySelector<HTMLInputElement>('[aria-label="Search settings"]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => { setter.call(input, 'font'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(input.value).toBe('')
    expect(isSettingsOpen()).toBe(true)
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(isSettingsOpen()).toBe(false)
  })

  it('the open one is marked, and only it', () => {
    setRailViewForTests({ view: 'routines' })
    render()
    const marked = rows().filter((r) => r.getAttribute('aria-current') === 'page')
    expect(marked.map((r) => r.getAttribute('data-view'))).toEqual(['routines'])
  })

  it('right-click offers Hide from sidebar, and taking it removes the row', () => {
    render()
    const skills = rows().find((r) => r.getAttribute('data-view') === 'routines')!
    act(() => {
      skills.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 90 })
      )
    })
    const hide = document.querySelector('[data-testid="nav-hide-row"]') as HTMLButtonElement
    expect(hide).not.toBeNull()
    expect(hide.textContent).toContain('Hide from sidebar')

    act(() => hide.click())
    expect(rows().map((r) => r.getAttribute('data-view'))).toEqual(['tasks', 'prs', 'usage'])
    expect(localStorage.getItem('tr-rail-views-hidden')).toContain('routines')
  })

  it('Settings mode shows only its sections, and the rows come back when Settings closes', () => {
    render()
    const before = rows().length
    act(() => setSettingsNavForTests({ open: true }))
    expect(q('[aria-label="Settings sections"]')).not.toBeNull()
    expect(rows().length).toBe(0)
    act(() => setSettingsNavForTests({ open: false }))
    expect(rows().length).toBe(before)
  })
})

describe('sidebar options', () => {
  const toggle = (): HTMLButtonElement => q('[data-options-testid="rail-options-trigger"]') as HTMLButtonElement

  it('shows no active-filter badge by default', () => {
    render()
    expect(q('[data-options-testid="rail-options-trigger"] span')).toBeNull()
  })

  it('opens the options menu and counts active filters', () => {
    render()
    act(() => toggle().click())
    expect(document.querySelector('[aria-label="Sidebar options"]')).not.toBeNull()
    const hideIdle = Array.from(document.querySelectorAll<HTMLButtonElement>('[aria-label="Sidebar options"] button')).find((row) => row.textContent?.trim() === 'Idle grids')!
    act(() => { hideIdle.click() })
    expect(q('[data-options-testid="rail-options-trigger"] span')?.textContent).toBe('1')
  })

  it('shows the Filter by tag row on the options root', () => {
    render()
    act(() => toggle().click())
    expect(document.querySelector('[data-testid="rail-tags-filter"]')).not.toBeNull()
  })

  it('options, Add workspace and New grid controls are visible at rest', () => {
    render()
    for (const sel of ['[data-options-testid="rail-options-trigger"]', '[aria-label="Add workspace"]', '[aria-label="New grid"]']) {
      const el = q(sel)
      expect(el, `${sel} is missing`).not.toBeNull()
      expect(el?.closest('span')?.className ?? '').not.toContain('opacity-0')
    }
  })
})
