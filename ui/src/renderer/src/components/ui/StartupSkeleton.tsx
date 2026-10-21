import type { MouseEventHandler } from 'react'
import { MATERIAL_CLS, materialAttrs } from './material'

/** The shell silhouette while the desktop bridge loads. */
export function StartupSkeleton({ onDragMouseDown }: { onDragMouseDown: MouseEventHandler<HTMLElement> }): React.JSX.Element {
  return (
    <div className="h-screen grid overflow-hidden" style={{ gridTemplateColumns: 'auto minmax(0, 1fr)', gridTemplateRows: 'var(--h-top) 1fr', gridTemplateAreas: '"rail topbar" "rail grid"' }}>
      <aside {...materialAttrs('shell')} className={`[grid-area:rail] w-60 flex-none flex flex-col relative z-[var(--z-leaf)] ${MATERIAL_CLS.shell} border-r border-[var(--divider)]`}>
        <div className="h-[var(--h-railhead)] flex-none flex items-center gap-[var(--space-2-5)] px-[var(--space-3)] [-webkit-app-region:drag] select-none" onMouseDown={onDragMouseDown}>
          {/* The pre-boot page styles its own .boot-spinner inline; the mounted skeleton carries the renderer recipe. */}
          <div className="h-[var(--tr-icon-subhead-size)] w-[var(--tr-icon-subhead-size)] animate-spin rounded-[var(--tr-radius-pill)] [border-width:var(--tr-spinner-border)] border-[var(--accent)] border-t-transparent opacity-70" />
        </div>
      </aside>
      <div {...materialAttrs('shell')} className={`[grid-area:topbar] h-[var(--h-top)] [-webkit-app-region:drag] select-none ${MATERIAL_CLS.shell}`} onMouseDown={onDragMouseDown} />
      <main className="[grid-area:grid] min-w-0 min-h-0 relative overflow-hidden"><div {...materialAttrs('inset')} className={`absolute inset-[var(--pane-gutter)] rounded-[var(--tr-radius-md)] ${MATERIAL_CLS.inset}`} /></main>
    </div>
  )
}

export function StartupSkeletonSpecimen(): React.JSX.Element {
  return <div data-testid="startup-skeleton-specimen" className="relative h-[var(--h-primitives-preview-tall)] overflow-hidden [contain:paint]"><StartupSkeleton onDragMouseDown={() => {}} /></div>
}
