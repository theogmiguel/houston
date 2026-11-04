/** Temporary diagnostic: samples frame intervals while grid cells animate. */

interface FrameStats {
  readonly engine: string;
  readonly kind: string;
  readonly cells: number;
  readonly motionMs: number;
  readonly firstFrameMs: number;
  readonly frames: number;
  readonly fps: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly over33Ms: number;
  /** Each frame over 33 ms as [ms after the move started, frame length]. */
  readonly longFrames: ReadonlyArray<readonly [number, number]>;
}

declare global {
  interface Window {
    __houstonFrameStats?: FrameStats[];
    __TAURI_INTERNALS__?: { invoke: (command: string, args: unknown) => Promise<unknown> };
  }
}

let active = false;

function engineName(): string {
  if (window.__TAURI_INTERNALS__ !== undefined) return "tauri-webkitgtk";
  const ua = navigator.userAgent;
  if (ua.includes("Chrome/")) return "chromium";
  if (ua.includes("Firefox/")) return "firefox";
  return "other";
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

export function probeCellMoveFrames(cells: number, motionMs: number, kind = "move"): void {
  if (active || cells === 0) return;
  active = true;
  const start = performance.now();
  const stamps: number[] = [];
  const until = start + motionMs + 150;
  const tick = (now: number) => {
    stamps.push(now);
    if (now < until) {
      requestAnimationFrame(tick);
      return;
    }
    active = false;
    const intervals = stamps.slice(1).map((stamp, index) => stamp - stamps[index]!);
    const sorted = [...intervals].toSorted((a, b) => a - b);
    const elapsed = (stamps.at(-1) ?? start) - (stamps[0] ?? start);
    const stats: FrameStats = {
      engine: engineName(),
      kind,
      cells,
      motionMs: Math.round(motionMs),
      firstFrameMs: Math.round((stamps[0] ?? start) - start),
      frames: intervals.length,
      fps: elapsed > 0 ? Math.round((intervals.length / elapsed) * 1000) : 0,
      p50Ms: Math.round(percentile(sorted, 0.5) * 10) / 10,
      p95Ms: Math.round(percentile(sorted, 0.95) * 10) / 10,
      maxMs: Math.round((sorted.at(-1) ?? 0) * 10) / 10,
      over33Ms: intervals.filter((interval) => interval > 33.4).length,
      longFrames: intervals.flatMap((interval, index) =>
        interval > 33.4
          ? [[Math.round(stamps[index]! - start), Math.round(interval)] as const]
          : [],
      ),
    };
    (window.__houstonFrameStats ??= []).push(stats);
    console.info("[frame-probe]", JSON.stringify(stats));
    void window.__TAURI_INTERNALS__?.invoke("system_log_debug", {
      source: "frame-probe",
      message: "grid cell move frames",
      payload: stats,
    });
  };
  requestAnimationFrame(tick);
}
