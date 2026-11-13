// A busy start-up still fetches the chunk this long after first paint, so the first open of
// a rarely used surface does not wait on the network or the disk.
const PRELOAD_MAX_WAIT_MS = 3_000;

/** Starts `load` once the window is idle; returns the cancel for an effect cleanup. */
export function preloadWhenIdle(load: () => Promise<unknown>): () => void {
  const run = () => void load().catch(() => {});
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(run, { timeout: PRELOAD_MAX_WAIT_MS });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(run, PRELOAD_MAX_WAIT_MS);
  return () => window.clearTimeout(handle);
}
