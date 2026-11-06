/**
 * Dev diagnostic: samples frame intervals while any CSS transition or animation runs and
 * logs one record per burst of motion, named by the surfaces that moved. Answers "which
 * animation drops frames, and is it the start (mount cost) or the middle (layout per frame)".
 */

const WHITESPACE_RUN = /\s+/u;

interface MotionEpisode {
  readonly engine: string;
  /** `data-slot` (or tag) of the elements that moved, most frequent first, with counts. */
  readonly surfaces: string;
  readonly properties: string;
  /** Longest declared duration + delay among the motions in the burst. */
  readonly motionMs: number;
  /** From the last pointer or key input to the first motion: render and mount cost. */
  readonly inputToMotionMs: number | null;
  /** From the first motion to the first frame painted after it. */
  readonly firstFrameMs: number;
  readonly frames: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly over33Ms: number;
  /** Each frame over 33 ms as [ms after the motion started, frame length]. */
  readonly longFrames: ReadonlyArray<readonly [number, number]>;
}

declare global {
  interface Window {
    __houstonMotionEpisodes?: MotionEpisode[];
  }
}

/** Only motion that can stutter visibly; colour-only hover fades are noise here. */
const MOVING_PROPERTIES =
  /^(transform|translate|scale|rotate|opacity|width|height|max-height|top|left|right|bottom|grid-template-rows|grid-template-columns|clip-path)$/u;
/** Past this a "transition" is a hack (autofill colour) or a countdown, not a UI motion. */
const MAX_MOTION_MS = 1500;
/** Frames after the declared end still count, so a hitch right at the end is caught. */
const TAIL_MS = 120;
/** An input older than this did not cause the motion. */
const INPUT_WINDOW_MS = 1000;

let lastInputAt: number | null = null;
let episode: {
  start: number;
  until: number;
  surfaces: Map<string, number>;
  properties: Set<string>;
  motionMs: number;
  inputToMotionMs: number | null;
  stamps: number[];
} | null = null;

function engineName(): string {
  return navigator.userAgent.includes("Chrome/") ? "chromium" : "other";
}

function surfaceName(target: EventTarget | null): string {
  if (!(target instanceof Element)) return "?";
  const named = target.closest("[data-slot],[data-grid-cell],[data-testid]");
  if (named instanceof HTMLElement) {
    if (named.dataset.slot !== undefined) return named.dataset.slot;
    if (named.dataset.gridCell !== undefined) return "grid-cell";
    if (named.dataset.testid !== undefined) return `testid:${named.dataset.testid}`;
  }
  const className =
    typeof target.className === "string" ? target.className.split(WHITESPACE_RUN)[0] : "";
  return `${target.tagName.toLowerCase()}${className ? `.${className}` : ""}`;
}

function seconds(value: string): number {
  return Math.max(
    0,
    ...value.split(",").map((part) => {
      const trimmed = part.trim();
      const number = Number.parseFloat(trimmed);
      if (!Number.isFinite(number)) return 0;
      return trimmed.endsWith("ms") ? number : number * 1000;
    }),
  );
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

function report(current: NonNullable<typeof episode>): void {
  const { stamps, start } = current;
  const intervals = stamps.slice(1).map((stamp, index) => stamp - stamps[index]!);
  const sorted = intervals.toSorted((a, b) => a - b);
  const round = (value: number) => Math.round(value * 10) / 10;
  const record: MotionEpisode = {
    engine: engineName(),
    surfaces: [...current.surfaces]
      .toSorted((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([name, count]) => (count > 1 ? `${name}×${count}` : name))
      .join(" "),
    properties: [...current.properties].join(","),
    motionMs: Math.round(current.motionMs),
    inputToMotionMs: current.inputToMotionMs,
    firstFrameMs: Math.round((stamps[0] ?? start) - start),
    frames: intervals.length,
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    maxMs: round(sorted.at(-1) ?? 0),
    over33Ms: intervals.filter((interval) => interval > 33.4).length,
    longFrames: intervals.flatMap((interval, index) =>
      interval > 33.4 ? [[Math.round(stamps[index]! - start), Math.round(interval)] as const] : [],
    ),
  };
  (window.__houstonMotionEpisodes ??= []).push(record);
  console.info("[motion-probe]", JSON.stringify(record));
  void window.hostBridge?.logDebug("motion-probe", "motion frames", record);
}

function tick(now: number): void {
  const current = episode;
  if (current === null) return;
  current.stamps.push(now);
  if (now < current.until) {
    requestAnimationFrame(tick);
    return;
  }
  episode = null;
  report(current);
}

function onMotionStart(event: TransitionEvent | AnimationEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const style = getComputedStyle(target);
  let property: string;
  let motionMs: number;
  if (event instanceof TransitionEvent) {
    property = event.propertyName;
    if (!MOVING_PROPERTIES.test(property)) return;
    motionMs = seconds(style.transitionDuration) + seconds(style.transitionDelay);
  } else {
    if (style.animationIterationCount.includes("infinite")) return;
    property = `@${event.animationName}`;
    motionMs = seconds(style.animationDuration) + seconds(style.animationDelay);
  }
  if (motionMs <= 0 || motionMs > MAX_MOTION_MS) return;
  const now = performance.now();
  if (episode === null) {
    episode = {
      start: now,
      until: now,
      surfaces: new Map(),
      properties: new Set(),
      motionMs: 0,
      inputToMotionMs:
        lastInputAt !== null && now - lastInputAt < INPUT_WINDOW_MS
          ? Math.round(now - lastInputAt)
          : null,
      stamps: [],
    };
    requestAnimationFrame(tick);
  }
  const surface = surfaceName(target);
  episode.surfaces.set(surface, (episode.surfaces.get(surface) ?? 0) + 1);
  episode.properties.add(property);
  episode.motionMs = Math.max(episode.motionMs, now - episode.start + motionMs);
  episode.until = Math.max(episode.until, now + motionMs + TAIL_MS);
}

let installed = false;

/** Starts the probe for the whole document; a second call does nothing. */
export function installMotionProbe(): void {
  if (installed) return;
  installed = true;
  const markInput = () => {
    lastInputAt = performance.now();
  };
  document.addEventListener("pointerdown", markInput, { capture: true, passive: true });
  document.addEventListener("keydown", markInput, { capture: true, passive: true });
  document.addEventListener("transitionrun", onMotionStart, { capture: true, passive: true });
  document.addEventListener("animationstart", onMotionStart, { capture: true, passive: true });
}
