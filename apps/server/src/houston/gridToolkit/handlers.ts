import { OrchestratorMcpFailure, type ProjectId } from "@houston-app/contracts";
import type { HoustonGridRecord } from "@houston-app/contracts/houston/grids";
import * as Effect from "effect/Effect";

import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { readCaller, resolveProjectId, unavailable } from "../../mcp/threadAccess.ts";
import { HoustonGridService } from "../grids.ts";
import { threadIdsOf } from "./placement.ts";
import { GridToolkit } from "./tools.ts";

const view = (grid: HoustonGridRecord) => ({
  gridId: grid.id,
  projectId: grid.projectId,
  name: grid.name,
  pinned: grid.pinnedAt !== null,
  hidden: grid.hidden,
});

const summary = (grid: HoustonGridRecord) => ({ ...view(grid), threadIds: threadIdsOf(grid) });

/** Every grid tool needs a credential that controls threads, as the thread tools do. */
const access = Effect.gen(function* () {
  const context = yield* readCaller();
  return { ...context, grids: yield* HoustonGridService };
});

const writes = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  McpToolAccess.writesWithCapability(handle);

export const layer = McpToolAccess.toLayer(GridToolkit, {
  houston_grid_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { caller, threads, grids } = yield* access;
      const projectId: ProjectId | undefined = input.projectId ?? caller?.projectId;
      const listed = yield* grids.list(projectId === undefined ? {} : { projectId });
      const held = listed.some((grid) => grid.tree !== null);
      const shells = held
        ? yield* threads
            .listProjectThreads({ projectId, includeSubagents: true })
            .pipe(Effect.mapError(unavailable))
        : [];
      const byId = new Map(shells.map((shell) => [shell.id as string, shell]));
      return {
        grids: listed.map((grid) => ({
          ...view(grid),
          threads: threadIdsOf(grid).map((threadId) => {
            const shell = byId.get(threadId);
            return {
              threadId,
              title: shell?.title ?? null,
              status: shell === undefined ? null : (shell.activityRunStatus ?? shell.status),
            };
          }),
        })),
      };
    }),
  ),
  houston_grid_create: writes((input) =>
    Effect.gen(function* () {
      const context = yield* access;
      const projectId = yield* resolveProjectId(context, input.projectId);
      return summary(
        yield* context.grids.create({
          projectId,
          ...(input.name === undefined ? {} : { name: input.name }),
        }),
      );
    }),
  ),
  houston_grid_update: writes((input) =>
    Effect.gen(function* () {
      const { grids } = yield* access;
      if (input.name === undefined && input.hidden === undefined && input.pinned === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `Pass at least one of name, hidden or pinned to change grid ${input.gridId}.`,
        });
      let grid = yield* grids.get(input.gridId);
      if (input.name !== undefined)
        grid = yield* grids.rename({ gridId: input.gridId, name: input.name });
      if (input.hidden !== undefined)
        grid = yield* grids.setHidden({ gridId: input.gridId, hidden: input.hidden });
      if (input.pinned !== undefined)
        grid = yield* grids.setPinned({ gridId: input.gridId, pinned: input.pinned });
      return summary(grid);
    }),
  ),
  houston_grid_delete: writes((input) =>
    Effect.gen(function* () {
      const { grids } = yield* access;
      return yield* grids.delete({ gridId: input.gridId });
    }),
  ),
  houston_grid_place_thread: writes((input) =>
    Effect.gen(function* () {
      const { grids } = yield* access;
      return summary(yield* grids.placeThread(input));
    }),
  ),
  houston_grid_remove_thread: writes((input) =>
    Effect.gen(function* () {
      const { grids } = yield* access;
      return summary(yield* grids.removeThread(input));
    }),
  ),
});
