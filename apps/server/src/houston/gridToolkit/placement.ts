// Puts threads an agent just launched into the grid it asked for. A refusal never undoes the
// launch: the thread exists, and the result says why it is not in the grid.
import type { ProjectId, ThreadId } from "@houston-app/contracts";
import {
  type HoustonGridError,
  type HoustonGridLaunchTarget,
  type HoustonGridPlacement,
  type HoustonGridRecord,
} from "@houston-app/contracts/houston/grids";
import { preorderThreads } from "@houston-app/shared/grid/tree";
import * as Effect from "effect/Effect";

import { HoustonGridService } from "../grids.ts";

export const threadIdsOf = (grid: Pick<HoustonGridRecord, "tree">): ReadonlyArray<string> =>
  preorderThreads(grid.tree).map((leaf) => leaf.threadId);

/** One line naming the refusal, the grid operation and any limit with the value that tripped it. */
export const gridRefusalText = (error: HoustonGridError): string => {
  const bound =
    error.limit === undefined || error.actual === undefined
      ? ""
      : ` (limit ${error.limit}, actual ${error.actual})`;
  return `${error.operation} refused as ${error.kind}: ${error.message}${bound}`;
};

const unplaced = (error: string, gridId?: string): HoustonGridPlacement => ({
  placed: false,
  ...(gridId === undefined ? {} : { gridId }),
  error,
});

/**
 * Places `threadIds` of `projectId` per `target`, one placement per thread in the same order. A
 * named new grid is made once for the batch. With `replaying`, a thread already in a grid is
 * reported there, so a retried launch neither moves it nor makes a second new grid.
 */
export const placeLaunched = Effect.fn("HoustonGridToolkit.placeLaunched")(function* (input: {
  readonly projectId: ProjectId;
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly target: HoustonGridLaunchTarget;
  readonly replaying: boolean;
}) {
  const grids = yield* HoustonGridService;
  const place = Effect.gen(function* () {
    const known = input.replaying
      ? yield* grids.list({ projectId: input.projectId })
      : ([] as ReadonlyArray<HoustonGridRecord>);
    const holding = (threadId: ThreadId) =>
      known.find((grid) => threadIdsOf(grid).includes(threadId))?.id;
    const needsGrid = input.threadIds.some((threadId) => holding(threadId) === undefined);
    const target = input.target;
    const resolved: { readonly gridId: string } | { readonly refused: string } =
      "gridId" in target
        ? target
        : !needsGrid
          ? { refused: "unused" }
          : yield* grids.create({ projectId: input.projectId, name: target.newGridName }).pipe(
              Effect.match({
                onFailure: (error) => ({ refused: gridRefusalText(error) }),
                onSuccess: (grid) => ({ gridId: grid.id }),
              }),
            );
    const placements: HoustonGridPlacement[] = [];
    for (const threadId of input.threadIds) {
      const existing = holding(threadId);
      if (existing !== undefined) {
        placements.push({ placed: true, gridId: existing });
      } else if ("refused" in resolved) {
        placements.push(unplaced(resolved.refused));
      } else {
        placements.push(
          yield* grids.placeThread({ gridId: resolved.gridId, threadId }).pipe(
            Effect.match({
              onFailure: (error) => unplaced(gridRefusalText(error), resolved.gridId),
              onSuccess: (): HoustonGridPlacement => ({ placed: true, gridId: resolved.gridId }),
            }),
          ),
        );
      }
    }
    return placements as ReadonlyArray<HoustonGridPlacement>;
  });
  return yield* place.pipe(
    Effect.catchTags({
      HoustonGridError: (error) =>
        Effect.succeed(input.threadIds.map(() => unplaced(gridRefusalText(error)))),
    }),
    Effect.catchCause((cause) =>
      Effect.logError("Houston grids: placing a launched thread failed.", cause).pipe(
        Effect.as(
          input.threadIds.map(() => unplaced("The grid could not be changed; try again later.")),
        ),
      ),
    ),
  );
});

/**
 * The grid each thread is in, from one list of every grid. A grid read that fails leaves the
 * map empty: a thread read or list still answers, only without its grid.
 */
export const gridIdByThread = Effect.gen(function* () {
  const grids = yield* HoustonGridService;
  const listed = yield* grids
    .list({})
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Houston grids: listing grids for a thread read failed.", cause).pipe(
          Effect.as([] as ReadonlyArray<HoustonGridRecord>),
        ),
      ),
    );
  const byThread = new Map<string, string>();
  for (const grid of listed)
    for (const threadId of threadIdsOf(grid)) byThread.set(threadId, grid.id);
  return byThread;
});
