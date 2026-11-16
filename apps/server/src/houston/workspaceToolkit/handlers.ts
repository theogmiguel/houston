import type * as Effect from "effect/Effect";

import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as Operations from "./operations.ts";
import { WorkspaceToolkit } from "./tools.ts";

const writes = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  McpToolAccess.writesWithCapability(handle);

export const layer = McpToolAccess.toLayer(WorkspaceToolkit, {
  houston_workspace_list: McpToolAccess.reads(() => Operations.list),
  houston_workspace_create: writes(Operations.create),
  houston_workspace_update: writes(Operations.update),
  houston_workspace_reorder: writes(Operations.reorder),
  houston_workspace_delete: writes(Operations.remove),
  houston_workspace_add_thread: writes(Operations.addThread),
  houston_workspace_remove_thread: writes(Operations.removeThreadFrom),
});
