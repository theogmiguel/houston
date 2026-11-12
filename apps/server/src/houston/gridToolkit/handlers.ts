import * as Effect from "effect/Effect";

import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as Operations from "../workspaceToolkit/operations.ts";
import { GridToolkit } from "./tools.ts";

const writes = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  McpToolAccess.writesWithCapability(handle);

const asGrid = <W extends { readonly workspaceId: string }>(workspace: W) => ({
  ...workspace,
  gridId: workspace.workspaceId,
});

/** Each alias maps its input onto the workspace operation of the same name and answers with the workspace's id as `gridId` too. */
export const layer = McpToolAccess.toLayer(GridToolkit, {
  houston_grid_list: McpToolAccess.reads(() =>
    Operations.list.pipe(Effect.map(({ workspaces }) => ({ grids: workspaces.map(asGrid) }))),
  ),
  houston_grid_create: writes((input) =>
    Effect.map(Operations.create({ name: input.name }), asGrid),
  ),
  houston_grid_update: writes((input) =>
    Effect.map(
      Operations.update({
        workspaceId: input.gridId,
        name: input.name,
        hidden: input.hidden,
        pinned: input.pinned,
      }),
      asGrid,
    ),
  ),
  houston_grid_delete: writes((input) => Operations.remove({ workspaceId: input.gridId })),
  houston_grid_place_thread: writes((input) =>
    Effect.map(
      Operations.addThread({ workspaceId: input.gridId, threadId: input.threadId }),
      asGrid,
    ),
  ),
  houston_grid_remove_thread: writes((input) =>
    Effect.map(
      Operations.removeThreadFrom({ workspaceId: input.gridId, threadId: input.threadId }),
      asGrid,
    ),
  ),
});
