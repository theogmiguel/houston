import { MOTION_FEEDBACK_OPACITY } from "./motion-recipes";

/**
 * The owner title in the panel header: muted, one truncated line. The header is a window drag
 * region on the desktop host, where a drag region swallows hover, so the tooltip trigger opts out.
 */
export const PANEL_PIN_OWNER_CLS =
  "max-w-32 truncate text-xs text-secondary-label [-webkit-app-region:no-drag]";

/**
 * The pin control's reveal. Unpinned it fades in while the panel header (`group/panel-header`) is
 * hovered or holds focus, and stays visible on touch; pinned it never hides.
 */
export function panelPinRevealCls(pinned: boolean): string {
  return pinned
    ? "opacity-100"
    : `opacity-0 group-hover/panel-header:opacity-100 group-focus-within/panel-header:opacity-100 pointer-coarse:opacity-100 ${MOTION_FEEDBACK_OPACITY}`;
}
