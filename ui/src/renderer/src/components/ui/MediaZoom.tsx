import type { ImgHTMLAttributes, ReactNode, Ref } from 'react'
import { Text } from './Text'

export type MediaZoomCursor = 'zoom-in' | 'grab' | 'grabbing'
const ZOOM_CURSOR: Record<MediaZoomCursor, string> = { 'zoom-in': 'cursor-zoom-in', grab: 'cursor-grab', grabbing: 'cursor-grabbing' }

/** The focusable scroll region of a zoomable image; keyboard focus draws an inset ring. */
export function MediaZoomViewport({ cursor, ref, ...props }: React.HTMLAttributes<HTMLDivElement> & { cursor: MediaZoomCursor; ref?: Ref<HTMLDivElement> }): React.JSX.Element {
  return <div {...props} ref={ref} className={`absolute inset-0 overflow-auto overscroll-contain select-none outline-none focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:[outline-offset:-2px] ${ZOOM_CURSOR[cursor]} ${props.className ?? ''}`} />
}

/** Past 200% each source pixel stays a crisp square, so screenshots can be read pixel by pixel. */
export function MediaZoomImage({ pixelated, ...props }: ImgHTMLAttributes<HTMLImageElement> & { pixelated: boolean }): React.JSX.Element {
  return <img {...props} draggable={false} className={`absolute block max-w-none ${pixelated ? '[image-rendering:pixelated]' : ''} ${props.className ?? ''}`} />
}

export function MediaZoomBar({ children, ...props }: React.HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <div {...props} className={`absolute right-[var(--space-2)] bottom-[var(--space-2)] z-[var(--z-sticky)] flex items-center gap-[var(--space-0-5)] p-[var(--space-0-5)] floating-glass shadow-[var(--shadow-1)] ${props.className ?? ''}`}>{children}</div>
}

export function MediaZoomReadout({ children, ...props }: React.HTMLAttributes<HTMLElement> & { children: ReactNode }): React.JSX.Element {
  return <Text {...props} as="span" size="small" weight="small" tone="secondary" tabular center className={`min-w-[5ch] ${props.className ?? ''}`}>{children}</Text>
}
