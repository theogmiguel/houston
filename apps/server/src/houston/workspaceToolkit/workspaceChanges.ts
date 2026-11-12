// Changes to one workspace made from outside the renderer: create it, change its fields, and open
// or close a thread's chat in it. Each reads the workspace, builds the new record and saves it
// with the revision it read, so a save the renderer made in between is never overwritten.
import {
  type HoustonLayoutColumn,
  type HoustonLayoutPane,
  HoustonLayoutWorkspaceError,
  type HoustonLayoutTab,
  type HoustonLayoutTabContent,
  type HoustonLayoutWorkspaceRecord,
  findLayoutViolation,
  layoutTabContentKey,
} from "@houston-app/contracts/houston/layoutWorkspaces";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";

import { HoustonLayoutWorkspaceService } from "../layoutWorkspaces.ts";
import { nowIso } from "../tasks/TaskStore.ts";

/**
 * Saves of one workspace tried before giving up. A conflict means the renderer saved the same
 * workspace between our read and our save (a drag or a tab change); each retry re-reads, so five
 * attempts ride out a burst of saves from one person while a workspace that never settles still
 * fails fast.
 */
export const PLACEMENT_ATTEMPTS = 5;

const refuse = (
  kind: HoustonLayoutWorkspaceError["kind"],
  operation: string,
  message: string,
  detail: { field?: string; limit?: number; actual?: number } = {},
) => new HoustonLayoutWorkspaceError({ kind, operation, message, ...detail });

const chatContentOf = (environmentId: string, threadId: string): HoustonLayoutTabContent => ({
  kind: "chat",
  target: { kind: "server", threadRef: { environmentId, threadId } },
});

const tabsOf = (workspace: HoustonLayoutWorkspaceRecord) =>
  workspace.columns.flatMap((column) => column.panes.flatMap((pane) => pane.tabs));

const findTab = (workspace: HoustonLayoutWorkspaceRecord, key: string) =>
  tabsOf(workspace).find((tab) => layoutTabContentKey(tab.content) === key);

/** The chat thread ids open in a workspace, in column, pane and tab order. */
export const chatThreadIdsOf = (workspace: Pick<HoustonLayoutWorkspaceRecord, "columns">) =>
  workspace.columns.flatMap((column) =>
    column.panes.flatMap((pane) =>
      pane.tabs.flatMap((tab) =>
        tab.content.kind === "chat" && tab.content.target.kind === "server"
          ? [tab.content.target.threadRef.threadId]
          : [],
      ),
    ),
  );

/** `workspace` without the tab showing `key`; a pane or column it empties goes, and a pane it refocuses shows its first tab. */
const withoutTab = (
  workspace: HoustonLayoutWorkspaceRecord,
  key: string,
): HoustonLayoutWorkspaceRecord => ({
  ...workspace,
  columns: workspace.columns.flatMap((column): HoustonLayoutColumn[] => {
    const kept = column.panes.flatMap((pane): HoustonLayoutPane[] => {
      const tabs = pane.tabs.filter((tab) => layoutTabContentKey(tab.content) !== key);
      if (tabs.length === 0) return [];
      if (tabs.length === pane.tabs.length) return [pane];
      return [
        {
          ...pane,
          tabs,
          activeTabId: tabs.some((tab) => tab.id === pane.activeTabId)
            ? pane.activeTabId
            : tabs[0]!.id,
        },
      ];
    });
    if (kept.length === 0) return [];
    if (kept.length === column.panes.length && kept.every((pane, i) => pane === column.panes[i])) {
      return [column];
    }
    const total = kept.reduce((sum, pane) => sum + pane.size, 0);
    return [{ ...column, panes: kept.map((pane) => ({ ...pane, size: pane.size / total })) }];
  }),
});

/**
 * `workspace` with `tab` at the end of its last pane. A workspace with no column gets one, whose
 * pane shows the tab; in an existing pane the focused tab stays focused.
 */
const withTabAppended = (
  workspace: HoustonLayoutWorkspaceRecord,
  tab: HoustonLayoutTab,
  stem: string,
): HoustonLayoutWorkspaceRecord => {
  const lastColumn = workspace.columns.at(-1);
  const lastPane = lastColumn?.panes.at(-1);
  if (lastColumn === undefined || lastPane === undefined) {
    return {
      ...workspace,
      columns: [
        {
          id: `column:${stem}`,
          width: 1,
          panes: [{ id: `pane:${stem}`, size: 1, activeTabId: tab.id, tabs: [tab] }],
        },
      ],
    };
  }
  return {
    ...workspace,
    columns: workspace.columns.map((column) =>
      column.id === lastColumn.id
        ? {
            ...column,
            panes: column.panes.map((pane) =>
              pane.id === lastPane.id ? { ...pane, tabs: [...pane.tabs, tab] } : pane,
            ),
          }
        : column,
    ),
  };
};

const violationRefusal = (
  operation: string,
  workspace: HoustonLayoutWorkspaceRecord,
  what: string,
) => {
  const violation = findLayoutViolation(workspace);
  if (violation === undefined) return undefined;
  return refuse(
    violation.kind,
    operation,
    `Cannot ${what} in workspace '${workspace.id}': ${violation.message}`,
    {
      field: violation.field,
      ...(violation.limit === undefined ? {} : { limit: violation.limit }),
      ...(violation.actual === undefined ? {} : { actual: violation.actual }),
    },
  );
};

const exhausted = (operation: string, workspaceId: string) =>
  refuse(
    "limit",
    operation,
    `Workspace '${workspaceId}' kept changing while it was saved: ${PLACEMENT_ATTEMPTS} attempts all met a newer revision (limit ${PLACEMENT_ATTEMPTS}). Try again.`,
    { field: "attempts", limit: PLACEMENT_ATTEMPTS, actual: PLACEMENT_ATTEMPTS },
  );

/**
 * Applies `change` to the workspace and saves it with the revision read, re-reading and trying
 * again after a conflict, up to `PLACEMENT_ATTEMPTS` saves. A change that returns the workspace
 * as it was saves nothing.
 */
export const modifyWorkspace = Effect.fn("HoustonWorkspaceToolkit.modifyWorkspace")(function* (
  operation: string,
  workspaceId: string,
  change: (
    workspace: HoustonLayoutWorkspaceRecord,
  ) => Effect.Effect<HoustonLayoutWorkspaceRecord, HoustonLayoutWorkspaceError>,
) {
  const workspaces = yield* HoustonLayoutWorkspaceService;
  for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt += 1) {
    const current = yield* workspaces.get(workspaceId);
    const next = yield* change(current);
    if (next === current) return current;
    const saved = yield* workspaces.put({ workspace: next, expectedRevision: current.revision });
    if (saved.status === "saved") return saved.workspace;
  }
  return yield* exhausted(operation, workspaceId);
});

/** Creates an empty workspace after the others; `name` defaults to the next 'Workspace N'. */
export const createWorkspace = Effect.fn("HoustonWorkspaceToolkit.createWorkspace")(
  function* (input: { readonly name?: string | undefined }) {
    const operation = "houston.layoutWorkspaces.create";
    const workspaces = yield* HoustonLayoutWorkspaceService;
    const random = yield* SecureRandom.SecureRandom;
    const existing = yield* workspaces.list;
    const now = yield* nowIso;
    const saved = yield* workspaces.put({
      workspace: {
        id: yield* random.uuidV4(),
        name: input.name ?? `Workspace ${existing.length + 1}`,
        position: 0,
        columns: [],
        pinnedAt: null,
        hidden: false,
        createdAt: now,
        revision: 0,
        updatedAt: now,
      },
      expectedRevision: 0,
    });
    if (saved.status === "saved") return saved.workspace;
    return yield* refuse("invalid", operation, "A new workspace id was already taken; try again.");
  },
);

/**
 * Opens `threadId`'s chat in the workspace as a tab at the end of its last pane, in a new column
 * when it has none. A thread's chat is in one workspace at a time: a tab it has elsewhere is
 * taken out first, keeping that workspace's other tabs, and the tab keeps its id. A thread already
 * open in the workspace stays where it is. The new tab is checked against the workspace's bounds
 * before the old one is touched.
 */
export const placeThread = Effect.fn("HoustonWorkspaceToolkit.placeThread")(function* (input: {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly environmentId: string;
}) {
  const operation = "houston.layoutWorkspaces.addThread";
  const workspaces = yield* HoustonLayoutWorkspaceService;
  const random = yield* SecureRandom.SecureRandom;
  const content = chatContentOf(input.environmentId, input.threadId);
  const key = layoutTabContentKey(content);
  for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt += 1) {
    const all = yield* workspaces.list;
    const target = all.find((workspace) => workspace.id === input.workspaceId);
    if (target === undefined) {
      return yield* refuse("not_found", operation, `no workspace '${input.workspaceId}'`, {
        field: "workspaceId",
      });
    }
    const holder = all.find((workspace) => findTab(workspace, key) !== undefined);
    if (holder?.id === target.id) return target;
    const stem = yield* random.uuidV4();
    const tab = (holder === undefined ? undefined : findTab(holder, key)) ?? {
      id: `tab:${stem}`,
      content,
    };
    const next = withTabAppended(target, tab, stem);
    const refusal = violationRefusal(operation, next, `open thread '${input.threadId}'`);
    if (refusal !== undefined) return yield* refusal;
    if (holder !== undefined) {
      const left = yield* workspaces.put({
        workspace: withoutTab(holder, key),
        expectedRevision: holder.revision,
      });
      if (left.status === "conflict") continue;
    }
    const saved = yield* workspaces.put({ workspace: next, expectedRevision: target.revision });
    if (saved.status === "saved") return saved.workspace;
  }
  return yield* exhausted(operation, input.workspaceId);
});

/** Closes `threadId`'s chat tab in the workspace; the thread's other tabs stay. */
export const removeThread = (input: {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly environmentId: string;
}) => {
  const operation = "houston.layoutWorkspaces.removeThread";
  const key = layoutTabContentKey(chatContentOf(input.environmentId, input.threadId));
  return modifyWorkspace(operation, input.workspaceId, (workspace) =>
    findTab(workspace, key) === undefined
      ? Effect.fail(
          refuse(
            "not_found",
            operation,
            `thread '${input.threadId}' is not open in workspace '${workspace.id}'`,
            { field: "threadId" },
          ),
        )
      : Effect.succeed(withoutTab(workspace, key)),
  );
};
