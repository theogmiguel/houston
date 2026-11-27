import { scopedThreadKey } from "@houston-app/client-runtime/environment";
import type { ScopedThreadRef } from "@houston-app/contracts";
import { create } from "zustand";

export interface ActiveRepositoryStoreState {
  /** The repository a thread's changes and git actions share; null shows every repository. */
  byThreadKey: Record<string, string | null>;
  setActiveRepository: (ref: ScopedThreadRef, repositoryKey: string | null) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

export const useActiveRepositoryStore = create<ActiveRepositoryStoreState>()((set) => ({
  byThreadKey: {},
  setActiveRepository: (ref, repositoryKey) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      if (state.byThreadKey[threadKey] === repositoryKey) return state;
      return { byThreadKey: { ...state.byThreadKey, [threadKey]: repositoryKey } };
    }),
  removeThread: (ref) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      if (!(threadKey in state.byThreadKey)) return state;
      const { [threadKey]: _removed, ...byThreadKey } = state.byThreadKey;
      return { byThreadKey };
    }),
}));

export function selectActiveRepositoryKey(
  state: Pick<ActiveRepositoryStoreState, "byThreadKey">,
  ref: ScopedThreadRef | null | undefined,
): string | null {
  return ref ? (state.byThreadKey[scopedThreadKey(ref)] ?? null) : null;
}
