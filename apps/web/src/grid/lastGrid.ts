import { resolveStorage } from "../lib/storage";

const LAST_OPEN_GRID_KEY = "houston:last-open-grid:v1";

function storage() {
  return resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);
}

/** The grid last shown, restored on launch instead of landing on a fresh draft. */
export function readLastOpenGridId(): string | null {
  try {
    const value = storage().getItem(LAST_OPEN_GRID_KEY);
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function rememberLastOpenGridId(gridId: string): void {
  try {
    storage().setItem(LAST_OPEN_GRID_KEY, gridId);
  } catch {
    // A full or blocked storage only costs the launch restore.
  }
}
