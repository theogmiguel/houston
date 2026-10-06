import React from 'react'
import { Sidebar } from '../src/components/Sidebar'
import { RailResizeHandle } from '../src/components/RailResizeHandle'
import { WorkspacesEmpty } from '../src/components/WorkspacesEmpty'
import { setSettingsOpen } from '../src/settingsNav'
import { setUpdateInstallForTests } from '../src/updateInstall'
import type { SessionInfo, Workspace } from '../src/houston/client'

const noop = (): void => {}

const WS_ROOT = '/home/dev/code'
const ws = (name: string): Workspace => ({ path: `${WS_ROOT}/${name}`, name }) as Workspace
const path = (name: string): string => `${WS_ROOT}/${name}`

const TAGS = [
  { id: 1, name: 'Bug', color: '#f472b6' },
  { id: 2, name: 'Review', color: '#f59e0b' }
]

function seedStorage(opts: { collapsed?: string[]; tagFilter?: number[] }): void {
  try {
    localStorage.setItem('tr-ws-collapsed', JSON.stringify(opts.collapsed ?? []))
    localStorage.setItem('houston.tagFilter', JSON.stringify(opts.tagFilter ?? []))
  } catch {}
}

interface RailProps {
  workspaces?: Workspace[]
  pinned?: string[]
  selected?: string
  renaming?: string | null
  collapsed?: string[]
  tagFilter?: number[]
  settingsOpen?: boolean
  updateVersion?: string | null
  withGrids?: boolean
  chromeTheme?: 'graphite' | 'paper'
  freezeMenuMotion?: boolean
  freezeCaret?: boolean
}

function RailFixture({
  workspaces = [ws('acme-core'), ws('acme-api'), ws('bridge'), ws('acme-ui'), ws('houston')],
  pinned = [path('acme-core')],
  selected = path('acme-api'),
  renaming = null,
  collapsed = [path('bridge')],
  tagFilter = [],
  settingsOpen = false,
  updateVersion = '9.9.9',
  withGrids = true,
  chromeTheme = 'graphite',
  freezeMenuMotion = false,
  freezeCaret = false
}: RailProps): React.JSX.Element {
  const ready = React.useRef(false)
  if (!ready.current) {
    seedStorage({ collapsed, tagFilter })
    setSettingsOpen(settingsOpen)
    ready.current = true
  }
  return (
    <div style={{ display: 'flex', height: '100%', width: 260 }}>
      {(freezeMenuMotion || freezeCaret) && <style>{`${freezeMenuMotion ? '.ctxmenu { animation: none !important; }' : ''}${freezeCaret ? ' input { caret-color: transparent !important; }' : ''}`}</style>}
      <Sidebar
        workspaces={workspaces}
        sessions={[] as SessionInfo[]}
        selected={selected}
        selectedGridId="work-in"
        gridsByWorkspace={withGrids ? {
          [path('acme-api')]: [
            { id: 'work-in', name: 'Work in', count: 5, state: 'working', tagIds: [1] },
            { id: 'review', name: 'Review pass', count: 2, state: 'needs-input', tagIds: [2] },
            { id: 'idle', name: 'Idle tab', state: 'idle' }
          ],
          [path('bridge')]: [{ id: 'one', name: 'Bridge tab', state: 'idle' }],
          [path('acme-core')]: [{ id: 'core', name: 'Core tab', state: 'unavailable' }]
        } : {}}
        customColors={{}}
        colorIndexByPath={{}}
        renaming={renaming}
        onSelect={noop}
        onAddWorkspace={noop}
        onRemoveWorkspace={noop}
        onRenameStart={noop}
        onRenameSubmit={noop}
        onRenameCancel={noop}
        onChangeColor={noop}
        onReorderWorkspace={noop}
        pinnedWorkspaces={new Set(pinned)}
        onTogglePinWorkspace={noop}
        onSshConnect={noop}
        tags={TAGS}
        onTagCreate={noop}
        onTagUpdate={noop}
        onTagDelete={noop}
        onSetGridTags={noop}
        chromeTheme={chromeTheme}
        onToggleChromeTheme={noop}
        onSelectGrid={noop}
        onAddGrid={noop}
        onNewWorkspaceSession={noop}
        onRenameGrid={noop}
        onRemoveGrid={noop}
        onOpenSettings={noop}
        onOpenPalette={noop}
        onHideRail={noop}
        paletteChord="Ctrl+K"
        harnessAttention={2}
        taskTurnCount={3}
        updateVersion={updateVersion}
      />
    </div>
  )
}

/** Retries `act` until it reports done: grid rows and menus arrive through lazy chunks. */
function useScript(act: (root: HTMLElement) => boolean): React.RefObject<HTMLDivElement | null> {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    let tries = 0
    const timer = window.setInterval(() => {
      tries += 1
      const done = ref.current ? act(ref.current) : false
      if (done || tries > 100) window.clearInterval(timer)
    }, 30)
    return () => window.clearInterval(timer)
  }, [])
  return ref
}

function contextMenuOn(el: Element): void {
  const r = el.getBoundingClientRect()
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + r.height / 2 }))
}

function Scripted({ act, ...props }: RailProps & { act: (root: HTMLElement) => boolean }): React.JSX.Element {
  const ref = useScript(act)
  return <div ref={ref} style={{ height: '100%' }}><RailFixture {...props} /></div>
}

function RailMenu({ target, pick, ...props }: RailProps & { target: string; pick?: string }): React.JSX.Element {
  // `pick` is the visible text of the menu item to press once the menu is open.
  let stage = 0
  return (
    <Scripted
      {...props}
      freezeMenuMotion
      act={(root) => {
        if (stage === 0) {
          const el = root.querySelector(target)
          if (!el) return false
          contextMenuOn(el)
          stage = pick ? 1 : 2
          return stage === 2
        }
        const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((el) => el.textContent?.trim() === pick)
        if (stage === 1) {
          if (!item) return false
          item.click()
          if (pick !== 'Rename') return true
          stage = 2
          return false
        }
        const input = root.querySelector<HTMLInputElement>('input')
        if (!input) return false
        input.focus()
        input.setSelectionRange(0, 0)
        return true
      }}
    />
  )
}

function RailRename({ workspace }: { workspace: string }): React.JSX.Element {
  return <Scripted renaming={path(workspace)} freezeCaret act={(root) => {
    const input = root.querySelector<HTMLInputElement>('input')
    if (!input) return false
    input.focus()
    input.setSelectionRange(0, 0)
    return true
  }} />
}

function RailClick({ target, ...props }: RailProps & { target: string }): React.JSX.Element {
  return (
    <Scripted
      {...props}
      act={(root) => {
        const el = root.querySelector<HTMLElement>(target)
        if (!el) return false
        el.click()
        return true
      }}
    />
  )
}

function RailDrag(props: RailProps): React.JSX.Element {
  let stage = 0
  return (
    <Scripted
      {...props}
      act={(root) => {
        const rows = root.querySelectorAll<HTMLElement>('[data-ws-idx]')
        if (rows.length < 4) return false
        const from = rows[2].getBoundingClientRect()
        const to = rows[3].getBoundingClientRect()
        if (stage === 0) {
          rows[2].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: from.left + 40, clientY: from.top + 10 }))
          stage = 1
          return false
        }
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: to.left + 40, clientY: to.top + 4 }))
        return true
      }}
    />
  )
}

function RailSettingsSearch({ query }: { query: string }): React.JSX.Element {
  return (
    <Scripted
      settingsOpen
      act={(root) => {
        const input = root.querySelector<HTMLInputElement>('input')
        if (!input) return false
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setter?.call(input, query)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      }}
    />
  )
}

function UpdateFailed(): React.JSX.Element {
  React.useState(() => {
    setUpdateInstallForTests({ kind: 'failed', version: '9.9.9', error: 'checksum mismatch' })
    return null
  })
  return <RailFixture />
}

function UpdateRunning(): React.JSX.Element {
  React.useState(() => {
    setUpdateInstallForTests({ kind: 'downloading', downloaded: 40, total: 100 })
    return null
  })
  return <RailFixture />
}

const GRID_ROW = '[data-testid="grid-row"]'

function ResizeHandleStory({ dragging }: { dragging: boolean }): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (dragging) ref.current?.querySelector('[data-testid="rail-resize-handle"]')?.setAttribute('data-dragging', 'true')
  }, [dragging])
  return (
    <div ref={ref} style={{ position: 'relative', height: '100%', ['--w-rail' as string]: '240px', background: 'var(--content-bg)' }}>
      <div style={{ width: 240, height: '100%', background: 'var(--rail-bg)' }} />
      <RailResizeHandle width={240} collapsed={false} onChange={noop} onCollapse={noop} />
    </div>
  )
}

function WorkspacesEmptyStory({ variant }: { variant: 'plain' | 'pending' | 'refused' | 'shortcuts-off' }): React.JSX.Element {
  const overrides = { bindings: {}, shortcuts_enabled: variant !== 'shortcuts-off' }
  return (
    <div style={{ display: 'flex', height: '100%' }}>
      {variant === 'pending' && <style>{'[data-testid="workspaces-empty"] [role="status"] { animation-play-state: paused !important; }'}</style>}
      <WorkspacesEmpty
        onAdd={noop}
        pending={variant === 'pending'}
        refusals={variant === 'refused' ? ['refused: /home/dev/code/acme is already registered as a workspace', 'refused: /tmp/scratch is not a git project folder'] : []}
        error={variant === 'refused' ? 'The picker could not open: no display available' : null}
        keymapOverrides={overrides}
        footer={variant === 'plain' ? <div style={{ marginTop: 16, color: 'var(--text-muted)' }}>footer slot</div> : undefined}
      />
    </div>
  )
}

export const RAIL_STORIES: Record<string, () => React.JSX.Element> = {
  'rail/states': () => <RailFixture />,
  'rail/states-paper': () => <RailFixture chromeTheme="paper" />,
  'rail/tag-filter-active': () => <RailFixture tagFilter={[1]} />,
  'rail/plain-selected': () => <RailFixture selected={path('acme-ui')} />,
  'rail/renaming': () => <RailRename workspace="acme-ui" />,
  'rail/renaming-expanded': () => <RailRename workspace="acme-api" />,
  'rail/ws-menu': () => <RailMenu target='[data-ws-idx="3"]' />,
  'rail/ws-menu-pinned': () => <RailMenu target='[data-ws-idx="0"]' />,
  'rail/grid-menu': () => <RailMenu target={GRID_ROW} />,
  'rail/grid-rename': () => <RailMenu target={GRID_ROW} pick="Rename" freezeCaret />,
  'rail/nav-menu': () => <RailMenu target='[data-testid="rail-nav-row"]' />,
  'rail/tag-menu': () => <RailClick target='[data-testid="tree-filter-toggle"]' tagFilter={[2]} />,
  'rail/tag-menu-empty': () => <RailClick target='[data-testid="tree-filter-toggle"]' />,
  'rail/add-menu': () => <RailClick target='button[aria-label="Add workspace"]' />,
  'rail/drag': () => <RailDrag />,
  'rail/settings': () => <RailFixture settingsOpen />,
  'rail/settings-nomatch': () => <RailSettingsSearch query="zzzz" />,
  'rail/settings-hit': () => <RailSettingsSearch query="theme" />,
  'rail/empty': () => <RailFixture workspaces={[]} withGrids={false} />,
  'rail/empty-filtered': () => <RailFixture tagFilter={[2]} workspaces={[ws('acme-core')]} withGrids={false} />,
  'rail/update-failed': () => <UpdateFailed />,
  'rail/update-running': () => <UpdateRunning />,
  'rail/resize-handle': () => <ResizeHandleStory dragging={false} />,
  'rail/resize-handle-drag': () => <ResizeHandleStory dragging />,
  'shell/workspaces-empty': () => <WorkspacesEmptyStory variant="plain" />,
  'shell/workspaces-empty-pending': () => <WorkspacesEmptyStory variant="pending" />,
  'shell/workspaces-empty-refused': () => <WorkspacesEmptyStory variant="refused" />,
  'shell/workspaces-empty-shortcuts-off': () => <WorkspacesEmptyStory variant="shortcuts-off" />
}
