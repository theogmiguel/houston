// Workspace tools for agents: list, create, update, reorder, delete, and add or remove threads.
// They call the layout workspace service the renderer uses, so a change made here shows in the
// app the moment it opens.
import {
  OrchestratorMcpFailure,
  OrchestratorMcpThreadStatus,
  ThreadId,
} from "@houston-app/contracts";
import {
  HOUSTON_LAYOUT_WORKSPACE_LIMITS,
  HoustonLayoutWorkspaceError,
} from "@houston-app/contracts/houston/layoutWorkspaces";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { HoustonLayoutWorkspaceService } from "../layoutWorkspaces.ts";

export const workspaceToolShared = {
  failure: Schema.Union([HoustonLayoutWorkspaceError, OrchestratorMcpFailure]),
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    HoustonLayoutWorkspaceService,
    SecureRandom.SecureRandom,
  ],
};

const shared = workspaceToolShared;

const workspaceId = Schema.String.check(Schema.isNonEmpty()).annotate({
  description: "From `houston_workspace_list`.",
});
const name = Schema.String.check(Schema.isMaxLength(HOUSTON_LAYOUT_WORKSPACE_LIMITS.nameChars));

export const WorkspaceFields = {
  workspaceId: Schema.String,
  name: Schema.String,
  pinned: Schema.Boolean,
  hidden: Schema.Boolean,
};
/** A workspace with the ids of the threads whose chat is open in it, in column, pane and tab order. */
export const Workspace = Schema.Struct({
  ...WorkspaceFields,
  threadIds: Schema.Array(Schema.String),
});

export const WorkspaceThreadEntries = Schema.Array(
  Schema.Struct({
    threadId: Schema.String,
    title: Schema.NullOr(Schema.String),
    status: Schema.NullOr(OrchestratorMcpThreadStatus),
  }),
);

const WorkspaceListTool = Tool.make("houston_workspace_list", {
  ...shared,
  description:
    "List workspaces in display order with the threads open in each. A workspace holds threads of any project. A thread's title and status are null when it is archived.",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({
    workspaces: Schema.Array(
      Schema.Struct({ ...WorkspaceFields, threads: WorkspaceThreadEntries }),
    ),
  }),
})
  .annotate(Tool.Title, "List workspaces")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const WorkspaceCreateTool = Tool.make("houston_workspace_create", {
  ...shared,
  description:
    "Create an empty workspace after the others. `name` defaults to the next 'Workspace N'. Returns its `workspaceId`.",
  parameters: Schema.Struct({ name: Schema.optional(name) }),
  success: Workspace,
})
  .annotate(Tool.Title, "Create a workspace")
  .annotate(Tool.Destructive, false);

const WorkspaceUpdateTool = Tool.make("houston_workspace_update", {
  ...shared,
  description: "Rename, hide or pin a workspace. Omitted fields are unchanged.",
  parameters: Schema.Struct({
    workspaceId,
    name: Schema.optional(name),
    hidden: Schema.optional(Schema.Boolean),
    pinned: Schema.optional(Schema.Boolean),
  }),
  success: Workspace,
})
  .annotate(Tool.Title, "Update a workspace")
  .annotate(Tool.Destructive, false);

const WorkspaceReorderTool = Tool.make("houston_workspace_reorder", {
  ...shared,
  description:
    "Set the display order. `workspaceIds` lists every workspace once, in the new order.",
  parameters: Schema.Struct({
    workspaceIds: Schema.Array(workspaceId).check(
      Schema.isMaxLength(HOUSTON_LAYOUT_WORKSPACE_LIMITS.workspaces),
    ),
  }),
  success: Schema.Struct({ workspaces: Schema.Array(Workspace) }),
})
  .annotate(Tool.Title, "Reorder workspaces")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const WorkspaceDeleteTool = Tool.make("houston_workspace_delete", {
  ...shared,
  description:
    "Delete a workspace. Its threads stay: their chat tabs move to the end of the last pane of the first remaining workspace. Its other tabs (surfaces, launchers, pages) close with it. The only workspace cannot be deleted.",
  parameters: Schema.Struct({ workspaceId }),
  success: Schema.Struct({ deleted: Schema.Boolean }),
})
  .annotate(Tool.Title, "Delete a workspace")
  .annotate(Tool.Destructive, true);

const WorkspaceAddThreadTool = Tool.make("houston_workspace_add_thread", {
  ...shared,
  description: `Open a thread's chat in a workspace, as a new tab at the end of its last pane. A thread's chat is in one workspace at a time, so adding it moves it out of its other workspace. A workspace holds up to ${HOUSTON_LAYOUT_WORKSPACE_LIMITS.tabsPerPane} tabs per pane and ${HOUSTON_LAYOUT_WORKSPACE_LIMITS.tabsPerWorkspace} in all.`,
  parameters: Schema.Struct({ workspaceId, threadId: ThreadId }),
  success: Workspace,
})
  .annotate(Tool.Title, "Add a thread to a workspace")
  .annotate(Tool.Destructive, false);

const WorkspaceRemoveThreadTool = Tool.make("houston_workspace_remove_thread", {
  ...shared,
  description:
    "Close a thread's chat tab in a workspace. The thread stays; its other tabs stay, and a thread open nowhere shows in the first workspace.",
  parameters: Schema.Struct({ workspaceId, threadId: ThreadId }),
  success: Workspace,
})
  .annotate(Tool.Title, "Remove a thread from a workspace")
  .annotate(Tool.Destructive, true);

export const WorkspaceToolkit = Toolkit.make(
  WorkspaceListTool,
  WorkspaceCreateTool,
  WorkspaceUpdateTool,
  WorkspaceReorderTool,
  WorkspaceDeleteTool,
  WorkspaceAddThreadTool,
  WorkspaceRemoveThreadTool,
);
