import { create } from "zustand";

export interface GridMaximizeState {
  readonly maximizedThreadIdByGrid: Readonly<Record<string, string | null>>;
  setMaximizedThreadId: (gridId: string, threadId: string | null) => void;
}

/**
 * Which cell each grid shows alone. It is renderer-only view state, so it lives
 * outside the persisted grid store and resets with the session.
 */
export const useGridMaximizeStore = create<GridMaximizeState>()((set) => ({
  maximizedThreadIdByGrid: {},
  setMaximizedThreadId: (gridId, threadId) =>
    set((state) => {
      if ((state.maximizedThreadIdByGrid[gridId] ?? null) === threadId) return state;
      const next = { ...state.maximizedThreadIdByGrid };
      if (threadId === null) delete next[gridId];
      else next[gridId] = threadId;
      return { maximizedThreadIdByGrid: next };
    }),
}));
