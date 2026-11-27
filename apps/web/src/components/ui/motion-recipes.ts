/** Pointer feedback on colour, such as a row that tints on hover. */
export const MOTION_FEEDBACK = "transition-colors duration-(--motion-feedback) ease-standard";

/** Colour feedback that keeps the stylesheet's default easing. */
export const MOTION_FEEDBACK_DEFAULT_EASE = "transition-colors duration-(--motion-feedback)";

/** Pointer feedback on opacity, for a control that reveals or recedes in place. */
export const MOTION_FEEDBACK_OPACITY =
  "transition-opacity duration-(--motion-feedback) ease-standard";

/** A chevron turns with the disclosure role as its section opens or closes. */
export const MOTION_DISCLOSURE_ROTATE =
  "transition-transform duration-(--motion-disclosure) ease-standard";

/** A panel reveals in place on the disclosure role; reduced motion removes the transition. */
export const MOTION_DISCLOSURE_REVEAL =
  "motion-safe:transition-[opacity,translate] motion-safe:duration-(--motion-disclosure) motion-safe:ease-standard starting:opacity-0 starting:translate-y-1 motion-reduce:transition-none";

/** A floating control rises into place on the toast roles and leaves faster. */
export const MOTION_RISE_IN =
  "translate-y-0 opacity-100 transition-[opacity,translate] duration-(--motion-toast-in) ease-standard";
export const MOTION_RISE_OUT =
  "-translate-y-1 opacity-0 transition-[opacity,translate] duration-(--motion-toast-out) ease-exit";
