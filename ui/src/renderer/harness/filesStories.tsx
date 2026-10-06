import { useEffect, useRef } from 'react'
import { FilesPane } from '../src/components/FilesPane'
import type { HoustonClient } from '../src/houston/client'

type Theme = 'graphite' | 'paper'
type Mode = 'narrow' | 'split' | 'pane'
type Open = 'none' | 'tree-menu' | 'tab-menu' | 'rename'
type State = 'tree' | 'empty' | 'root-error'

const root = '/repo'
const entry = (path: string, dir = false) => ({ name: path.split('/').at(-1) as string, path, dir, ignored: false })
const tree: Record<string, ReturnType<typeof entry>[]> = {
  [root]: [entry(`${root}/core`, true), entry(`${root}/broken`, true), entry(`${root}/README.md`), entry(`${root}/Cargo.toml`), entry(`${root}/package.json`)],
  [`${root}/core`]: [entry(`${root}/core/main.rs`), entry(`${root}/core/lib.rs`)]
}

const client = {
  subscribe(kind: string, handler: (message: never) => void) {
    if (kind === 'git_status') queueMicrotask(() => handler({
      dir: root, base: null,
      files: [
        { path: 'core/main.rs', status: 'modified', staged: false, added: 1, deleted: 0, is_sensitive: false },
        { path: 'README.md', status: 'added', staged: false, added: 1, deleted: 0, is_sensitive: false },
        { path: 'Cargo.toml', status: 'deleted', staged: false, added: 0, deleted: 1, is_sensitive: false }
      ]
    } as never))
    return () => {}
  },
  gitStatus() {}
} as unknown as HoustonClient

function stubBridge(state: State): void {
  const w = window as unknown as { houston?: Record<string, unknown> }
  w.houston = {
    ...(w.houston ?? {}),
    readDir: async (dir: string) => {
      if (dir === root && state === 'root-error') throw new Error('permission denied')
      if (dir === root && state === 'empty') return []
      if (dir === `${root}/broken`) throw new Error('permission denied')
      return tree[dir] ?? []
    },
    readFile: async () => { throw new Error('story has no file contents') },
    statFile: async () => null
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function Frame({ theme, mode, open, state = 'tree' }: { theme: Theme; mode: Mode; open: Open; state?: State }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
  useEffect(() => {
    stubBridge(state)
    if (state !== 'tree') return
    let live = true
    // The shot tool waits for the network to go idle; polling keeps it busy until the scripted interaction has finished.
    const keepBusy = setInterval(() => { void fetch('/harness/index.html', { cache: 'no-store' }) }, 100)
    void (async () => {
      const el = host.current
      if (!el) return
      const find = async (selector: string): Promise<HTMLElement | null> => {
        for (let i = 0; i < 60 && live; i++) {
          const found = el.querySelector<HTMLElement>(selector)
          if (found) return found
          await sleep(50)
        }
        return null
      }
      const fire = async (selector: string, type: 'click' | 'dblclick' | 'contextmenu'): Promise<void> => {
        const target = await find(selector)
        target?.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 80, clientY: 120 }))
        await sleep(120)
      }
      const row = (path: string): string => `[data-testid="files-tree-row"][data-path="${path}"]`
      await fire(row(`${root}/core`), 'click')
      await fire(row(`${root}/broken`), 'click')
      await fire(row(`${root}/core/main.rs`), 'dblclick')
      await fire(row(`${root}/core/lib.rs`), 'dblclick')
      await fire(row(`${root}/README.md`), 'click')
      await sleep(300)
      if (open === 'tree-menu') await fire(row(`${root}/core`), 'contextmenu')
      if (open === 'tab-menu') await fire('[data-testid="files-tab"]', 'contextmenu')
      if (open === 'rename') {
        await fire(row(`${root}/core/main.rs`), 'contextmenu')
        const item = [...el.ownerDocument.querySelectorAll<HTMLElement>('[data-testid="files-row-menu"] [role="menuitem"]')].find((node) => node.textContent?.startsWith('Rename'))
        item?.click()
        await sleep(200)
      }
      await sleep(200)
      clearInterval(keepBusy)
    })()
    return () => { live = false; clearInterval(keepBusy) }
  }, [open, state])
  const width = mode === 'split' ? 960 : mode === 'narrow' ? 384 : 560
  return <div ref={host} style={{ width, height: 700, display: 'flex', flexDirection: 'column', margin: 16, background: 'var(--content-bg)' }}>
    <FilesPane key={mode} panel={mode !== 'pane'} client={client} node={{ kind: 'files', id: 'files-story', root }} workspaceDir={root} active onClose={() => {}} onHeaderPointerDown={() => {}} onMoveToEditor={() => {}} onExpand={mode === 'pane' ? () => {} : undefined} />
  </div>
}

export const FilesNarrowGraphite = (): React.JSX.Element => <Frame theme="graphite" mode="narrow" open="none" />
export const FilesSplitGraphite = (): React.JSX.Element => <Frame theme="graphite" mode="split" open="none" />
export const FilesSplitPaper = (): React.JSX.Element => <Frame theme="paper" mode="split" open="none" />
export const FilesPaneGraphite = (): React.JSX.Element => <Frame theme="graphite" mode="pane" open="none" />
export const FilesTreeMenuGraphite = (): React.JSX.Element => <Frame theme="graphite" mode="split" open="tree-menu" />
export const FilesTabMenuGraphite = (): React.JSX.Element => <Frame theme="graphite" mode="split" open="tab-menu" />
export const FilesRenameGraphite = (): React.JSX.Element => <Frame theme="graphite" mode="split" open="rename" />
export const FilesEmptyGraphite = (): React.JSX.Element => <Frame theme="graphite" mode="split" open="none" state="empty" />
export const FilesRootErrorGraphite = (): React.JSX.Element => <Frame theme="graphite" mode="split" open="none" state="root-error" />
