import type { HTMLAttributes } from 'react'

export interface ResizeHandleProps extends Omit<HTMLAttributes<HTMLDivElement>, 'role'> {
  width: number
  min: number
  max: number
  dragging?: boolean
}

export function ResizeHandle({ width, min, max, dragging = false, className = '', ...props }: ResizeHandleProps): React.JSX.Element {
  return <div {...props} data-testid="rail-resize-handle" data-dragging={dragging ? 'true' : undefined} role="separator" aria-orientation="vertical" aria-label="Resize sidebar" aria-valuemin={min} aria-valuemax={max} aria-valuenow={width} className={`absolute inset-y-0 left-[var(--w-rail)] z-[var(--z-sticky)] w-2 -translate-x-1 cursor-col-resize touch-none bg-transparent after:content-[''] after:absolute after:inset-0 after:w-px after:mx-auto after:bg-transparent motion-safe:after:[transition:background-color_0.1s_ease-out] data-[dragging]:after:bg-[var(--text-faint)] ${className}`} />
}

export function ResizeHandleSpecimen(): React.JSX.Element {
  return <div className="relative h-24 w-64 bg-[var(--rail-bg)]" style={{ ['--w-rail' as string]: '240px' }}><ResizeHandle width={240} min={180} max={420} /></div>
}
