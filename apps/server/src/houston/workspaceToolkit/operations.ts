// What each workspace tool does, apart from who may call it. The `houston_workspace_*` tools and
// the `houston_grid_*` aliases both run these, so an alias cannot drift from the tool it names.
import {
  OrchestratorMcpFailure,
  type OrchestratorMcpThreadStatus,
  type ThreadId,
} from "@houston-app/contracts";
import type { HoustonLayoutWorkspaceRecord } from "@houston-app/contracts/houston/layoutWorkspaces";
import * as Effect from "effect/Effect";

import { readCaller, threadNotFound, unavailable } from "../../mcp/threadAccess.ts";
import { HoustonLayoutWorkspaceService } from "../layoutWorkspaces.ts";
import { nowIso } from "../tasks/TaskStore.ts";
import {
  chatThreadIdsOf,
  createWorkspace,
  modifyWorkspace,
  placeThread,
  removeThread,
} from "./workspaceChanges.ts";

export const view = (workspace: HoustonLayoutWorkspaceRecord) => ({
  workspaceId: workspace.id,
  name: workspace.name,
  pinned: workspace.pinnedAt !== null,
  hidden: workspace.hidden,
});

export const summary = (workspace: HoustonLayoutWorkspaceRecord) => ({
  ...view(workspace),
  threadIds: chatThreadIdsOf(workspace),
});

/** Every workspace tool needs a credential that controls threads, as the thread tools do. */
const access = Effect.gen(function* () {
  const context = yield* readCaller();
  return { ...context, workspaces: yield* HoustonLayoutWorkspaceService };
});

export const list = Effect.gen(function* () {
  const { threads, workspaces } = yield* access;
  const listed = yield* workspaces.list;
  const held = listed.some((workspace) => workspace.columns.length > 0);
  const shells = held
    ? yield* threads
        .listProjectThreads({ projectId: undefined, includeSubagents: true })
        .pipe(Effect.mapError(unavailable))
    : [];
  const byId = new Map(shells.map((shell) => [shell.id as string, shell]));
  return {
    workspaces: listed.map((workspace) => ({
      ...view(workspace),
      threads: chatThreadIdsOf(workspace).map((threadId) => {
        const shell = byId.get(threadId);
        return {
          threadId,
          title: shell?.title ?? null,
          status: (shell === undefined
            ? null
            : (shell.activityRunStatus ?? shell.status)) as OrchestratorMcpThreadStatus | null,
        };
      }),
    })),
  };
});

export const create = (input: { readonly name?: string | undefined }) =>
  access.pipe(Effect.andThen(createWorkspace(input)), Effect.map(summary));

export const update = Effect.fn("HoustonWorkspaceToolkit.update")(function* (input: {
  readonly workspaceId: string;
  readonly name?: string | undefined;
  readonly hidden?: boolean | undefined;
  readonly pinned?: boolean | undefined;
}) {
  yield* access;
  if (input.name === undefined && input.hidden === undefined && input.pinned === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: `Pass at least one of name, hidden or pinned to change workspace ${input.workspaceId}.`,
    });
  }
  const now = yield* nowIso;
  return summary(
    yield* modifyWorkspace("houston.layoutWorkspaces.update", input.workspaceId, (workspace) =>
      Effect.succeed({
        ...workspace,
        name: input.name ?? workspace.name,
        hidden: input.hidden ?? workspace.hidden,
        pinnedAt:
          input.pinned === undefined
            ? workspace.pinnedAt
            : input.pinned
              ? (workspace.pinnedAt ?? now)
              : null,
      }),
    ),
  );
});

export const reorder = Effect.fn("HoustonWorkspaceToolkit.reorder")(function* (input: {
  readonly workspaceIds: ReadonlyArray<string>;
}) {
  const { workspaces } = yield* access;
  return { workspaces: (yield* workspaces.reorder(input)).map(summary) };
});

export const remove = Effect.fn("HoustonWorkspaceToolkit.remove")(function* (input: {
  readonly workspaceId: string;
}) {
  const { workspaces } = yield* access;
  return yield* workspaces.delete(input);
});

export const addThread = Effect.fn("HoustonWorkspaceToolkit.addThread")(function* (input: {
  readonly workspaceId: string;
  readonly threadId: ThreadId;
}) {
  const { scope, threads } = yield* access;
  const shell = yield* threads
    .getThreadShell(input.threadId)
    .pipe(Effect.orElseSucceed(() => null));
  if (shell === null || shell.deletedAt !== null) {
    return yield* threadNotFound(
      threads,
      input.threadId,
      `Thread ${input.threadId} was not found; pass a thread id from \`houston_thread_list\`.`,
    );
  }
  return summary(yield* placeThread({ ...input, environmentId: scope.environmentId }));
});

export const removeThreadFrom = Effect.fn("HoustonWorkspaceToolkit.removeThreadFrom")(
  function* (input: { readonly workspaceId: string; readonly threadId: ThreadId }) {
    const { scope } = yield* access;
    return summary(yield* removeThread({ ...input, environmentId: scope.environmentId }));
  },
);
