/**
 * A layout resize in progress: terminal and browser surfaces wait for the
 * release instead of refitting on every pointer move, then fit once.
 */
let active = 0;
const listeners = new Set<() => void>();

export function beginLayoutResize(): void {
  active += 1;
}

export function endLayoutResize(): void {
  if (active === 0) return;
  active -= 1;
  if (active > 0) return;
  for (const listener of listeners) listener();
}

export function isLayoutResizing(): boolean {
  return active > 0;
}

/** Runs `listener` once the last resize in progress ends. */
export function onLayoutResizeEnd(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam: a dropped pointer must not leave the surfaces waiting forever. */
export function resetLayoutResizeForTest(): void {
  active = 0;
}
