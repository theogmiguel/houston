import React from 'react'
import { Sidebar } from '../src/components/Sidebar'
import { NoticeStack } from '../src/components/NoticeStack'
import type { SessionInfo, Workspace } from '../src/houston/client'
import { useNotices } from '../src/notices'
import { GRID_PINNED_KEY, GRID_PINNED_MIGRATION_KEY } from '../src/railPrefs'

const noop = (): void => {}
const ROOT = '/home/dev/code'
const ws = (name: string): Workspace => ({ path: `${ROOT}/${name}`, name }) as Workspace
const SESSIONS: SessionInfo[] = []
const GRIDS = {
  [`${ROOT}/acme-api`]: [
    { id: 'work-in', name: 'Work in', sessionIds: [] },
    { id: 'review', name: 'Review pass', sessionIds: [] },
    { id: 'idle', name: 'Idle tab', sessionIds: [] }
  ],
  [`${ROOT}/bridge`]: [{ id: 'one', name: 'Bridge tab', sessionIds: [] }]
}
const TO_PIN = ['Work in', 'Review pass', 'Idle tab']

/** Pins three grids from their context menus, one after another, the way a user would. */
function usePinThree(): React.RefObject<HTMLDivElement | null> {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    let step = 0
    let tries = 0
    const timer = window.setInterval(() => {
      const root = ref.current
      if (!root || step >= TO_PIN.length || ++tries > 200) return window.clearInterval(timer)
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent?.trim() === 'Pin to top')
      if (item) {
        item.click()
        step++
        return
      }
      const row = [...root.querySelectorAll<HTMLElement>('[data-testid="grid-row"]')].find((el) => el.textContent?.includes(TO_PIN[step]))
      if (!row) return
      const box = row.getBoundingClientRect()
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 40, clientY: box.top + box.height / 2 }))
    }, 30)
    return () => window.clearInterval(timer)
  }, [])
  return ref
}

function RailUndoFrame({ chromeTheme }: { chromeTheme: 'graphite' | 'paper' }): React.JSX.Element {
  const seeded = React.useRef(false)
  if (!seeded.current) {
    localStorage.setItem(GRID_PINNED_MIGRATION_KEY, '1')
    localStorage.setItem(GRID_PINNED_KEY, '[]')
    seeded.current = true
  }
  const notices = useNotices()
  const ref = usePinThree()
  return (
    <div ref={ref} style={{ display: 'flex', height: '100%' }}>
      <style>{'.ctxmenu, [data-notice] { animation: none !important; }'}</style>
      <div style={{ display: 'flex', width: 260 }}>
        <Sidebar
          workspaces={[ws('acme-api'), ws('bridge')]}
          sessions={SESSIONS}
          selected={`${ROOT}/acme-api`}
          selectedGridId="work-in"
          gridsByWorkspace={GRIDS}
          customColors={{}}
          colorIndexByPath={{}}
          renaming={null}
          onSelect={noop}
          onAddWorkspace={noop}
          onRemoveWorkspace={noop}
          onRenameStart={noop}
          onRenameSubmit={noop}
          onRenameCancel={noop}
          onChangeColor={noop}
          onReorderWorkspace={noop}
          pinnedWorkspaces={new Set()}
          onTogglePinWorkspace={noop}
          notices={notices}
          onSshConnect={noop}
          chromeTheme={chromeTheme}
          onToggleChromeTheme={noop}
          onSelectGrid={noop}
          onOpenPalette={noop}
          paletteChord="Ctrl K"
        />
      </div>
      <div style={{ position: 'relative', flex: 1, background: 'var(--background)' }}>
        <NoticeStack anchor="workspace-top" label="Workspace notices" store={notices} />
      </div>
    </div>
  )
}

export function RailUndoStory(): React.JSX.Element { return <RailUndoFrame chromeTheme="graphite" /> }
