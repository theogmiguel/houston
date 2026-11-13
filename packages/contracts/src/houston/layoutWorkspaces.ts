import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "../baseSchemas.ts";

/** The bounds a layout workspace is checked against; a refusal names the bound and the value. */
export const HOUSTON_LAYOUT_WORKSPACE_LIMITS = {
  nameChars: 120,
  /** Well above the workspaces a person keeps; bounds the stream snapshot. */
  workspaces: 100,
  /** A strip of 24 columns is already ten screens wide at the narrowest readable column. */
  columns: 24,
  /** Panes stack inside one column's height; past a dozen each is too short to read. */
  panesPerColumn: 12,
  tabsPerPane: 50,
  /** Caps a workspace's stored size independently of how its tabs are spread over panes. */
  tabsPerWorkspace: 200,
  idChars: 128,
  /** The longest href a page tab keeps; matches the usual URL length ceiling of browsers. */
  hrefChars: 2048,
} as const;

const Id = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(HOUSTON_LAYOUT_WORKSPACE_LIMITS.idChars),
);

/** A fraction of the strip (column width) or of a column's height (pane size). */
const Share = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(1),
);

export interface HoustonLayoutThreadRef {
  readonly environmentId: string;
  readonly threadId: string;
}

export type HoustonLayoutChatTarget =
  | { readonly kind: "server"; readonly threadRef: HoustonLayoutThreadRef }
  | { readonly kind: "draft"; readonly draftId: string };

const ThreadRef = Schema.Struct({ environmentId: Id, threadId: Id });

const ChatTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("server"), threadRef: ThreadRef }),
  Schema.Struct({ kind: Schema.Literal("draft"), draftId: Id }),
]);

export const HOUSTON_LAYOUT_PAGES = ["pull-requests", "tasks"] as const;

/** A thread or draft (chat), a thread's surface (surface), an empty tab (launcher) or a page. */
export const HoustonLayoutTabContent = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("chat"), target: ChatTarget }),
  Schema.Struct({ kind: Schema.Literal("surface"), threadRef: ThreadRef, surfaceId: Id }),
  Schema.Struct({
    kind: Schema.Literal("launcher"),
    id: Id,
    context: Schema.NullOr(ChatTarget),
  }),
  Schema.Struct({
    kind: Schema.Literal("page"),
    page: Schema.Literals(HOUSTON_LAYOUT_PAGES),
    href: Schema.optionalKey(
      Schema.String.check(Schema.isMaxLength(HOUSTON_LAYOUT_WORKSPACE_LIMITS.hrefChars)),
    ),
  }),
]);
export type HoustonLayoutTabContent = typeof HoustonLayoutTabContent.Type;

export const HoustonLayoutTab = Schema.Struct({ id: Id, content: HoustonLayoutTabContent });
export type HoustonLayoutTab = typeof HoustonLayoutTab.Type;

export const HoustonLayoutPane = Schema.Struct({
  id: Id,
  /** Share of the column's height. */
  size: Share,
  activeTabId: Schema.NullOr(Id),
  tabs: Schema.Array(HoustonLayoutTab).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(HOUSTON_LAYOUT_WORKSPACE_LIMITS.tabsPerPane),
  ),
});
export type HoustonLayoutPane = typeof HoustonLayoutPane.Type;

export const HoustonLayoutColumn = Schema.Struct({
  id: Id,
  /** Share of the strip the workspace was arranged at; 1 is full width. */
  width: Share,
  panes: Schema.Array(HoustonLayoutPane).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(HOUSTON_LAYOUT_WORKSPACE_LIMITS.panesPerColumn),
  ),
});
export type HoustonLayoutColumn = typeof HoustonLayoutColumn.Type;

/** Two tabs with the same key show the same thing; a layout holds at most one tab per key. */
export const layoutTabContentKey = (content: HoustonLayoutTabContent): string => {
  switch (content.kind) {
    case "chat":
      return content.target.kind === "draft"
        ? `chat:draft:${content.target.draftId}`
        : `chat:${content.target.threadRef.environmentId}:${content.target.threadRef.threadId}`;
    case "page":
      return `page:${content.page}`;
    case "launcher":
      return `launcher:${content.id}`;
    case "surface":
      return `surface:${content.threadRef.environmentId}:${content.threadRef.threadId}:${content.surfaceId}`;
  }
};

/** A bound or rule a workspace's layout breaks; `limit` and `actual` are set for a bound. */
export interface HoustonLayoutViolation {
  readonly kind: "limit" | "invalid" | "duplicate_content";
  readonly field: string;
  readonly message: string;
  readonly limit?: number;
  readonly actual?: number;
}

interface LayoutShape {
  readonly columns: ReadonlyArray<{
    readonly id: string;
    readonly panes: ReadonlyArray<{
      readonly id: string;
      readonly activeTabId: string | null;
      readonly tabs: ReadonlyArray<{
        readonly id: string;
        readonly content: HoustonLayoutTabContent;
      }>;
    }>;
  }>;
}

const bound = (
  field: string,
  what: string,
  limit: number,
  actual: number,
): HoustonLayoutViolation => ({
  kind: "limit",
  field,
  limit,
  actual,
  message: `${what} holds at most ${limit}, got ${actual}.`,
});

/** The first bound or rule a layout breaks; the schema and the service share it. */
export const findLayoutViolation = (layout: LayoutShape): HoustonLayoutViolation | undefined => {
  const limits = HOUSTON_LAYOUT_WORKSPACE_LIMITS;
  if (layout.columns.length > limits.columns) {
    return bound("columns", "A workspace's columns", limits.columns, layout.columns.length);
  }
  let tabCount = 0;
  const ids = new Set<string>();
  const keys = new Set<string>();
  const claim = (kind: string, id: string): HoustonLayoutViolation | undefined => {
    if (id.length === 0 || id.length > limits.idChars) {
      return {
        kind: id.length === 0 ? "invalid" : "limit",
        field: `${kind}.id`,
        ...(id.length === 0 ? {} : { limit: limits.idChars, actual: id.length }),
        message: `A ${kind} id holds 1 to ${limits.idChars} characters, got ${id.length}.`,
      };
    }
    if (ids.has(id)) {
      return {
        kind: "invalid",
        field: `${kind}.id`,
        message: `The id '${id}' is used by more than one column, pane or tab; ids are unique within a workspace.`,
      };
    }
    ids.add(id);
    return undefined;
  };
  for (const column of layout.columns) {
    const columnProblem = claim("column", column.id);
    if (columnProblem !== undefined) return columnProblem;
    if (column.panes.length === 0) {
      return {
        kind: "invalid",
        field: "panes",
        message: `Column '${column.id}' has no panes; a column holds at least 1.`,
      };
    }
    if (column.panes.length > limits.panesPerColumn) {
      return bound("panes", "A column's panes", limits.panesPerColumn, column.panes.length);
    }
    for (const pane of column.panes) {
      const paneProblem = claim("pane", pane.id);
      if (paneProblem !== undefined) return paneProblem;
      if (pane.tabs.length === 0) {
        return {
          kind: "invalid",
          field: "tabs",
          message: `Pane '${pane.id}' has no tabs; a pane holds at least 1.`,
        };
      }
      if (pane.tabs.length > limits.tabsPerPane) {
        return bound("tabs", "A pane's tabs", limits.tabsPerPane, pane.tabs.length);
      }
      if (pane.activeTabId !== null && !pane.tabs.some((tab) => tab.id === pane.activeTabId)) {
        return {
          kind: "invalid",
          field: "activeTabId",
          message: `Pane '${pane.id}' names active tab '${pane.activeTabId}', which is not one of its ${pane.tabs.length} tabs.`,
        };
      }
      tabCount += pane.tabs.length;
      for (const tab of pane.tabs) {
        const tabProblem = claim("tab", tab.id);
        if (tabProblem !== undefined) return tabProblem;
        const key = layoutTabContentKey(tab.content);
        if (keys.has(key)) {
          return {
            kind: "duplicate_content",
            field: "content",
            message: `Tab '${tab.id}' shows ${key}, which another tab of this workspace already shows; a layout holds one tab per content.`,
          };
        }
        keys.add(key);
      }
    }
  }
  if (tabCount > limits.tabsPerWorkspace) {
    return bound("tabs", "A workspace's tabs", limits.tabsPerWorkspace, tabCount);
  }
  return undefined;
};

/**
 * One workspace as stored. On-screen focus, camera width and ghost tabs stay with the client; the
 * server keeps the last reported focus as the default workspace for threads created without a parent.
 */
export const HoustonLayoutWorkspaceRecord = Schema.Struct({
  id: Id,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(HOUSTON_LAYOUT_WORKSPACE_LIMITS.nameChars)),
  /** Display order, ascending. A put leaves it as stored; only a reorder changes it. */
  position: NonNegativeInt,
  columns: Schema.Array(HoustonLayoutColumn).check(
    Schema.isMaxLength(HOUSTON_LAYOUT_WORKSPACE_LIMITS.columns),
  ),
  pinnedAt: Schema.NullOr(IsoDateTime),
  hidden: Schema.Boolean,
  createdAt: IsoDateTime,
  /** Counts the saves of this workspace; the first is 1. A put's revision and time are set by the server. */
  revision: NonNegativeInt,
  updatedAt: IsoDateTime,
}).check(Schema.makeFilter((record) => findLayoutViolation(record)?.message));
export type HoustonLayoutWorkspaceRecord = typeof HoustonLayoutWorkspaceRecord.Type;

export const HoustonLayoutWorkspaceRecordList = Schema.Array(HoustonLayoutWorkspaceRecord);

export const HoustonLayoutWorkspaceErrorKind = Schema.Literals([
  "invalid",
  "limit",
  "not_found",
  "duplicate_content",
  "last_workspace",
  "has_threads",
]);
export type HoustonLayoutWorkspaceErrorKind = typeof HoustonLayoutWorkspaceErrorKind.Type;

/** A refusal; `limit` and `actual` name the bound and the value that tripped it. */
export class HoustonLayoutWorkspaceError extends Schema.TaggedError<HoustonLayoutWorkspaceError>()(
  "HoustonLayoutWorkspaceError",
  {
    kind: HoustonLayoutWorkspaceErrorKind,
    message: Schema.String,
    operation: Schema.String,
    field: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.Number),
    actual: Schema.optional(Schema.Number),
  },
) {}

// RPC payloads.

export const HoustonLayoutWorkspaceEmptyInput = Schema.Struct({});
export type HoustonLayoutWorkspaceEmptyInput = typeof HoustonLayoutWorkspaceEmptyInput.Type;

/** Saves a whole workspace; 0 creates it and is refused for a workspace that already exists. */
export const HoustonLayoutWorkspacePutInput = Schema.Struct({
  workspace: HoustonLayoutWorkspaceRecord,
  expectedRevision: NonNegativeInt,
});
export type HoustonLayoutWorkspacePutInput = typeof HoustonLayoutWorkspacePutInput.Type;

/** A conflict carries the server's workspace, or null when the workspace was deleted. */
export const HoustonLayoutWorkspacePutResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("saved"), workspace: HoustonLayoutWorkspaceRecord }),
  Schema.Struct({
    status: Schema.Literal("conflict"),
    current: Schema.NullOr(HoustonLayoutWorkspaceRecord),
  }),
]);
export type HoustonLayoutWorkspacePutResult = typeof HoustonLayoutWorkspacePutResult.Type;

/** Every workspace id, once, in the new display order. */
export const HoustonLayoutWorkspaceReorderInput = Schema.Struct({
  workspaceIds: Schema.Array(Id).check(
    Schema.isMaxLength(HOUSTON_LAYOUT_WORKSPACE_LIMITS.workspaces),
  ),
});
export type HoustonLayoutWorkspaceReorderInput = typeof HoustonLayoutWorkspaceReorderInput.Type;

/**
 * Deleting a workspace is refused while a live thread belongs to it; the caller deletes those
 * threads first. Chat tabs of other content move to the first remaining workspace.
 */
export const HoustonLayoutWorkspaceDeleteInput = Schema.Struct({ workspaceId: Id });
export type HoustonLayoutWorkspaceDeleteInput = typeof HoustonLayoutWorkspaceDeleteInput.Type;

export const HoustonLayoutWorkspaceDeleteResult = Schema.Struct({ deleted: Schema.Boolean });
export type HoustonLayoutWorkspaceDeleteResult = typeof HoustonLayoutWorkspaceDeleteResult.Type;

/**
 * The workspace a chat thread belongs to. `parentThreadId` is set for a subagent child, which has
 * no workspace choice of its own and follows its parent.
 */
export const HoustonLayoutThreadMembership = Schema.Struct({
  environmentId: Id,
  threadId: Id,
  workspaceId: Id,
  parentThreadId: Schema.NullOr(Id),
});
export type HoustonLayoutThreadMembership = typeof HoustonLayoutThreadMembership.Type;

/** Records the workspace a new thread belongs to; a thread that already has one keeps it. */
export const HoustonLayoutThreadAssignInput = Schema.Struct({
  environmentId: Id,
  threadId: Id,
  workspaceId: Id,
});
export type HoustonLayoutThreadAssignInput = typeof HoustonLayoutThreadAssignInput.Type;

/**
 * Moves a thread, its children and their chat tabs to a workspace in one transaction. Tabs go
 * to `paneId` (at `index`) when that pane is in the target, else the end of its last pane.
 */
export const HoustonLayoutThreadMoveInput = Schema.Struct({
  environmentId: Id,
  threadId: Id,
  workspaceId: Id,
  paneId: Schema.optional(Id),
  index: Schema.optional(NonNegativeInt),
});
export type HoustonLayoutThreadMoveInput = typeof HoustonLayoutThreadMoveInput.Type;

/** `previous` is where the thread's first chat tab sat, so a caller can move it back. */
export const HoustonLayoutThreadMoveResult = Schema.Struct({
  membership: HoustonLayoutThreadMembership,
  previous: Schema.Struct({
    workspaceId: Schema.NullOr(Id),
    paneId: Schema.NullOr(Id),
    index: Schema.NullOr(NonNegativeInt),
  }),
});
export type HoustonLayoutThreadMoveResult = typeof HoustonLayoutThreadMoveResult.Type;

/** The workspace the person last had focused; a default for threads created without a parent. */
export const HoustonLayoutFocusInput = Schema.Struct({ workspaceId: Id });
export type HoustonLayoutFocusInput = typeof HoustonLayoutFocusInput.Type;

/** The first event is the snapshot; every later one follows a committed change. */
export const HoustonLayoutWorkspaceStreamEvent = Schema.Union([
  Schema.Struct({
    snapshot: Schema.Struct({
      workspaces: Schema.Array(HoustonLayoutWorkspaceRecord),
      memberships: Schema.Array(HoustonLayoutThreadMembership),
    }),
  }),
  Schema.Struct({ upserted: HoustonLayoutWorkspaceRecord }),
  Schema.Struct({ deleted: Schema.Struct({ workspaceId: Id }) }),
  Schema.Struct({ membership: HoustonLayoutThreadMembership }),
  Schema.Struct({
    membershipRemoved: Schema.Struct({ environmentId: Id, threadId: Id }),
  }),
]);
export type HoustonLayoutWorkspaceStreamEvent = typeof HoustonLayoutWorkspaceStreamEvent.Type;

// Launch placement.

const WorkspaceName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(HOUSTON_LAYOUT_WORKSPACE_LIMITS.nameChars),
);

/** Where threads an agent launches go: an existing workspace, or one new workspace named here. */
export const HoustonLayoutLaunchTarget = Schema.Union([
  Schema.Struct({ workspaceId: Id }),
  Schema.Struct({ newWorkspaceName: WorkspaceName }),
]);
export type HoustonLayoutLaunchTarget = typeof HoustonLayoutLaunchTarget.Type;

/** The launch target of the `houston_grid_*` tools, accepted as an alias of `HoustonLayoutLaunchTarget` until it is removed in the next release. */
export const HoustonGridLaunchTargetAlias = Schema.Union([
  Schema.Struct({ gridId: Id }),
  Schema.Struct({ newGridName: WorkspaceName }),
]);
export type HoustonGridLaunchTargetAlias = typeof HoustonGridLaunchTargetAlias.Type;

/** What became of a launched thread's workspace target; a refusal leaves the thread in place. */
export const HoustonLayoutPlacement = Schema.Union([
  Schema.Struct({ placed: Schema.Literal(true), workspaceId: Id }),
  Schema.Struct({
    placed: Schema.Literal(false),
    workspaceId: Schema.optional(Id),
    error: Schema.String,
  }),
]);
export type HoustonLayoutPlacement = typeof HoustonLayoutPlacement.Type;

/** `HoustonLayoutPlacement` as the `houston_grid_*` tools reported it, with the workspace id as `gridId`; removed in the next release. */
export const HoustonGridPlacementAlias = Schema.Union([
  Schema.Struct({ placed: Schema.Literal(true), gridId: Id }),
  Schema.Struct({
    placed: Schema.Literal(false),
    gridId: Schema.optional(Id),
    error: Schema.String,
  }),
]);
export type HoustonGridPlacementAlias = typeof HoustonGridPlacementAlias.Type;
