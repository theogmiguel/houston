// Grid tools for agents: list, create, update, delete and place threads. They call the grid
// service the renderer uses, so a change made here shows in the app the moment it opens.
import {
  OrchestratorMcpFailure,
  OrchestratorMcpThreadStatus,
  ProjectId,
  ThreadId,
} from "@houston-app/contracts";
import { HOUSTON_GRID_LIMITS, HoustonGridError } from "@houston-app/contracts/houston/grids";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { HoustonGridService } from "../grids.ts";

const shared = {
  failure: Schema.Union([HoustonGridError, OrchestratorMcpFailure]),
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    HoustonGridService,
  ],
};

const gridId = Schema.String.check(Schema.isNonEmpty()).annotate({
  description: "A grid id, from `houston_grid_list` or `houston_grid_create`.",
});
const name = Schema.String.check(Schema.isMaxLength(HOUSTON_GRID_LIMITS.nameChars));
const projectId = Schema.optional(
  ProjectId.annotate({ description: "Default: your thread's project. Required outside a thread." }),
);

const GridFields = {
  gridId: Schema.String,
  projectId: Schema.String,
  name: Schema.String,
  pinned: Schema.Boolean,
  hidden: Schema.Boolean,
};
/** A grid with its thread ids in pane order. */
const Grid = Schema.Struct({ ...GridFields, threadIds: Schema.Array(Schema.String) });

const GridListTool = Tool.make("houston_grid_list", {
  ...shared,
  description:
    "List grids with their threads in pane order. `projectId`: one project, else yours, else all outside a thread. A thread's title and status are null when it is archived.",
  parameters: Schema.Struct({ projectId }),
  success: Schema.Struct({
    grids: Schema.Array(
      Schema.Struct({
        ...GridFields,
        threads: Schema.Array(
          Schema.Struct({
            threadId: Schema.String,
            title: Schema.NullOr(Schema.String),
            status: Schema.NullOr(OrchestratorMcpThreadStatus),
          }),
        ),
      }),
    ),
  }),
})
  .annotate(Tool.Title, "List grids")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const GridCreateTool = Tool.make("houston_grid_create", {
  ...shared,
  description: "Create an empty grid. `name` defaults to the next 'Grid N'. Returns its `gridId`.",
  parameters: Schema.Struct({ projectId, name: Schema.optional(name) }),
  success: Grid,
})
  .annotate(Tool.Title, "Create a grid")
  .annotate(Tool.Destructive, false);

const GridUpdateTool = Tool.make("houston_grid_update", {
  ...shared,
  description: "Rename, hide or pin a grid. Omitted fields are unchanged.",
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
  description: "Delete a grid. Its threads stay.",
  parameters: Schema.Struct({ gridId }),
  success: Schema.Struct({ deleted: Schema.Boolean }),
})
  .annotate(Tool.Title, "Delete a grid")
  .annotate(Tool.Destructive, true);

const GridPlaceThreadTool = Tool.make("houston_grid_place_thread", {
  ...shared,
  description: `Add a thread to the end of a grid, moving it out of its other grid. Same project only; a grid holds at most ${HOUSTON_GRID_LIMITS.threads} threads.`,
  parameters: Schema.Struct({ gridId, threadId: ThreadId }),
  success: Grid,
})
  .annotate(Tool.Title, "Place a thread in a grid")
  .annotate(Tool.Destructive, false);

const GridRemoveThreadTool = Tool.make("houston_grid_remove_thread", {
  ...shared,
  description: "Take a thread out of a grid. The thread stays.",
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
