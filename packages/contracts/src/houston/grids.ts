import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "../baseSchemas.ts";

/** The bounds a grid is checked against; a refusal names the bound and the value. */
export const HOUSTON_GRID_LIMITS = {
  nameChars: 120,
  /** The renderer's grid cap: six cells stay legible in the narrowest supported window. */
  threads: 6,
  /** Six leaves nest at most five splits deep; a few spare levels absorb a transient layout. */
  treeDepth: 8,
  /** Well above the grids a person keeps per project; bounds the stream snapshot. */
  gridsPerProject: 200,
  idChars: 128,
  workspaceKeyChars: 300,
} as const;

const Id = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(HOUSTON_GRID_LIMITS.idChars),
);

export interface HoustonGridThreadNode {
  readonly kind: "thread";
  readonly threadId: string;
  readonly id: string;
  readonly draftId?: string;
}

export interface HoustonGridSplitNode {
  readonly kind: "split";
  readonly dir: "row" | "col";
  readonly children: HoustonGridLayoutNode[];
  readonly weights: number[];
}

export type HoustonGridLayoutNode = HoustonGridThreadNode | HoustonGridSplitNode;

const GridThreadNode = Schema.Struct({
  kind: Schema.Literal("thread"),
  threadId: Id,
  id: Id,
  draftId: Schema.optionalKey(Id),
});

const Weight = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0));

// Built level by level instead of recursively, so the depth bound holds before any decoding
// descends and a hostile nesting never reaches the stack.
const layoutNodeAtDepth = (levels: number): Schema.Codec<HoustonGridLayoutNode> => {
  let node: Schema.Codec<HoustonGridLayoutNode> = GridThreadNode;
  for (let level = 1; level < levels; level += 1) {
    node = Schema.Union([
      GridThreadNode,
      Schema.Struct({
        kind: Schema.Literal("split"),
        dir: Schema.Literals(["row", "col"]),
        children: Schema.mutable(Schema.Array(node)).check(
          Schema.isMinLength(1),
          Schema.isMaxLength(HOUSTON_GRID_LIMITS.threads),
        ),
        weights: Schema.mutable(Schema.Array(Weight)),
      }),
    ]) as Schema.Codec<HoustonGridLayoutNode>;
  }
  return node;
};

const threadIdsOf = (node: HoustonGridLayoutNode): string[] =>
  node.kind === "thread" ? [node.threadId] : node.children.flatMap(threadIdsOf);

const splitsAreConsistent = (node: HoustonGridLayoutNode): boolean =>
  node.kind === "thread" ||
  (node.children.length === node.weights.length && node.children.every(splitsAreConsistent));

/** A tree of thread leaves: bounded depth, at most one leaf per thread and at most the grid cap. */
export const HoustonGridLayoutNode = layoutNodeAtDepth(HOUSTON_GRID_LIMITS.treeDepth).check(
  Schema.makeFilter((node: HoustonGridLayoutNode) => {
    if (!splitsAreConsistent(node)) return "a split needs one positive weight per child";
    const ids = threadIdsOf(node);
    if (ids.length > HOUSTON_GRID_LIMITS.threads) {
      return `a grid holds at most ${HOUSTON_GRID_LIMITS.threads} threads, the tree has ${ids.length}`;
    }
    if (new Set(ids).size !== ids.length) return "a thread appears in the tree more than once";
    return undefined;
  }),
);

/** One grid as the server stores it. Focus and open panels stay with the client. */
export const HoustonGridRecord = Schema.Struct({
  id: Id,
  environmentId: Id,
  projectId: Id,
  workspaceKey: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(HOUSTON_GRID_LIMITS.workspaceKeyChars),
  ),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(HOUSTON_GRID_LIMITS.nameChars)),
  tree: Schema.NullOr(HoustonGridLayoutNode),
  pinnedAt: Schema.NullOr(IsoDateTime),
  hidden: Schema.Boolean,
  createdAt: IsoDateTime,
  /** Counts the saves of this grid; the first is 1. A put's revision and time are set by the server. */
  revision: NonNegativeInt,
  updatedAt: IsoDateTime,
});
export type HoustonGridRecord = typeof HoustonGridRecord.Type;

export const HoustonGridErrorKind = Schema.Literals([
  "invalid",
  "limit",
  "not_found",
  "grid_full",
  "cross_project",
]);
export type HoustonGridErrorKind = typeof HoustonGridErrorKind.Type;

/** A refusal; `limit` and `actual` name the bound and the value that tripped it. */
export class HoustonGridError extends Schema.TaggedError<HoustonGridError>()("HoustonGridError", {
  kind: HoustonGridErrorKind,
  message: Schema.String,
  operation: Schema.String,
  field: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
  actual: Schema.optional(Schema.Number),
}) {}

// RPC payloads.

export const HoustonGridEmptyInput = Schema.Struct({});
export type HoustonGridEmptyInput = typeof HoustonGridEmptyInput.Type;

export const HoustonGridListInput = Schema.Struct({
  projectId: Schema.optionalKey(Id),
});
export type HoustonGridListInput = typeof HoustonGridListInput.Type;

/** Saves a whole grid; 0 creates it and is refused for a grid that already exists. */
export const HoustonGridPutInput = Schema.Struct({
  grid: HoustonGridRecord,
  expectedRevision: NonNegativeInt,
});
export type HoustonGridPutInput = typeof HoustonGridPutInput.Type;

/** A conflict carries the server's grid, or null when the grid was deleted. */
export const HoustonGridPutResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("saved"), grid: HoustonGridRecord }),
  Schema.Struct({ status: Schema.Literal("conflict"), current: Schema.NullOr(HoustonGridRecord) }),
]);
export type HoustonGridPutResult = typeof HoustonGridPutResult.Type;

// Service operations; the MCP tools call these with the same shapes.

export const HoustonGridCreateInput = Schema.Struct({
  projectId: Id,
  name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(HOUSTON_GRID_LIMITS.nameChars))),
});
export type HoustonGridCreateInput = typeof HoustonGridCreateInput.Type;

export const HoustonGridRenameInput = Schema.Struct({
  gridId: Id,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(HOUSTON_GRID_LIMITS.nameChars)),
});
export type HoustonGridRenameInput = typeof HoustonGridRenameInput.Type;

export const HoustonGridDeleteInput = Schema.Struct({ gridId: Id });
export type HoustonGridDeleteInput = typeof HoustonGridDeleteInput.Type;

export const HoustonGridDeleteResult = Schema.Struct({ deleted: Schema.Boolean });
export type HoustonGridDeleteResult = typeof HoustonGridDeleteResult.Type;

export const HoustonGridSetHiddenInput = Schema.Struct({ gridId: Id, hidden: Schema.Boolean });
export type HoustonGridSetHiddenInput = typeof HoustonGridSetHiddenInput.Type;

export const HoustonGridSetPinnedInput = Schema.Struct({ gridId: Id, pinned: Schema.Boolean });
export type HoustonGridSetPinnedInput = typeof HoustonGridSetPinnedInput.Type;

/** Appends the thread to the grid and takes it out of any other grid of its project. */
export const HoustonGridPlaceThreadInput = Schema.Struct({ gridId: Id, threadId: Id });
export type HoustonGridPlaceThreadInput = typeof HoustonGridPlaceThreadInput.Type;

export const HoustonGridRemoveThreadInput = Schema.Struct({ gridId: Id, threadId: Id });
export type HoustonGridRemoveThreadInput = typeof HoustonGridRemoveThreadInput.Type;

/** Where a thread an agent launches goes: an existing grid, or a new one named here. */
export const HoustonGridLaunchTarget = Schema.Union([
  Schema.Struct({ gridId: Id }),
  Schema.Struct({
    newGridName: TrimmedNonEmptyString.check(Schema.isMaxLength(HOUSTON_GRID_LIMITS.nameChars)),
  }),
]);
export type HoustonGridLaunchTarget = typeof HoustonGridLaunchTarget.Type;

/** What became of a launched thread's grid target; a refusal leaves the thread in place. */
export const HoustonGridPlacement = Schema.Union([
  Schema.Struct({ placed: Schema.Literal(true), gridId: Id }),
  Schema.Struct({
    placed: Schema.Literal(false),
    gridId: Schema.optional(Id),
    error: Schema.String,
  }),
]);
export type HoustonGridPlacement = typeof HoustonGridPlacement.Type;

/** The first event is the snapshot; every later one follows a committed change. */
export const HoustonGridStreamEvent = Schema.Union([
  Schema.Struct({ snapshot: Schema.Struct({ grids: Schema.Array(HoustonGridRecord) }) }),
  Schema.Struct({ upserted: HoustonGridRecord }),
  Schema.Struct({ deleted: Schema.Struct({ gridId: Id, projectId: Id }) }),
]);
export type HoustonGridStreamEvent = typeof HoustonGridStreamEvent.Type;
