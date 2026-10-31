import { useNavigate } from "@tanstack/react-router";

import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useStableCallback } from "../hooks/useStableCallback";
import { gridById, useGridStore } from "./gridStore";
import { openGridDraft, type GridDraftOptions, type OpenedGridDraft } from "./newThreadDraft";

/** Opens a draft pane in a grid and keeps the grid route showing it. */
export function useOpenGridDraft(): (input: GridDraftOptions) => Promise<OpenedGridDraft | null> {
  const navigate = useNavigate();
  const handleNewThread = useNewThreadHandler();
  return useStableCallback(async (input: GridDraftOptions) => {
    const opened = await openGridDraft(input, handleNewThread);
    if (opened !== null) {
      await navigate({ to: "/grid/$gridId", params: { gridId: opened.gridId } });
      if (gridById(useGridStore.getState().grids, opened.gridId)?.tree === null) {
        window.requestAnimationFrame(() => {
          document
            .querySelector<HTMLElement>(
              '[data-grid-empty-draft] [contenteditable="true"], [data-grid-empty-draft] textarea',
            )
            ?.focus();
        });
      }
    }
    return opened;
  });
}
