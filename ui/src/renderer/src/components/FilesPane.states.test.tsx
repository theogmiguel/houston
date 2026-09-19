// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DirEntry } from '../env'
import type { FilesNode } from '../layout/tree'
import { HIT_TARGET_28 } from './hitTarget'

const invokeMock = vi.fn()

const { FilesPane } = await import('./FilesPane')
await import('./EditorSurface')

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NODE: FilesNode = { kind: 'files', id: 'f1', root: '/ws' }

function entry(name: string, dir = false, ignored = false, parent = '/ws'): DirEntry {
  return { name, path: `${parent}/${name}`, dir, ignored }
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

describe('Files pane — state matrix (§14)', () => {
  let container: HTMLDivElement
  let root: Root
  let readDir: ReturnType<typeof vi.fn<(dir: string) => Promise<DirEntry[]>>>
  let readFile: ReturnType<typeof vi.fn<(path: string) => Promise<string>>>
  let editors: { id: string; label: string }[]

  beforeEach(() => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke: invokeMock }
    localStorage.clear()
    readDir = vi.fn<(dir: string) => Promise<DirEntry[]>>().mockResolvedValue([])
    readFile = vi.fn<(path: string) => Promise<string>>().mockResolvedValue('line one\nline two\n')
    editors = []
    invokeMock.mockReset()
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      switch (cmd) {
        case 'fs_read_directory':
          return readDir(args.dirPath as string)
        case 'fs_read_file':
          return readFile(args.filePath as string)
        case 'fs_stat':
          return { mtimeMs: 1 }
        case 'fs_write_file':
          return undefined
        case 'shell_list_editors':
          return editors
        default:
          throw new Error(`unexpected invoke: ${cmd}`)
      }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const q = (sel: string): HTMLElement | null => container.querySelector(sel)
  const qa = (sel: string): HTMLElement[] => [...container.querySelectorAll<HTMLElement>(sel)]
  const rows = (): string[] =>
    qa('[data-testid="files-tree-row"]').map((r) => r.getAttribute('data-path') ?? '')

  async function mount(overrides: Partial<Parameters<typeof FilesPane>[0]> = {}): Promise<void> {
    await act(async () => {
      root.render(
        <FilesPane
          node={NODE}
          workspaceDir="/ws"
          onClose={() => {}}
          onHeaderPointerDown={() => {}}
          {...overrides}
        />
      )
    })
    await flush()
  }

  it('empty: a root with nothing visible in it says so, and draws no tree', async () => {
    await mount()
    for (let i = 0; i < 50 && !q('[data-testid="files-empty-tree"]'); i++) await flush()
    expect(q('[data-testid="files-empty-tree"]')).not.toBeNull()
    expect(q('[data-testid="files-tree"]')).toBeNull()
  })

  it('root failure: the read error is SHOWN, not swallowed, with a way to retry', async () => {
    readDir.mockRejectedValue(new Error('permission denied: /ws'))
    await mount()
    const notice = q('[data-testid="files-root-failure"]')
    expect(notice).not.toBeNull()
    expect(notice!.textContent).toContain('permission denied: /ws')
    expect(notice!.textContent).toContain('Try again')
  })

  it('filled: directories first, ignored entries hidden, each row a treeitem', async () => {
    readDir.mockResolvedValue([
      entry('main.rs'),
      entry('node_modules', true, true),
      entry('src', true)
    ])
    await mount()
    expect(rows()).toEqual(['/ws/src', '/ws/main.rs'])
    const row = qa('[data-testid="files-tree-row"]')[0]
    expect(row.getAttribute('role')).toBe('treeitem')
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(qa('[data-testid="files-tree-row"]')[1].hasAttribute('aria-expanded')).toBe(false)
  })

  it('expanding a directory reads it lazily, once, and nests its children', async () => {
    readDir.mockImplementation(async (dir: string) =>
      dir === '/ws'
        ? [entry('src', true)]
        : [entry('lib.rs', false, false, '/ws/src')]
    )
    await mount()
    await act(async () => {
      qa('[data-testid="files-tree-row"]')[0].click()
    })
    await flush()
    expect(rows()).toEqual(['/ws/src', '/ws/src/lib.rs'])
    expect(readDir.mock.calls.map((c) => c[0])).toEqual(['/ws', '/ws/src'])
    await act(async () => {
      qa('[data-testid="files-tree-row"]')[0].click()
    })
    await act(async () => {
      qa('[data-testid="files-tree-row"]')[0].click()
    })
    await flush()
    expect(readDir.mock.calls.map((c) => c[0])).toEqual(['/ws', '/ws/src'])
  })

  it('Refresh re-reads the root AND every expanded directory', async () => {
    readDir.mockImplementation(async (dir: string) =>
      dir === '/ws' ? [entry('src', true)] : [entry('lib.rs', false, false, '/ws/src')]
    )
    await mount()
    await act(async () => {
      qa('[data-testid="files-tree-row"]')[0].click()
    })
    await flush()
    readDir.mockClear()
    await act(async () => {
      q('button[aria-label="Refresh tree"]')!.click()
    })
    await flush()
    expect(readDir.mock.calls.map((c) => c[0]).sort()).toEqual(['/ws', '/ws/src'])
  })

  it('no file open: the editor column says so, and reads NOTHING', async () => {
    readDir.mockResolvedValue([entry('main.rs')])
    await mount()
    expect(q('[data-testid="files-no-file"]')).not.toBeNull()
    expect(q('[data-testid="files-tab-strip"]')).toBeNull()
    expect(q('[data-testid="files-status-strip"]')).toBeNull()
    expect(readFile).not.toHaveBeenCalled()
  })

  it('clicking a file opens a tab, mounts the shared editor surface, and fills the status strip', async () => {
    readDir.mockResolvedValue([entry('main.rs')])
    await mount()
    await act(async () => {
      qa('[data-testid="files-tree-row"]')[0].click()
    })
    await flush()
    expect(readFile).toHaveBeenCalledWith('/ws/main.rs')
    expect(qa('[data-testid="files-tab"]').map((t) => t.getAttribute('data-path'))).toEqual([
      '/ws/main.rs'
    ])
    expect(q('[data-testid="cm-host"]')).not.toBeNull()
    const strip = q('[data-testid="files-status-strip"]')!
    expect(strip.textContent).toContain('Rust')
    expect(strip.textContent).toContain('LF')
    expect(strip.textContent).toContain('UTF-8')
  })

  it('the editor column carries the gutter CSS hook, so line numbers sit on the code surface', async () => {
    readDir.mockResolvedValue([entry('main.rs')])
    await mount()
    await act(async () => {
      qa('[data-testid="files-tree-row"]')[0].click()
    })
    await flush()
    expect(q('[data-testid="cm-host"]')!.closest('.editor-leaf')).not.toBeNull()
  })

  it('a long file name truncates inside its chip instead of wrapping below it', async () => {
    readDir.mockResolvedValue([entry('IMPLEMENTATION-NOTES-step14.md')])
    await mount()
    await act(async () => {
      qa('[data-testid="files-tree-row"]')[0].click()
    })
    await flush()
    const tab = q('[data-testid="files-tab"]')!
    const label = tab.querySelector('span.truncate')
    expect(label, 'the tab label span must carry `truncate`').not.toBeNull()
    expect(label!.textContent).toBe('IMPLEMENTATION-NOTES-step14.md')
  })

  it('a markdown file previews first and the header offers the way back to the source', async () => {
    readDir.mockResolvedValue([entry('NOTES.md')])
    readFile.mockResolvedValue('# Heading\n\nbody\n')
    await mount()
    await act(async () => {
      qa('[data-testid="files-tree-row"]')[0].click()
    })
    for (let i = 0; i < 50 && !q('[data-testid="editor-markdown-toggle"]'); i++) await flush()
    const toggle = q('[data-testid="editor-markdown-toggle"]') as HTMLButtonElement | null
    expect(toggle, 'the Preview/Edit toggle must be in the Files header').not.toBeNull()
    expect(toggle!.getAttribute('aria-label')).toBe('Edit source')
    expect((q('[data-testid="cm-host"]') as HTMLElement).style.display).toBe('none')
    await act(async () => {
      toggle!.click()
    })
    await flush()
    expect((q('[data-testid="cm-host"]') as HTMLElement).style.display).not.toBe('none')
    expect(q('[data-testid="editor-markdown-toggle"]')!.getAttribute('aria-label')).toBe('Preview')
  })

  it('opening the same file twice focuses its tab instead of adding a second', async () => {
    readDir.mockResolvedValue([entry('main.rs')])
    await mount()
    for (let i = 0; i < 2; i++) {
      await act(async () => {
        qa('[data-testid="files-tree-row"]')[0].click()
      })
      await flush()
    }
    expect(qa('[data-testid="files-tab"]')).toHaveLength(1)
  })

  it('a clean tab closes straight away — no prompt for changes that do not exist', async () => {
    readDir.mockResolvedValue([entry('main.rs')])
    await mount()
    await act(async () => {
      qa('[data-testid="files-tree-row"]')[0].click()
    })
    await flush()
    await act(async () => {
      q('button[aria-label="Close main.rs"]')!.click()
    })
    await flush()
    expect(qa('[data-testid="files-tab"]')).toHaveLength(0)
    expect(q('[data-testid="files-no-file"]')).not.toBeNull()
  })

  it('a tab close button keeps its 16px box and hit-tests to the 28px floor', async () => {
    readDir.mockResolvedValue([entry('main.rs')])
    await mount()
    await act(async () => {
      qa('[data-testid="files-tree-row"]')[0].click()
    })
    await flush()
    const close = q('button[aria-label="Close main.rs"]')!
    for (const token of HIT_TARGET_28.split(/\s+/)) {
      expect(close.className, `missing "${token}" — hit area is not expanded`).toContain(token)
    }
    expect(close.className).toContain('h-[16px]')
  })

  it('Save is present but disabled while nothing is dirty — the door is visible either way', async () => {
    readDir.mockResolvedValue([entry('main.rs')])
    await mount()
    const save = q('button[aria-label="Save"]') as HTMLButtonElement
    expect(save).not.toBeNull()
    expect(save.disabled).toBe(true)
  })

  it('a single click previews (italic); a double click pins it (upright)', async () => {
    readDir.mockResolvedValue([entry('main.rs')])
    await mount()
    await act(async () => {
      qa('[data-testid="files-tree-row"]')[0].click()
    })
    await flush()
    expect(q('[data-testid="files-tab"]')!.className).toContain('italic')

    await act(async () => {
      qa('[data-testid="files-tree-row"]')[0].dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, cancelable: true })
      )
    })
    await flush()
    expect(q('[data-testid="files-tab"]')!.className).not.toContain('italic')
  })

  it('two open tabs that share a basename render disambiguated by parent; a lone one stays bare', async () => {
    readDir.mockResolvedValue([
      entry('Cargo.toml', false, false, '/ws/houston-core'),
      entry('Cargo.toml', false, false, '/ws/houston-protocol'),
      entry('README.md')
    ])
    await mount()
    const rows = qa('[data-testid="files-tree-row"]')
    for (const row of rows) {
      await act(async () => {
        row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
      })
      await flush()
    }
    const labels = qa('[data-testid="files-tab"]').map(
      (t) => t.querySelector('span.truncate')!.textContent
    )
    expect(labels).toEqual([
      'Cargo.toml · houston-core',
      'Cargo.toml · houston-protocol',
      'README.md'
    ])
  })

  it('the overflow chevron is absent when every tab fits the strip', async () => {
    readDir.mockResolvedValue([entry('main.rs')])
    await mount()
    await act(async () => {
      qa('[data-testid="files-tree-row"]')[0].click()
    })
    await flush()
    expect(q('[data-testid="files-tab-overflow"]')).toBeNull()
  })

  it('the overflow chevron opens a menu naming every tab scrolled out of view', async () => {
    readDir.mockResolvedValue([entry('a.ts'), entry('b.ts'), entry('c.ts')])
    await mount()
    for (let i = 0; i < 2; i++) {
      await act(async () => {
        qa('[data-testid="files-tree-row"]')[i].dispatchEvent(
          new MouseEvent('dblclick', { bubbles: true, cancelable: true })
        )
      })
      await flush()
    }
    const scroll = q('[data-testid="files-tab-scroll"]') as HTMLElement
    Object.defineProperty(scroll, 'scrollWidth', { value: 300, configurable: true })
    Object.defineProperty(scroll, 'clientWidth', { value: 200, configurable: true })
    Object.defineProperty(scroll, 'scrollLeft', { value: 0, configurable: true })
    await act(async () => {
      qa('[data-testid="files-tree-row"]')[2].dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, cancelable: true })
      )
    })
    await flush()

    const chevron = q('[data-testid="files-tab-overflow"]') as HTMLButtonElement
    expect(chevron, 'the chevron must appear once the strip actually overflows').not.toBeNull()

    const tabs = qa('[data-testid="files-tab"]')
    const widths = [100, 100, 100]
    let left = 0
    for (const [i, tab] of tabs.entries()) {
      Object.defineProperty(tab, 'offsetLeft', { value: left, configurable: true })
      Object.defineProperty(tab, 'offsetWidth', { value: widths[i], configurable: true })
      left += widths[i]
    }
    await act(async () => {
      chevron.click()
    })
    const menu = q('[data-testid="files-tab-overflow-menu"]')!
    expect(menu.textContent).toContain('1 more open')
    expect(menu.textContent).toContain('c.ts')
    expect(menu.textContent).not.toContain('a.ts')
  })

  it('the pane header carries every way out: refresh, save, expand, close', async () => {
    const onClose = vi.fn()
    await mount({ onClose, onExpand: () => {} })
    for (const label of ['Refresh tree', 'Save', 'Expand', 'Close']) {
      expect(q(`button[aria-label="${label}"]`), label).not.toBeNull()
    }
    await act(async () => {
      q('button[aria-label="Close"]')!.click()
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('reflows by the PANE’s own width: the tree column is a container-query override', async () => {
    await mount()
    const col = q('[data-testid="files-tree-column"]')!
    expect(col.className).toContain('hidden')
    expect(col.className).toContain('@container_(min-width:420px)')
  })

  it('the tree toggle exists so the folded layout never loses the tree', async () => {
    await mount()
    const toggle = q('button[aria-label="Show tree"]')
    expect(toggle).not.toBeNull()
    await act(async () => {
      toggle!.click()
    })
    expect(q('button[aria-label="Hide tree"]')).not.toBeNull()
    expect(q('[data-testid="files-tree-column"]')!.className).not.toContain('hidden')
  })

  it('a tree row’s context menu offers Open in ▸, Reveal and Copy path', async () => {
    readDir.mockResolvedValue([entry('main.rs')])
    await mount()
    await act(async () => {
      qa('[data-testid="files-tree-row"]')[0].dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })
      )
    })
    await flush()
    const menu = q('[data-testid="files-row-menu"]')!
    expect(menu.textContent).toContain('Open in')
    expect(menu.textContent).toContain('Reveal in file manager')
    expect(menu.textContent).toContain('Copy path')
  })

  it('with no editor on PATH, Open in ▸ says which binaries it looked for', async () => {
    readDir.mockResolvedValue([entry('main.rs')])
    await mount()
    await act(async () => {
      qa('[data-testid="files-tree-row"]')[0].dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })
      )
    })
    await flush()
    await act(async () => {
      q('[data-testid="open-in-menu"] button')!.click()
    })
    const sub = q('[data-testid="open-in-submenu"]')!
    expect(sub.textContent).toContain('No editor found on PATH')
    expect(sub.textContent).toContain('cursor')
    expect(sub.querySelector('button')).toHaveProperty('disabled', true)
  })
})

describe('Files pane — tab strip scrollbar (dead band regression)', () => {
  it('global.css hides the WebKit scrollbar pseudo-element on the scrolling element itself', () => {
    const css = readFileSync(join(__dirname, '../global.css'), 'utf8')
    const stripHidesWebkitScrollbar = /\.files-tab-scroll::-webkit-scrollbar\s*\{[^}]*display:\s*none/.test(
      css
    )
    expect(
      stripHidesWebkitScrollbar,
      'global.css must carry a `.files-tab-scroll::-webkit-scrollbar { display: none }` rule ' +
        '(the class the SCROLLING element inside the strip carries, per `FilesPane.tsx`) — ' +
        'without it, `scrollbar-width: none` does nothing on WebKit, which ignores that ' +
        'property, and the global `::-webkit-scrollbar { width: 6px }` rule still paints a 6px ' +
        'dead band across every tab chip'
    ).toBe(true)
  })
})
