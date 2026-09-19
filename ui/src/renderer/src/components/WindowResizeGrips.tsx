import { isTauri } from '../houston/host'
import { startResizeDragging, type ResizeDirection } from '../houston/bridge'

const EDGE = 6
const CORNER = EDGE * 2

interface Grip {
  direction: ResizeDirection
  cursor: string
  style: React.CSSProperties
}

const GRIPS: Grip[] = [
  { direction: 'north', cursor: 'ns-resize', style: { top: 0, left: 0, right: 0, height: EDGE } },
  { direction: 'south', cursor: 'ns-resize', style: { bottom: 0, left: 0, right: 0, height: EDGE } },
  { direction: 'west', cursor: 'ew-resize', style: { top: 0, bottom: 0, left: 0, width: EDGE } },
  { direction: 'east', cursor: 'ew-resize', style: { top: 0, bottom: 0, right: 0, width: EDGE } },
  {
    direction: 'north-west',
    cursor: 'nwse-resize',
    style: { top: 0, left: 0, width: CORNER, height: CORNER }
  },
  {
    direction: 'north-east',
    cursor: 'nesw-resize',
    style: { top: 0, right: 0, width: CORNER, height: CORNER }
  },
  {
    direction: 'south-west',
    cursor: 'nesw-resize',
    style: { bottom: 0, left: 0, width: CORNER, height: CORNER }
  },
  {
    direction: 'south-east',
    cursor: 'nwse-resize',
    style: { bottom: 0, right: 0, width: CORNER, height: CORNER }
  }
]

// Frameless window grips built from the page: `decorations: false` removes the WM
// border, and the replacement tao installs never fires because WebKitWebView
// consumes the press first. Electron has a native border, so it renders nothing.
export function WindowResizeGrips(): React.JSX.Element | null {
  if (!isTauri()) return null
  return (
    <>
      {GRIPS.map((grip) => (
        <div
          key={grip.direction}
          data-testid={`resize-grip-${grip.direction}`}
          aria-hidden="true"
          className="fixed z-[var(--z-window)] [-webkit-app-region:no-drag]"
          style={{ ...grip.style, cursor: grip.cursor }}
          onMouseDown={(e) => {
            if (e.button !== 0) return
            e.preventDefault()
            void startResizeDragging(grip.direction).catch((err: unknown) => {
              console.warn('houston: startResizeDragging failed', grip.direction, err)
            })
          }}
        />
      ))}
    </>
  )
}
