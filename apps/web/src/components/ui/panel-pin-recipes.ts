import { MOTION_FEEDBACK_OPACITY } from "./motion-recipes";

/**
 * The pin control's reveal. Unpinned it fades in while the panel header (`group/panel-header`) is
 * hovered or holds focus, and stays visible on touch; pinned it never hides.
 */
export function panelPinRevealCls(pinned: boolean): string {
  return pinned
    ? "opacity-100"
    : `opacity-0 group-hover/panel-header:opacity-100 group-focus-within/panel-header:opacity-100 pointer-coarse:opacity-100 ${MOTION_FEEDBACK_OPACITY}`;
}
