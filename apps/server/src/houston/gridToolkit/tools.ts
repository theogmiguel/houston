// The former grid tools, kept as aliases of the workspace tools for one release. A `gridId` is a
// workspace id, and a `projectId` is accepted and ignored because a workspace has no project.
import { ThreadId } from "@houston-app/contracts";
import { HOUSTON_LAYOUT_WORKSPACE_LIMITS } from "@houston-app/contracts/houston/layoutWorkspaces";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import {
  WorkspaceFields,
  WorkspaceThreadEntries,
  workspaceToolShared,
} from "../workspaceToolkit/tools.ts";

const shared = workspaceToolShared;

const gridId = Schema.String.check(Schema.isNonEmpty()).annotate({
  description: "A workspace id.",
});
const name = Schema.String.check(Schema.isMaxLength(HOUSTON_LAYOUT_WORKSPACE_LIMITS.nameChars));
const projectId = Schema.optional(
  Schema.String.annotate({ description: "Accepted and ignored: a workspace has no project." }),
);

/** A workspace as the grid tools answered, with its id also as `gridId`. */
const GridFields = { ...WorkspaceFields, gridId: Schema.String };
const Grid = Schema.Struct({ ...GridFields, threadIds: Schema.Array(Schema.String) });

const aliasOf = (tool: string) => `Alias of \`${tool}\`; will be removed.`;

const GridListTool = Tool.make("houston_grid_list", {
  ...shared,
  description: `${aliasOf("houston_workspace_list")} \`projectId\` is ignored.`,
  parameters: Schema.Struct({ projectId }),
  success: Schema.Struct({
    grids: Schema.Array(Schema.Struct({ ...GridFields, threads: WorkspaceThreadEntries })),
  }),
})
  .annotate(Tool.Title, "List grids")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const GridCreateTool = Tool.make("houston_grid_create", {
  ...shared,
  description: `${aliasOf("houston_workspace_create")} \`projectId\` is ignored.`,
  parameters: Schema.Struct({ projectId, name: Schema.optional(name) }),
  success: Grid,
})
  .annotate(Tool.Title, "Create a grid")
  .annotate(Tool.Destructive, false);

const GridUpdateTool = Tool.make("houston_grid_update", {
  ...shared,
  description: aliasOf("houston_workspace_update"),
  parameters: Schema.Struct({
    gridId,
    name: Schema.optional(name),
    hidden: Schema.optional(Schema.Boolean),
    pinned: Schema.optional(Schema.Boolean),
  }),
  success: Grid,
})
  .annotate(Tool.Title, "Update a grid")
  .annotate(Tool.Destructive, false);

const GridDeleteTool = Tool.make("houston_grid_delete", {
  ...shared,
  description: aliasOf("houston_workspace_delete"),
  parameters: Schema.Struct({ gridId }),
  success: Schema.Struct({ deleted: Schema.Boolean }),
})
  .annotate(Tool.Title, "Delete a grid")
  .annotate(Tool.Destructive, true);

const GridPlaceThreadTool = Tool.make("houston_grid_place_thread", {
  ...shared,
  description: aliasOf("houston_workspace_add_thread"),
  parameters: Schema.Struct({ gridId, threadId: ThreadId }),
  success: Grid,
})
  .annotate(Tool.Title, "Place a thread in a grid")
  .annotate(Tool.Destructive, false);

const GridRemoveThreadTool = Tool.make("houston_grid_remove_thread", {
  ...shared,
  description: aliasOf("houston_workspace_remove_thread"),
  parameters: Schema.Struct({ gridId, threadId: ThreadId }),
  success: Grid,
})
  .annotate(Tool.Title, "Remove a thread from a grid")
  .annotate(Tool.Destructive, true);

export const GridToolkit = Toolkit.make(
  GridListTool,
  GridCreateTool,
  GridUpdateTool,
  GridDeleteTool,
  GridPlaceThreadTool,
  GridRemoveThreadTool,
);
