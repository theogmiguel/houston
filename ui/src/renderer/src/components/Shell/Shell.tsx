import type { CSSProperties, ReactNode } from 'react'
import { BackdropMount } from '../../backdrop/BackdropMount'
import { RAIL_DEFAULT } from '../../railWidth'
import type { ChromeTheme } from '../../theme'

export function Shell({
  chromeTheme,
  onBackgroundUnavailable,
  railWidth = RAIL_DEFAULT,
  railCollapsed = false,
  downbar = false,
  children
}: {
  chromeTheme: ChromeTheme
  onBackgroundUnavailable?: (reason: string) => void
  railWidth?: number
  railCollapsed?: boolean
  downbar?: boolean
  children: ReactNode
}): React.JSX.Element {
  return (
    <div
      className="h-screen relative grid overflow-hidden"
      style={{
        ['--w-rail' as string]: railCollapsed ? '0px' : `${railWidth}px`,
        gridTemplateColumns: 'var(--w-rail) minmax(0, 1fr)',
        gridTemplateRows: `var(--h-top) 1fr ${downbar ? 'var(--h-downbar)' : '0px'}`,
        gridTemplateAreas: '"rail topbar" "rail grid" "rail downbar"'
      } as CSSProperties}
    >
      <BackdropMount
        theme={chromeTheme}
        {...(onBackgroundUnavailable ? { onUnavailable: onBackgroundUnavailable } : {})}
      />
      {children}
    </div>
  )
}
