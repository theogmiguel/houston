// Deploys and desktop server swaps can invalidate lazy chunks; one reload fetches the fresh index.
const CHUNK_RELOAD_GUARD_KEY = "houston:chunk-load-reloaded";
// Long enough to span a reload and the lazy imports after first paint; short enough that a later
// deploy reloads again.
export const CHUNK_RELOAD_INTERVAL_MS = 30_000;

/** Reloads unless a chunk reload ran in the last interval, so a persistent failure surfaces. */
export function reloadForChunkLoadError(
  getStorage: () => Storage = () => window.sessionStorage,
  reload: () => void = () => window.location.reload(),
  now: () => number = Date.now,
): boolean {
  const time = now();
  try {
    const storage = getStorage();
    const elapsed = time - Number(storage.getItem(CHUNK_RELOAD_GUARD_KEY) ?? Number.NaN);
    if (elapsed >= 0 && elapsed < CHUNK_RELOAD_INTERVAL_MS) return false;
    storage.setItem(CHUNK_RELOAD_GUARD_KEY, String(time));
  } catch {
    // Without storage, the reload guard cannot prevent an infinite loop.
    return false;
  }
  reload();
  return true;
}
