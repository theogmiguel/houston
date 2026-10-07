import { useEffect, useState } from 'react'
import { FilesSurface } from '../src/components/files/FilesSurface'
import { getBuffer, noteUpdate } from '../src/editor/bufferStore'
import type { HoustonClient } from '../src/houston/client'

const root = '/repo/Houston'
const openPath = `${root}/ui/src/renderer/src/App.tsx`
const source = [
  "import { useState } from 'react'",
  "import { SidePanelIntegration } from './components/SidePanel'",
  "import { useExitAnimation } from './components/ui/AnimOut'",
  '',
  'export function App(): React.JSX.Element {',
  '  const [scmOpen, setScmOpen] = useState<boolean>(() => loadScmOpen())',
  '  const { mounted: sidePanelPresent, finishExit } = useExitAnimation(scmOpen, 240)',
  '  const scmWidth = useScmWidth()',
  '',
  '  // The grid takes the panel width once per transition, never per frame.',
  '  return (',
  '    <GridRegion withSide={sidePanelPresent}>',
  '      <SessionGrid sessions={sessions} />',
  '      <SidePanelIntegration',
  '        open={scmOpen}',
  '        width={scmWidth}',
  '        onExitAnimationEnd={finishExit}',
  '      />',
  '    </GridRegion>',
  '  )',
  '}',
].join('\n')

const paths = [
  '.github/workflows/ci.yml',
  'assets/logo.png',
  'assets/usage.csv',
  'core/houston-core/src/daemon.rs',
  'core/houston-core/src/files.rs',
  'core/houston-core/src/lib.rs',
  'core/houston-core/Cargo.toml',
  'core/houston-protocol/src/lib.rs',
  'docs/internals/glossary.md',
  'docs/internals/perf-trace.json',
  'docs/user/files.md',
  'ui/src/renderer/src/components/ChildContextMenu.tsx',
  'ui/src/renderer/src/components/FilesPane.tsx',
  'ui/src/renderer/src/components/SidePanel.tsx',
  'ui/src/renderer/src/ghostty/surface.ts',
  'ui/src/renderer/src/App.tsx',
  'ui/src/renderer/src/components/ui/AnimOut.tsx',
  'ui/src/renderer/src/components/ui/inspector.css',
  'ui/src/renderer/src/ghostty/surface.fitPaint.test.ts',
  'ui/src/renderer/src/components/files/FilesSurface.tsx',
  'ui/package.json',
  'AGENTS.md',
  'Cargo.toml',
  'README.md',
]

const modified = new Set([
  'core/houston-core/src/daemon.rs',
  'core/houston-protocol/src/lib.rs',
  'docs/user/files.md',
  'ui/src/renderer/src/components/SidePanel.tsx',
  'ui/src/renderer/src/ghostty/surface.ts',
  'ui/src/renderer/src/App.tsx',
  'ui/src/renderer/src/components/ui/inspector.css',
])
const added = new Set(['core/houston-core/src/files.rs', 'ui/src/renderer/src/components/ChildContextMenu.tsx', 'ui/src/renderer/src/components/ui/AnimOut.tsx'])

function makeEntries(directory: string): Array<{ name: string; path: string; dir: boolean; ignored: boolean }> {
  const descendants = paths.filter((path) => path.startsWith(directory ? `${directory}/` : ''))
  const children = new Map<string, boolean>()
  for (const path of descendants) {
    const rest = directory ? path.slice(directory.length + 1) : path
    const name = rest.split('/')[0]
    if (name) children.set(name, rest.includes('/'))
  }
  return [...children].map(([name, dir]) => ({ name, path: directory ? `${directory}/${name}` : name, dir, ignored: name === 'target' }))
}

function setupBridge(diskChanged: boolean): void {
  const callbacks = new Map<number, (event: { payload: unknown }) => void>()
  let nextCallback = 0
  const invoke = async (command: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    if (command === 'fs_read_directory') {
      const directory = String(args.dirPath ?? '')
      const relative = directory === root ? '' : directory.slice(root.length + 1)
      return makeEntries(relative).map((entry) => ({ ...entry, path: `${root}/${entry.path}` }))
    }
    if (command === 'fs_read_file') return source
    if (command === 'fs_stat') return { mtimeMs: 1 }
    if (command === 'shell_list_editors') return [{ id: 'code', label: 'VS Code' }, { id: 'zed', label: 'Zed' }]
    if (command === 'fs_search_paths') {
      const query = String(args.query ?? '').toLowerCase()
      const items = paths.filter((path) => path.toLowerCase().includes(query)).map((path) => {
        const name = path.split('/').at(-1) ?? path
        const nameIndices = [...name.toLowerCase()].flatMap((char, index) => char === query[0] ? [index] : [])
        const pathIndices = [...path.toLowerCase()].flatMap((char, index) => char === query[0] ? [index] : [])
        return { path, name, isDir: false, nameIndices, pathIndices }
      }).slice(0, Number(args.limit ?? 200))
      return { items, total: items.length, truncated: false }
    }
    if (command === 'fs_watch_dirs' || command === 'fs_unwatch' || command === 'plugin:event|unlisten') return null
    if (command === 'plugin:event|listen') {
      const id = nextCallback++
      const callbackId = args.handler as number
      if (args.event === 'fs://changed' && diskChanged)
        window.setTimeout(() => callbacks.get(callbackId)?.({ payload: { root, paths: [openPath] } }), 3000)
      return id
    }
    return null
  }
  Object.assign(window, {
    __TAURI_INTERNALS__: {
      invoke,
      transformCallback: (callback: (event: { payload: unknown }) => void) => {
        const id = nextCallback++
        callbacks.set(id, callback)
        return id
      },
      unregisterCallback: (id: number) => callbacks.delete(id),
    },
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
  })
}

function FilesSurfaceFrame({ width, state }: { width: number; state: 'tree' | 'file' | 'quick' | 'disk' | 'open-in' }): React.JSX.Element {
  const [quickOpenRequest, setQuickOpenRequest] = useState<number | undefined>()
  useState(() => {
    document.documentElement.dataset.theme = 'paper'
    localStorage.setItem(`tr-files-tabs:${root}`, JSON.stringify({
      tabs: state === 'tree' ? [] : [{ path: openPath, preview: false }],
      activePath: state === 'tree' ? null : openPath,
    }))
    setupBridge(state === 'disk')
    return true
  })
  useEffect(() => {
    if (state === 'quick') setQuickOpenRequest(1)
    if (state === 'open-in') window.setTimeout(() => {
      document.querySelector<HTMLButtonElement>('.files-openin')?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    }, 1800)
    if (state !== 'disk') return
    const dirtyBuffer = window.setInterval(() => {
      const buffer = getBuffer(root, openPath)
      if (!buffer) return
      window.clearInterval(dirtyBuffer)
      noteUpdate(root, openPath, buffer.state.update({ changes: { from: 0, insert: ' ' } }).state, true)
    }, 100)
    return () => window.clearInterval(dirtyBuffer)
  }, [state])
  useEffect(() => {
    if (state !== 'tree') {
      void (async () => {
        for (let attempt = 0; attempt < 40 && !document.querySelector('[role="treeitem"][aria-label="ui"]'); attempt++)
          await new Promise((resolve) => window.setTimeout(resolve, 50))
        const branches: Array<[string, number]> = [['ui', 0], ['src', 0], ['renderer', 0], ['src', 1], ['components', 0]]
        for (const [name, occurrence] of branches) {
          const matches = [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')].filter((item) => item.getAttribute('aria-label') === name)
          const row = matches[occurrence]
          if (!row || row.getAttribute('aria-expanded') === 'true') continue
          row.click()
          await new Promise((resolve) => window.setTimeout(resolve, 240))
        }
        await new Promise((resolve) => window.setTimeout(resolve, 350))
      })()
    }
  }, [state])
  const client = {
    subscribe(kind: string, handler: (message: never) => void) {
      if (kind === 'git_status') queueMicrotask(() => handler({
        dir: root,
        base: null,
        not_a_repo: false,
        files: paths.flatMap((path) => {
          const relative = path
          const status = modified.has(relative) ? 'modified' : added.has(relative) ? 'added' : null
          return status ? [{ path: relative, status, staged: false, added: status === 'added' ? 1 : 12, deleted: status === 'modified' ? 3 : 0, is_sensitive: false }] : []
        }),
      } as never))
      if (kind === 'git_diff') queueMicrotask(() => handler({
        dir: root,
        base: null,
        path: 'ui/src/renderer/src/App.tsx',
        truncated: false,
        patch: '@@ -6,1 +6,1 @@\n-old\n+new\n@@ -7,1 +7,1 @@\n-old\n+new\n@@ -10,1 +10,1 @@\n-old\n+new'
      } as never))
      return () => {}
    },
    gitStatus() {},
    gitDiff() {},
  } as unknown as HoustonClient
  return (
    <div style={{ position: 'absolute', inset: 0, background: 'var(--rail-bg)', color: 'var(--text-primary)' }}>
      <header style={{ position: 'absolute', inset: '0 0 auto', height: 40, display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
        <strong style={{ fontSize: 13 }}>Houston</strong><span style={{ marginLeft: 'auto', color: 'var(--text-muted)' }}>⊞　◧　−</span>
      </header>
      <aside style={{ position: 'absolute', top: 40, left: 0, bottom: 0, width: 260, padding: 10, borderRight: '1px solid var(--border)', color: 'var(--text-secondary)', fontSize: 13 }}>
        <div style={{ height: 30, padding: '6px 8px', borderRadius: 7, background: 'var(--hover-fill)', color: 'var(--text-muted)' }}>⌕　Search <span style={{ float: 'right' }}>Ctrl K</span></div>
        <div style={{ display: 'grid', gap: 10, margin: '14px 8px 24px' }}>{['Tasks', 'Skills', 'Routines', 'Harness', 'Connections'].map((item) => <span key={item}>◷　{item}</span>)}</div>
        <div style={{ padding: '0 8px 10px', fontSize: 12 }}>Workspaces　<span style={{ float: 'right' }}>☷　＋</span></div>
        <div style={{ height: 34, padding: '8px', borderRadius: 7, background: 'var(--hover-fill)' }}>⌄　Houston <span style={{ float: 'right', color: 'var(--text-muted)' }}>2</span></div>
        <div style={{ padding: '10px 8px', borderRadius: 7 }}>　Inspector polish</div>
      </aside>
      <main style={{ position: 'absolute', top: 40, left: 260, right: width, bottom: 0, padding: '0 5px 6px 10px', minWidth: 0 }}>
        <div style={{ height: '100%', overflow: 'hidden', border: '1px solid var(--border)', borderRadius: 12, background: 'var(--content-bg)' }}>
          <div style={{ height: 30, display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', borderBottom: '1px solid var(--divider)', fontSize: 11.5 }}><span style={{ color: 'var(--claude)' }}>✳</span><b>Claude Code</b><span style={{ padding: '2px 6px', borderRadius: 5, background: 'var(--hover-fill)', color: 'var(--text-muted)' }}>⌘ main</span><span style={{ color: 'var(--text-muted)' }}>···　↗　＋　×</span></div>
          <div style={{ padding: '14px', font: '12px/20px var(--font-mono)', color: 'var(--text-secondary)' }}>
            <div><span style={{ color: 'var(--accent)' }}>›</span> corrige o flicker da sidebar e anima a abertura</div>
            <div style={{ marginTop: 18 }}>● Read ghostty/surface.ts</div><div>● Edit ghostty/surface.ts <span style={{ color: 'var(--ok)' }}>+12</span> <span style={{ color: 'var(--stop)' }}>-3</span></div><div>● Edit components/ui/AnimOut.tsx <span style={{ color: 'var(--ok)' }}>+9</span> <span style={{ color: 'var(--stop)' }}>-2</span></div><div>● Bash bun run test ghostty/surface.fitPaint.test.ts</div><div style={{ paddingLeft: 16 }}>✓ 6 passed</div>
            <div style={{ marginTop: 28 }}>O canvas redimensionado agora é pintado no mesmo frame.</div><div>O inspector desliza com transform; o grid muda de largura uma vez.</div><div style={{ marginTop: 32, color: 'var(--accent)' }}>› <span style={{ color: 'var(--text-primary)' }}>█</span></div>
          </div>
        </div>
      </main>
      <div style={{ position: 'absolute', top: 40, right: 0, bottom: 0, width, display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--border)' }}>
        <div style={{ height: 30, flex: 'none', display: 'flex', alignItems: 'center', gap: 5, padding: '0 10px', borderBottom: '1px solid var(--divider)', fontSize: 11.5, color: 'var(--text-muted)' }}>
          <span>◫ Diff</span><span>♧ #95</span><span>◎ New tab</span><strong style={{ padding: '4px 7px', borderRadius: 6, background: 'var(--hover-fill)', color: 'var(--text-primary)', fontWeight: 500 }}>▤ {state === 'file' ? 'App.tsx' : 'Files'}</strong><span>＋</span>
        </div>
        <FilesSurface workspaceRoot={root} panelWidth={width} client={client} quickOpenRequest={quickOpenRequest} />
      </div>
    </div>
  )
}

export const FilesSurfaceTree340 = (): React.JSX.Element => <FilesSurfaceFrame width={340} state="tree" />
export const FilesSurfaceTree470 = (): React.JSX.Element => <FilesSurfaceFrame width={470} state="tree" />
export const FilesSurfaceTree600 = (): React.JSX.Element => <FilesSurfaceFrame width={600} state="tree" />
export const FilesSurfaceTree732 = (): React.JSX.Element => <FilesSurfaceFrame width={732} state="tree" />
export const FilesSurfaceFile340 = (): React.JSX.Element => <FilesSurfaceFrame width={340} state="file" />
export const FilesSurfaceFile470 = (): React.JSX.Element => <FilesSurfaceFrame width={470} state="file" />
export const FilesSurfaceFile600 = (): React.JSX.Element => <FilesSurfaceFrame width={600} state="file" />
export const FilesSurfaceFile732 = (): React.JSX.Element => <FilesSurfaceFrame width={732} state="file" />
export const FilesSurfaceQuickOpen = (): React.JSX.Element => <FilesSurfaceFrame width={470} state="quick" />
export const FilesSurfaceDiskChanged = (): React.JSX.Element => <FilesSurfaceFrame width={600} state="disk" />
export const FilesSurfaceOpenIn = (): React.JSX.Element => <FilesSurfaceFrame width={732} state="open-in" />
