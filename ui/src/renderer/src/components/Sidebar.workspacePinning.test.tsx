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

function rightClick(el: Element): void {
  act(() => {
    el.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 90 })
    )
  })
}

describe('Sidebar — workspace pinning', () => {
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

  const wsRow = (path: string): HTMLElement =>
    [...container.querySelectorAll<HTMLElement>('.witem[aria-label], [data-testid="ws-disclosure"]')].find(
      (r) => r.getAttribute('aria-label') === path
    )!

  const groupLabels = (): string[] =>
    [...container.querySelectorAll('.wlist > *')]
      .filter((el) => el.textContent === 'Pinned' || el.textContent === 'Folders')
      .map((el) => el.textContent!)

  const dividers = (): Element[] => [
    ...container.querySelectorAll('[data-testid="ws-pinned-divider"]')
  ]

  describe('context menu', () => {
    it('offers "Pin Workspace" for an unpinned workspace', () => {
      render({ workspaces: [ws('/a', 'alpha')], selected: '/a' })
      rightClick(wsRow('/a'))
      const item = document.querySelector('[data-testid="ws-toggle-pin"]')!
      expect(item.textContent).toContain('Pin Workspace')
    })

    it('offers "Unpin Workspace" for an already-pinned workspace', () => {
      render({ workspaces: [ws('/a', 'alpha')], selected: '/a', pinnedWorkspaces: new Set(['/a']) })
      rightClick(wsRow('/a'))
      const item = document.querySelector('[data-testid="ws-toggle-pin"]')!
      expect(item.textContent).toContain('Unpin Workspace')
    })

    it('clicking the item calls onTogglePinWorkspace with the workspace path, for a plain row', () => {
      const onTogglePinWorkspace = vi.fn()
      render({ workspaces: [ws('/a', 'alpha')], selected: '/a', onTogglePinWorkspace })
      rightClick(wsRow('/a'))
      act(() => {
        ;(document.querySelector('[data-testid="ws-toggle-pin"]') as HTMLElement).click()
      })
      expect(onTogglePinWorkspace).toHaveBeenCalledWith('/a')
      expect(document.querySelector('.ctxmenu')).toBeNull()
    })

    it('also works from a workspace row that has nested grids', () => {
      const onTogglePinWorkspace = vi.fn()
      render({
        workspaces: [ws('/a', 'alpha')],
        selected: '/a',
        selectedGridId: 'a1',
        gridsByWorkspace: { '/a': [{ id: 'a1', name: 'alpha main' }] },
        onTogglePinWorkspace
      })
      rightClick(wsRow('/a'))
      act(() => {
        ;(document.querySelector('[data-testid="ws-toggle-pin"]') as HTMLElement).click()
      })
      expect(onTogglePinWorkspace).toHaveBeenCalledWith('/a')
    })
  })

  describe('pin indicator', () => {
    it('renders an accessible "Pinned" indicator only on a pinned row', () => {
      render({
        workspaces: [ws('/a', 'alpha'), ws('/b', 'bravo')],
        selected: '/a',
        pinnedWorkspaces: new Set(['/a'])
      })
      expect(wsRow('/a').querySelector('[aria-label="Pinned"]')).not.toBeNull()
      expect(wsRow('/b').querySelector('[aria-label="Pinned"]')).toBeNull()
    })

    it('renders on a collapsed-grids row and an expanded-grids row alike', () => {
      render({
        workspaces: [ws('/a', 'alpha'), ws('/b', 'bravo')],
        selected: '/a',
        selectedGridId: 'a1',
        pinnedWorkspaces: new Set(['/a', '/b']),
        gridsByWorkspace: {
          '/a': [{ id: 'a1', name: 'alpha main' }],
          '/b': [{ id: 'b1', name: 'bravo main' }]
        }
      })
      expect(wsRow('/a').querySelector('[aria-label="Pinned"]')).not.toBeNull()
      act(() => {
        wsRow('/b').querySelector<HTMLElement>('[data-testid="ws-chevron"]')!.click()
      })
      expect(wsRow('/b').querySelector('[aria-label="Pinned"]')).not.toBeNull()
    })
  })

  describe('group headers', () => {
    const FOUR = [ws('/p1', 'p1'), ws('/p2', 'p2'), ws('/u1', 'u1'), ws('/u2', 'u2')]

    it('shows neither a label nor a rule when nothing is pinned', () => {
      render({ workspaces: FOUR, selected: '/p1' })
      expect(groupLabels()).toEqual([])
      expect(dividers()).toHaveLength(0)
    })

    it('names both runs and rules the boundary between them', () => {
      render({ workspaces: FOUR, selected: '/p1', pinnedWorkspaces: new Set(['/p1', '/p2']) })
      expect(groupLabels()).toEqual(['Pinned', 'Folders'])
      expect(dividers()).toHaveLength(1)
    })

    it('shows only "Pinned" — no empty "Folders" run, and no rule with nothing past it', () => {
      render({
        workspaces: FOUR,
        selected: '/p1',
        pinnedWorkspaces: new Set(FOUR.map((w) => w.path))
      })
      expect(groupLabels()).toEqual(['Pinned'])
      expect(dividers()).toHaveLength(0)
    })
  })

  describe('no duplicates', () => {
    it('every workspace still appears exactly once, split across pinned/unpinned', () => {
      const FOUR = [ws('/p1', 'p1'), ws('/p2', 'p2'), ws('/u1', 'u1'), ws('/u2', 'u2')]
      render({ workspaces: FOUR, selected: '/p1', pinnedWorkspaces: new Set(['/p2']) })
      const labels = [...container.querySelectorAll('.witem')].map((r) => r.getAttribute('aria-label'))
      expect(labels.sort()).toEqual(['/p1', '/p2', '/u1', '/u2'])
    })
  })

  describe('drag boundary', () => {
    let stubbedHitTest: ((x: number, y: number) => Element | null) | null = null

    beforeEach(() => {
      const doc = document as Document & {
        elementFromPoint?: (x: number, y: number) => Element | null
      }
      stubbedHitTest = doc.elementFromPoint ?? null
      doc.elementFromPoint = (x, y) => stubbedHitTest?.(x, y) ?? null
    })

    const FOUR = [ws('/p1', 'p1'), ws('/p2', 'p2'), ws('/u1', 'u1'), ws('/u2', 'u2')]
    const PINNED = new Set(['/p1', '/p2'])

    function dragTo(fromPath: string, overPath: string): void {
      const from = [...container.querySelectorAll<HTMLElement>('[data-ws-idx]')].find(
        (r) => r.getAttribute('aria-label') === fromPath
      )!
      const over = [...container.querySelectorAll<HTMLElement>('[data-ws-idx]')].find(
        (r) => r.getAttribute('aria-label') === overPath
      )!
      vi.spyOn(document, 'elementFromPoint').mockReturnValue(over)
      act(() => {
        from.dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 })
        )
      })
      act(() => {
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: 10, clientY: 40 }))
      })
      act(() => {
        window.dispatchEvent(new PointerEvent('pointerup', { clientX: 10, clientY: 40 }))
      })
    }

    it('a pinned drag past the last unpinned row clamps at the end of the pinned group', () => {
      const onReorderWorkspace = vi.fn()
      render({ workspaces: FOUR, selected: '/p1', pinnedWorkspaces: PINNED, onReorderWorkspace })
      dragTo('/p1', '/u2')
      expect(onReorderWorkspace).toHaveBeenCalledWith('/p1', 2)
    })

    it('an unpinned drag past the first pinned row clamps at the start of the unpinned group', () => {
      const onReorderWorkspace = vi.fn()
      render({ workspaces: FOUR, selected: '/p1', pinnedWorkspaces: PINNED, onReorderWorkspace })
      dragTo('/u1', '/p1')
      expect(onReorderWorkspace).toHaveBeenCalledWith('/u1', 2)
    })

    it('a drag within its own group is unaffected by the clamp', () => {
      const onReorderWorkspace = vi.fn()
      render({ workspaces: FOUR, selected: '/p1', pinnedWorkspaces: PINNED, onReorderWorkspace })
      dragTo('/p1', '/p2')
      expect(onReorderWorkspace).toHaveBeenCalledWith('/p1', 2)
    })

    describe('with an active tag filter', () => {
      const TAG = { id: 1, name: 'code review', color: '#a78bfa' }

      function activateTagFilter(): void {
        act(() => {
          ;(container.querySelector('[data-testid="tree-filter-toggle"]') as HTMLElement).click()
        })
        const option = document.querySelector<HTMLElement>('[data-testid="tag-filter-option"]')!
        act(() => option.click())
      }

      const tagged = (id: number, path: string, tags: number[]): SessionInfo =>
        ({ id, project_dir: path, state: 'running', tags }) as unknown as SessionInfo

      it('shows only the workspaces that carry the tag, and a drag among them still lands at its full-list index', () => {
        const onReorderWorkspace = vi.fn()
        render({
          workspaces: FOUR,
          selected: '/p1',
          pinnedWorkspaces: PINNED,
          tags: [TAG],
          sessions: [tagged(1, '/p1', [1]), tagged(2, '/u1', []), tagged(3, '/u2', [1])],
          onReorderWorkspace
        })
        activateTagFilter()
        expect(
          [...container.querySelectorAll<HTMLElement>('[data-ws-idx]')].map((r) =>
            r.getAttribute('aria-label')
          )
        ).toEqual(['/p1', '/u2'])
        // /u2 is second of two unpinned in the FULL list, so index 3 — not the 1
        // its position in the filtered list would suggest.
        dragTo('/u2', '/p1')
        expect(onReorderWorkspace).toHaveBeenCalledWith('/u2', 3)
      })
    })
  })
})
