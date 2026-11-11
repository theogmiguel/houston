import { useEffect } from "react";
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

/**
 * A grid shows its cells again once it is left. Clearing on the way out, not on the way back,
 * means a returning grid never paints its solo cell first and then replays the restore.
 */
export function useLeaveGridMaximize(gridId: string): void {
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- leaving a grid must not leave a cell of it maximized
  useEffect(
    () => () => useGridMaximizeStore.getState().setMaximizedThreadId(gridId, null),
    [gridId],
  );
}
