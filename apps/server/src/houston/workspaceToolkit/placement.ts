// Puts threads an agent just launched into the workspace it asked for. A refusal never undoes the
// launch: the thread exists, and the result says why it is not in the workspace.
import type { ThreadId } from "@houston-app/contracts";
import {
  type HoustonGridLaunchTargetAlias,
  type HoustonGridPlacementAlias,
  type HoustonLayoutLaunchTarget,
  type HoustonLayoutPlacement,
  type HoustonLayoutWorkspaceError,
  type HoustonLayoutWorkspaceRecord,
} from "@houston-app/contracts/houston/layoutWorkspaces";
import * as Effect from "effect/Effect";

import { HoustonLayoutWorkspaceService } from "../layoutWorkspaces.ts";
import { chatThreadIdsOf, createWorkspace, placeThread } from "./workspaceChanges.ts";

/** One line naming the refusal, the operation and any limit with the value that tripped it. */
export const workspaceRefusalText = (error: HoustonLayoutWorkspaceError): string => {
  const bound =
    error.limit === undefined || error.actual === undefined
      ? ""
      : ` (limit ${error.limit}, actual ${error.actual})`;
  return `${error.operation} refused as ${error.kind}: ${error.message}${bound}`;
};

/**
 * The target a launch input names. `workspace` wins over its alias `grid`, whose `gridId` is a
 * workspace id and whose `newGridName` names a new workspace.
 */
export const launchTargetOf = (input: {
  readonly workspace?: HoustonLayoutLaunchTarget | undefined;
  readonly grid?: HoustonGridLaunchTargetAlias | undefined;
}): HoustonLayoutLaunchTarget | undefined => {
  if (input.workspace !== undefined) return input.workspace;
  if (input.grid === undefined) return undefined;
  return "gridId" in input.grid
    ? { workspaceId: input.grid.gridId }
    : { newWorkspaceName: input.grid.newGridName };
};

/** `placement` as the grid tools named it. */
export const gridPlacementOf = (placement: HoustonLayoutPlacement): HoustonGridPlacementAlias =>
  placement.placed
    ? { placed: true, gridId: placement.workspaceId }
    : {
        placed: false,
        ...(placement.workspaceId === undefined ? {} : { gridId: placement.workspaceId }),
        error: placement.error,
      };

const unplaced = (error: string, workspaceId?: string): HoustonLayoutPlacement => ({
  placed: false,
  ...(workspaceId === undefined ? {} : { workspaceId }),
  error,
});

/**
 * Places `threadIds` per `target`, one placement per thread in the same order. A named new
 * workspace is made once for the batch. With `replaying`, a thread already open in a workspace is
 * reported there, so a retried launch neither moves it nor makes a second new workspace.
 */
export const placeLaunched = Effect.fn("HoustonWorkspaceToolkit.placeLaunched")(function* (input: {
  readonly environmentId: string;
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly target: HoustonLayoutLaunchTarget;
  readonly replaying: boolean;
}) {
  const workspaces = yield* HoustonLayoutWorkspaceService;
  const place = Effect.gen(function* () {
    const known = input.replaying
      ? yield* workspaces.list
      : ([] as ReadonlyArray<HoustonLayoutWorkspaceRecord>);
    const holding = (threadId: ThreadId) =>
      known.find((workspace) => chatThreadIdsOf(workspace).includes(threadId))?.id;
    const needsWorkspace = input.threadIds.some((threadId) => holding(threadId) === undefined);
    const target = input.target;
    const resolved: { readonly workspaceId: string } | { readonly refused: string } =
      "workspaceId" in target
        ? target
        : !needsWorkspace
          ? { refused: "unused" }
          : yield* createWorkspace({ name: target.newWorkspaceName }).pipe(
              Effect.match({
                onFailure: (error) => ({ refused: workspaceRefusalText(error) }),
                onSuccess: (workspace) => ({ workspaceId: workspace.id }),
              }),
            );
    const placements: HoustonLayoutPlacement[] = [];
    for (const threadId of input.threadIds) {
      const existing = holding(threadId);
      if (existing !== undefined) {
        placements.push({ placed: true, workspaceId: existing });
      } else if ("refused" in resolved) {
        placements.push(unplaced(resolved.refused));
      } else {
        placements.push(
          yield* placeThread({
            workspaceId: resolved.workspaceId,
            threadId,
            environmentId: input.environmentId,
          }).pipe(
            Effect.match({
              onFailure: (error) => unplaced(workspaceRefusalText(error), resolved.workspaceId),
              onSuccess: (): HoustonLayoutPlacement => ({
                placed: true,
                workspaceId: resolved.workspaceId,
              }),
            }),
          ),
        );
      }
    }
    return placements as ReadonlyArray<HoustonLayoutPlacement>;
  });
  return yield* place.pipe(
    Effect.catchTags({
      HoustonLayoutWorkspaceError: (error) =>
        Effect.succeed(input.threadIds.map(() => unplaced(workspaceRefusalText(error)))),
    }),
    Effect.catchCause((cause) =>
      Effect.logError("Houston workspaces: placing a launched thread failed.", cause).pipe(
        Effect.as(
          input.threadIds.map(() =>
            unplaced("The workspace could not be changed; try again later."),
          ),
        ),
      ),
    ),
  );
});

/**
 * The workspace each thread's chat is open in, from one list of every workspace. A read that
 * fails leaves the map empty: a thread read or list still answers, only without its workspace.
 */
export const workspaceIdByThread = Effect.fn("HoustonWorkspaceToolkit.workspaceIdByThread")(
  function* (environmentId: string) {
    const workspaces = yield* HoustonLayoutWorkspaceService;
    const listed = yield* workspaces.list.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "Houston workspaces: listing workspaces for a thread read failed.",
          cause,
        ).pipe(Effect.as([] as ReadonlyArray<HoustonLayoutWorkspaceRecord>)),
      ),
    );
    const byThread = new Map<string, string>();
    for (const workspace of listed) {
      for (const column of workspace.columns)
        for (const pane of column.panes)
          for (const tab of pane.tabs)
            if (
              tab.content.kind === "chat" &&
              tab.content.target.kind === "server" &&
              tab.content.target.threadRef.environmentId === environmentId
            )
              byThread.set(tab.content.target.threadRef.threadId, workspace.id);
    }
    return byThread;
  },
);
