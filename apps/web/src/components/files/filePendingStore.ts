import { create } from "zustand";

const EMPTY: ReadonlySet<string> = new Set();

/**
 * File tabs whose content is still loading, per project workspace. A file tab renders its own
 * panel while the tab strip shows its pending state, so the two share this store.
 */
export const useFilePendingStore = create<{
  byProjectKey: ReadonlyMap<string, ReadonlySet<string>>;
}>(() => ({ byProjectKey: new Map() }));

export function selectPendingFileSurfaceIds(
  byProjectKey: ReadonlyMap<string, ReadonlySet<string>>,
  projectKey: string | null,
): ReadonlySet<string> {
  return projectKey === null ? EMPTY : (byProjectKey.get(projectKey) ?? EMPTY);
}

export function setFileSurfacePending(
  projectKey: string,
  relativePath: string,
  pending: boolean,
): void {
  useFilePendingStore.setState((state) => {
    const current = state.byProjectKey.get(projectKey) ?? EMPTY;
    const surfaceId = `file:${relativePath}`;
    if (current.has(surfaceId) === pending) return state;
    const next = new Set(current);
    if (pending) next.add(surfaceId);
    else next.delete(surfaceId);
    const byProjectKey = new Map(state.byProjectKey);
    if (next.size === 0) byProjectKey.delete(projectKey);
    else byProjectKey.set(projectKey, next);
    return { byProjectKey };
  });
}
