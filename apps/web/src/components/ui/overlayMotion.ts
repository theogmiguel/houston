/**
 * Anchored popups grow from the anchor and fade in, then leave faster. Base UI marks the states
 * with `data-starting-style`/`data-ending-style`; self-mounting popups use `starting:`.
 */
export const overlayMotion =
  "origin-(--transform-origin) transition-[opacity,scale] duration-(--motion-overlay-in) ease-standard data-starting-style:scale-97 data-starting-style:opacity-0 starting:scale-97 starting:opacity-0 data-ending-style:scale-97 data-ending-style:opacity-0 data-ending-style:duration-(--motion-overlay-out) data-ending-style:ease-exit";
