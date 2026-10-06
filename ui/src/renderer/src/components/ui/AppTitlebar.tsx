import type { MouseEventHandler, ReactNode } from 'react'
import { MATERIAL_CLS, materialAttrs } from './material'

export function AppTitlebar({ children, custom, dataCustom, onMouseDown, onDoubleClick }: {
  children: ReactNode
  custom: boolean
  dataCustom: 'on' | undefined
  onMouseDown: MouseEventHandler<HTMLElement>
  onDoubleClick: MouseEventHandler<HTMLElement>
}): React.JSX.Element {
  return (
    <header
      data-custom={dataCustom}
      {...materialAttrs('shell')}
      className={`relative [grid-area:topbar] grid grid-cols-[minmax(0,1fr)_auto] items-center h-[var(--h-top)] [-webkit-app-region:drag] select-none ${MATERIAL_CLS.shell} ${custom ? 'shadow-[var(--glass-topbar-shadow)]' : ''}`}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
    >
      {children}
    </header>
  )
}

export function AppTitlebarSpecimen(): React.JSX.Element {
  return <div data-testid="app-titlebar-specimen" className="h-[var(--h-primitives-preview)]"><AppTitlebar custom={false} dataCustom={undefined} onMouseDown={() => {}} onDoubleClick={() => {}}><span>Workspace</span><span>Window actions</span></AppTitlebar></div>
}
