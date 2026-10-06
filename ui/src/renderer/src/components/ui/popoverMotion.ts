export interface PopoverBounds {
  width: number
  height: number
}

export function anchorPopoverStart(
  triggerLeft: number,
  triggerWidth: number,
  viewportWidth: number,
  viewportMargin: number
): number {
  return Math.max(viewportMargin, Math.min(triggerLeft, viewportWidth - triggerWidth - viewportMargin))
}

export function largestViewBounds(views: readonly PopoverBounds[]): PopoverBounds {
  return views.reduce(
    (largest, view) => ({ width: Math.max(largest.width, view.width), height: Math.max(largest.height, view.height) }),
    { width: 0, height: 0 }
  )
}

export const POPOVER_HEADER_CLS = 'popover-header-in'
export const POPOVER_BODY_CLS = 'popover-body-in'
