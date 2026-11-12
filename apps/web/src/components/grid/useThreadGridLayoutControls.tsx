import type { ThreadId } from "@houston-app/contracts";
import { preorderThreads } from "@houston-app/shared/grid/tree";

import { useGridStore } from "../../grid/gridStore";
import type { ChatHeaderLayoutControls } from "../ChatView";
import { GridLayoutMenu, GridLayoutMenuItems } from "./GridLayoutMenu";

/** The grid arrangement controls for the header of a thread that a grid shows. */
export function useThreadGridLayoutControls(
  threadId: ThreadId | null,
): ChatHeaderLayoutControls {
  const grid = useGridStore(
    (state) =>
      state.grids.find(
        (entry) =>
          entry.tree !== null &&
          preorderThreads(entry.tree).some((leaf) => leaf.threadId === threadId),
      ) ?? null,
  );
  return {
    control: <GridLayoutMenu grid={grid} />,
    menuItems: <GridLayoutMenuItems grid={grid} />,
  };
}
