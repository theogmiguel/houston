/** Gesture pieces from niri: turn a delta stream into a velocity and a projected end, and
 * rubber-band past the last stop. The grid's resize and drag do not use them yet; the module
 * carries the behaviour the layout model of a future slice depends on. */

/** Deltas older than this no longer count toward the velocity. */
const HISTORY_LIMIT_MS = 150;
/** libinput's touchpad deceleration per ms; the projection assumes it. */
const DECELERATION_TOUCHPAD = 0.997;

export class SwipeTracker {
  private history: { delta: number; time: number }[] = [];
  /** Summed travel since the gesture began. */
  pos = 0;

  push(delta: number, time: number): void {
    const last = this.history.at(-1);
    if (last && time < last.time) return;
    this.history.push({ delta, time });
    this.pos += delta;
    while (this.history.length > 0 && time > this.history[0]!.time + HISTORY_LIMIT_MS) {
      this.history.shift();
    }
  }

  /** Travel per second over the last 150ms. */
  velocity(): number {
    const first = this.history[0];
    const last = this.history.at(-1);
    if (!first || !last || last.time === first.time) return 0;
    const total = this.history.reduce((sum, event) => sum + event.delta, 0);
    return (total / (last.time - first.time)) * 1000;
  }

  /** Where the travel would coast to: about a third of a second at this velocity. */
  projectedEndPos(): number {
    return this.pos - this.velocity() / (1000 * Math.log(DECELERATION_TOUCHPAD));
  }
}

/** niri's rubber band: slope `stiffness` at the edge, never past `limit`. */
export interface RubberBand {
  readonly stiffness: number;
  readonly limit: number;
}

/** Past the first or last stop: 0.1 of overpull shows 0.025, at most 0.05. */
export const STOP_RUBBER_BAND: RubberBand = { stiffness: 0.5, limit: 0.05 };

function band({ stiffness: c, limit: d }: RubberBand, x: number): number {
  return (1 - 1 / ((x * c) / d + 1)) * d;
}

export function rubberBandClamp(rubber: RubberBand, min: number, max: number, x: number): number {
  const clamped = Math.min(max, Math.max(min, x));
  return clamped + Math.sign(x - clamped) * band(rubber, Math.abs(x - clamped));
}

/** How much of a velocity survives the band at `x`, for the release spring. */
export function rubberBandClampDerivative(
  rubber: RubberBand,
  min: number,
  max: number,
  x: number,
): number {
  if (min <= x && x <= max) return 1;
  const diff = Math.abs(x - Math.min(max, Math.max(min, x)));
  const { stiffness: c, limit: d } = rubber;
  return (c * d * d) / (c * diff + d) ** 2;
}
