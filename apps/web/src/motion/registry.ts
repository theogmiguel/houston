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

export type MotionName = "grid-cell-movement" | "grid-cell-enter";

const spring = (dampingRatio: number, stiffness: number, epsilon: number): MotionConfig => ({
  kind: "spring",
  dampingRatio,
  stiffness,
  epsilon,
});

/**
 * The prototype's feel: a slight overshoot that settles in about 460ms. A
 * damping ratio of 0.9 keeps that bounce without the cell visibly wobbling.
 */
const GRID_CELL_SPRING: MotionConfig = spring(0.9, 500, 0.0001);

const MOTION_DEFAULTS: Readonly<Record<MotionName, MotionConfig>> = {
  "grid-cell-movement": GRID_CELL_SPRING,
  "grid-cell-enter": GRID_CELL_SPRING,
};

interface MotionSettings {
  /** Every animation completes instantly. */
  off: boolean;
  /** Plays every animation this many times slower; 0.001 is the floor that still moves. */
  slowdown: number;
  animations: Partial<Record<MotionName, MotionConfig>>;
}

const settings: MotionSettings = { off: false, slowdown: 1, animations: {} };

export function configureMotion(next: Partial<MotionSettings>): void {
  if (next.off !== undefined) settings.off = next.off;
  if (next.slowdown !== undefined)
    settings.slowdown = Math.min(1000, Math.max(0.001, next.slowdown));
  if (next.animations) settings.animations = { ...settings.animations, ...next.animations };
}

/** The settings in force, for tests and diagnostics. */
export function motionSettings(): Readonly<MotionSettings> {
  return settings;
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** The animation `name` plays with now: `off` under reduced motion or the global switch. */
export function resolveMotion(name: MotionName): { config: MotionConfig; slowdown: number } {
  if (settings.off || prefersReducedMotion()) {
    return { config: { kind: "off" }, slowdown: 1 };
  }
  return {
    config: settings.animations[name] ?? MOTION_DEFAULTS[name],
    slowdown: settings.slowdown,
  };
}
