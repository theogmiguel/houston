// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from './Sidebar'
import type { SessionInfo, Workspace } from '../houston/client'

function ws(path: string, name = path): Workspace {
  return { path, name } as Workspace
}

function noop(): void {}

function sessionsIn(path: string, n: number, from = 1): SessionInfo[] {
  return Array.from({ length: n }, (_, i) => ({
    id: from + i,
    project_dir: path,
    state: 'running'
  })) as unknown as SessionInfo[]
}

function baseProps(
  overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}
): React.ComponentProps<typeof Sidebar> {
  return {
    workspaces: [],
    sessions: [] as SessionInfo[],
    selected: '',
    customColors: {},
    colorIndexByPath: {},
    unreadByWs: {},
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
  }
}

const TWO_WORKSPACES = {
  workspaces: [ws('/a', 'alpha'), ws('/b', 'bravo')],
  selected: '/a',
  selectedGridId: 'a1',
  gridsByWorkspace: {
    '/a': [
      { id: 'a1', name: 'alpha main' },
      { id: 'a2', name: 'alpha review' }
    ],
    '/b': [{ id: 'b1', name: 'bravo main' }]
  }
} satisfies Partial<React.ComponentProps<typeof Sidebar>>

describe('Sidebar workspace tree — every open workspace shows its tabs', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  function render(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}): void {
    act(() => {
      root.render(<Sidebar {...baseProps(overrides)} />)
    })
  }

  const rowNames = (): string[] =>
    [...container.querySelectorAll('[data-testid="grid-row"]')].map(
      (r) => r.querySelector('span:not([aria-hidden])')?.textContent ?? ''
    )

  const wsRow = (path: string): HTMLButtonElement =>
    [...container.querySelectorAll<HTMLButtonElement>('[data-testid="ws-disclosure"]')].find(
      (r) => r.getAttribute('aria-label') === path
    )!

  const wsChevron = (path: string): HTMLElement =>
    wsRow(path).querySelector<HTMLElement>('[data-testid="ws-chevron"]')!

  it('renders the tab rows of an UNSELECTED workspace, not just the selected one', () => {
    render(TWO_WORKSPACES)
    expect(rowNames()).toEqual(['alpha main', 'alpha review', 'bravo main'])
    expect(wsRow('/a').getAttribute('aria-expanded')).toBe('true')
    expect(wsRow('/b').getAttribute('aria-expanded')).toBe('true')
  })

  it('selecting another workspace collapses nothing — it only moves the filled tab row', () => {
    const onSelect = vi.fn()
    render({ ...TWO_WORKSPACES, onSelect })
    act(() => wsRow('/b').click())
    expect(onSelect).toHaveBeenCalledWith('/b')
    render({ ...TWO_WORKSPACES, selected: '/b', selectedGridId: 'b1', onSelect })
    expect(rowNames()).toEqual(['alpha main', 'alpha review', 'bravo main'])
    const filled = [...container.querySelectorAll('[data-testid="grid-row"]')].filter(
      (r) => r.getAttribute('aria-current') === 'true'
    )
    expect(filled).toHaveLength(1)
    expect(filled[0]?.textContent).toContain('bravo main')
  })

  it('a workspace with no tabs is a plain row — no chevron, no count chip', () => {
    render({
      workspaces: [ws('/a', 'alpha'), ws('/empty', 'empty')],
      selected: '/a',
      selectedGridId: 'a1',
      gridsByWorkspace: { '/a': [{ id: 'a1', name: 'alpha main' }] }
    })
    const plain = [...container.querySelectorAll<HTMLElement>('.witem[role="button"]')].find(
      (r) => r.getAttribute('aria-label') === '/empty'
    )!
    expect(plain.getAttribute('data-testid')).not.toBe('ws-disclosure')
    expect(plain.querySelector('[data-testid="nav-count"]')).toBeNull()
    expect(plain.querySelector('svg')).not.toBeNull()
  })

  it('the chevron collapse is explicit, persists per workspace path, and defaults to expanded', () => {
    render(TWO_WORKSPACES)
    act(() => wsRow('/a').click())
    expect(rowNames()).toEqual(['bravo main'])
    expect(wsRow('/a').getAttribute('aria-expanded')).toBe('false')
    expect(JSON.parse(localStorage.getItem('tr-ws-collapsed') ?? '[]')).toEqual(['/a'])

    act(() => root.unmount())
    root = createRoot(container)
    render(TWO_WORKSPACES)
    expect(rowNames()).toEqual(['bravo main'])
    expect(wsRow('/b').getAttribute('aria-expanded')).toBe('true')

    act(() => wsRow('/a').click())
    expect(rowNames()).toEqual(['alpha main', 'alpha review', 'bravo main'])
    expect(JSON.parse(localStorage.getItem('tr-ws-collapsed') ?? '[]')).toEqual([])
  })

  it('a collapsed workspace shows its PANE total, not its tab count, and a static chevron', () => {
    render({ ...TWO_WORKSPACES, sessions: sessionsIn('/a', 7) })
    act(() => wsRow('/a').click())
    const row = wsRow('/a')
    expect(row.querySelector('[data-testid="nav-count"]')?.textContent).toBe('7')
    expect(row.querySelector('span[aria-hidden]')?.className).not.toContain('opacity-0')
  })

  it('an expanded workspace shows the same pane total, capped at 99+ with the true count in its tooltip', () => {
    render({ ...TWO_WORKSPACES, sessions: sessionsIn('/a', 104) })
    const chip = wsRow('/a').querySelector('[data-testid="nav-count"]')
    expect(chip?.textContent).toBe('99+')
    expect(chip?.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe('104 panes')
  })

  it('no pane running dims the chip and says so, but the number stays the total', () => {
    const dead = sessionsIn('/a', 4).map((sess) => ({ ...sess, state: 'exited' })) as SessionInfo[]
    render({ ...TWO_WORKSPACES, sessions: dead })
    const chip = wsRow('/a').querySelector('[data-testid="nav-count"]')
    expect(chip?.textContent).toBe('4')
    expect(chip?.className).toContain('opacity-[0.55]')
    expect(chip?.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe(
      '4 panes, none running'
    )
  })

  it('a single pane gets no chip, on a workspace with tabs as on one without', () => {
    render({ ...TWO_WORKSPACES, sessions: sessionsIn('/a', 1) })
    expect(wsRow('/a').querySelector('[data-testid="nav-count"]')).toBeNull()
  })

  it('the chevron toggles a workspace open or closed WITHOUT selecting it', () => {
    const onSelect = vi.fn()
    render({ ...TWO_WORKSPACES, onSelect })
    act(() => wsChevron('/b').click())
    expect(onSelect).not.toHaveBeenCalled()
    expect(rowNames()).toEqual(['alpha main', 'alpha review'])
    expect(wsRow('/b').getAttribute('aria-expanded')).toBe('false')

    act(() => wsChevron('/b').click())
    expect(onSelect).not.toHaveBeenCalled()
    expect(rowNames()).toEqual(['alpha main', 'alpha review', 'bravo main'])
    expect(wsRow('/b').getAttribute('aria-expanded')).toBe('true')
  })

  it('a corrupt tr-ws-collapsed value falls back to everything expanded', () => {
    localStorage.setItem('tr-ws-collapsed', '{not json')
    render(TWO_WORKSPACES)
    expect(rowNames()).toEqual(['alpha main', 'alpha review', 'bravo main'])
  })

  it('the workspace row shows a pointer at rest and a grabbing hand while a drag is live', () => {
    const doc = document as Document & { elementFromPoint?: (x: number, y: number) => Element | null }
    const hadHitTest = typeof doc.elementFromPoint === 'function'
    if (!hadHitTest) doc.elementFromPoint = () => null
    render(TWO_WORKSPACES)
    const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-ws-idx]'))
    expect(rows).toHaveLength(2)
    for (const r of rows) {
      expect(r.className).toContain('cursor-pointer')
      expect(r.className).not.toContain('cursor-grabbing')
    }
    const list = container.querySelector<HTMLElement>('.wlist')!
    expect(list.className).not.toContain('cursor-grabbing')

    act(() => {
      rows[0].dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 })
      )
    })
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 10, clientY: 40 }))
    })
    for (const r of container.querySelectorAll<HTMLElement>('[data-ws-idx]')) {
      expect(r.className).toContain('cursor-grabbing')
    }
    expect(container.querySelector<HTMLElement>('.wlist')!.className).toContain('cursor-grabbing')

    act(() => {
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: 10, clientY: 40 }))
    })
    for (const r of container.querySelectorAll<HTMLElement>('[data-ws-idx]')) {
      expect(r.className).toContain('cursor-pointer')
    }
    if (!hadHitTest) Reflect.deleteProperty(doc, 'elementFromPoint')
  })

  describe('renaming a workspace with tabs', () => {
    const field = (): HTMLInputElement | null =>
      container.querySelector('[data-testid="ws-row-renaming"] input')

    it('shows the field on an EXPANDED workspace, and keeps its tabs underneath', () => {
      render({ ...TWO_WORKSPACES, renaming: '/a' })
      expect(field(), 'no rename field on a workspace that has tabs').not.toBeNull()
      expect(field()!.value).toBe('alpha')
      expect(rowNames()).toContain('alpha main')
      expect(rowNames()).toContain('alpha review')
    })

    it('shows the field on a COLLAPSED workspace too', () => {
      render(TWO_WORKSPACES)
      act(() => wsChevron('/a').click())
      render({ ...TWO_WORKSPACES, renaming: '/a' })
      expect(field()).not.toBeNull()
    })

    it('still shows it on a workspace with no tabs at all', () => {
      render({ workspaces: [ws('/c', 'charlie')], selected: '/c', renaming: '/c' })
      expect(field()).not.toBeNull()
      expect(field()!.value).toBe('charlie')
    })

    it('only the workspace being renamed swaps — its neighbour keeps its row', () => {
      render({ ...TWO_WORKSPACES, renaming: '/a' })
      expect(container.querySelectorAll('[data-testid="ws-row-renaming"]')).toHaveLength(1)
      expect(wsRow('/b')).not.toBeUndefined()
    })

    it('submitting hands the trimmed name up with its path', () => {
      const onRenameSubmit = vi.fn()
      render({ ...TWO_WORKSPACES, renaming: '/a', onRenameSubmit })
      const input = field()!
      const setValue = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )!.set!
      act(() => {
        setValue.call(input, 'Houston')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      act(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })
      expect(onRenameSubmit).toHaveBeenCalledWith('/a', 'Houston')
    })
  })
})
