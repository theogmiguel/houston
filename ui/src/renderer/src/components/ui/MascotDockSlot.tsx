import { forwardRef } from 'react'

export const MascotDockSlot = forwardRef<HTMLDivElement, { dragging: boolean }>(function MascotDockSlot({ dragging }, ref) {
  return <div ref={ref} className="mascot-dock" data-mascot-drop-target={dragging} aria-label={dragging ? 'Drop Houston here to return to the rail' : undefined}><span className="mascot-dock-anchor" data-mascot-dock-anchor aria-hidden="true" /></div>
})
