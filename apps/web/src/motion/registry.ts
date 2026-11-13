/** Resolve every animation by name, so the settings and reduced motion apply in one place. */
import type { SpringParams } from "./spring";

export type MotionCurve =
  | "linear"
  | "ease-out-quad"
  | "ease-out-cubic"
  | "ease-out-expo"
  | { readonly cubicBezier: readonly [number, number, number, number] };

export type MotionConfig =
  | { readonly kind: "off" }
  | ({ readonly kind: "spring" } & SpringParams)
  | { readonly kind: "easing"; readonly durationMs: number; readonly curve: MotionCurve };

export type MotionName = "horizontal-view-movement" | "workspace-switch" | "overview-open-close";

/**
 * The CSS motion roles in index.css (`--motion-*`), for animations driven from script.
 * A test keeps the two in step; reduced motion is handled by `resolveMotion` here and by
 * the stylesheet's media query there.
 */
export const MOTION_ROLE_MS = {
  feedback: 100,
  "overlay-in": 150,
  "overlay-out": 100,
  "modal-in": 220,
  "modal-out": 160,
  "toast-in": 220,
  "toast-out": 140,
  "swap-in": 160,
  "swap-out": 80,
  "list-in": 180,
  "list-out": 140,
  disclosure: 200,
  value: 120,
  stagger: 40,
  "content-delay": 60,
} as const;

export type MotionRole = keyof typeof MOTION_ROLE_MS;

/** The stylesheet's `--ease-standard` and `--ease-exit`. */
export const MOTION_EASE = {
  standard: [0.2, 0, 0, 1],
  exit: [0.4, 0, 1, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>;

const spring = (dampingRatio: number, stiffness: number, epsilon: number): MotionConfig => ({
  kind: "spring",
  dampingRatio,
  stiffness,
  epsilon,
});

/**
 * The prototype's feel: a slight overshoot that settles in about 460ms. A
 * damping ratio of 0.9 keeps that bounce without the pane visibly wobbling.
 */
const LAYOUT_SPRING: MotionConfig = spring(0.9, 500, 0.0001);

const MOTION_DEFAULTS: Readonly<Record<MotionName, MotionConfig>> = {
  // The layout's camera, workspace stack and overview zoom share one spring, so every
  // movement of the window settles with one feel.
  "horizontal-view-movement": LAYOUT_SPRING,
  "workspace-switch": LAYOUT_SPRING,
  "overview-open-close": LAYOUT_SPRING,
};

interface MotionSettings {
  /** Every animation completes instantly. */
  off: boolean;
  /** Plays every animation this many times slower; 0.001 is the floor that still moves. */
  slowdown: number;
  animations: Partial<Record<MotionName, MotionConfig>>;
}

const settings: MotionSettings = { off: false, slowdown: 1, animations: {} };
const listeners = new Set<() => void>();
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Applies the motion settings. `off` mirrors the Appearance "Animations" switch: the
 * root's `data-motion="off"` makes the stylesheet treat it like the system's reduced
 * motion, and script reads it through `prefersReducedMotion`.
 */
export function configureMotion(next: Partial<MotionSettings>): void {
  if (next.off !== undefined && next.off !== settings.off) {
    settings.off = next.off;
    if (typeof document !== "undefined") {
      if (next.off) document.documentElement.dataset.motion = "off";
      else delete document.documentElement.dataset.motion;
    }
    for (const listener of listeners) listener();
  }
  if (next.slowdown !== undefined)
    settings.slowdown = Math.min(1000, Math.max(0.001, next.slowdown));
  if (next.animations) settings.animations = { ...settings.animations, ...next.animations };
}

/** The settings in force, for tests and diagnostics. */
export function motionSettings(): Readonly<MotionSettings> {
  return settings;
}

/**
 * True when animations should not play: the Animations setting is off or the system asks
 * for reduced motion. The one check every script-driven animation uses.
 */
export function prefersReducedMotion(): boolean {
  return (
    settings.off ||
    (typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(REDUCED_MOTION_QUERY).matches)
  );
}

/** Calls `listener` whenever `prefersReducedMotion()` may have changed. */
export function subscribeReducedMotion(listener: () => void): () => void {
  listeners.add(listener);
  const media =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(REDUCED_MOTION_QUERY)
      : null;
  media?.addEventListener?.("change", listener);
  return () => {
    listeners.delete(listener);
    media?.removeEventListener?.("change", listener);
  };
}

/** The animation `name` plays with now: `off` under reduced motion or the global switch. */
export function resolveMotion(name: MotionName): { config: MotionConfig; slowdown: number } {
  if (prefersReducedMotion()) {
    return { config: { kind: "off" }, slowdown: 1 };
  }
  return {
    config: settings.animations[name] ?? MOTION_DEFAULTS[name],
    slowdown: settings.slowdown,
  };
}
