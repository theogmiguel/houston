/** Converts the layout model to and from the workspaces the server stores. */
import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import {
  HOUSTON_LAYOUT_WORKSPACE_LIMITS,
  type HoustonLayoutTab,
  type HoustonLayoutTabContent,
  type HoustonLayoutWorkspaceRecord,
} from "@houston-app/contracts/houston/layoutWorkspaces";

import { DraftId } from "../composerDraftStore";
import type { ThreadRouteTarget } from "../threadRoutes";
import {
  normalizeLayout,
  type LayoutColumn,
  type LayoutPane,
  type LayoutState,
  type LayoutTab,
  type LayoutTabContent,
  type LayoutWorkspace,
} from "./layoutModel";

/** What the server already holds for a workspace, kept so a save does not rename or re-date it. */
export interface KnownLayoutRecord {
  readonly name: string;
  readonly createdAt: string;
}

type RecordChatTarget = Extract<HoustonLayoutTabContent, { kind: "chat" }>["target"];

function chatTargetToRecord(target: ThreadRouteTarget): RecordChatTarget {
  return target.kind === "draft"
    ? { kind: "draft", draftId: target.draftId }
    : {
        kind: "server",
        threadRef: {
          environmentId: target.threadRef.environmentId,
          threadId: target.threadRef.threadId,
        },
      };
}

function chatTargetFromRecord(target: RecordChatTarget): ThreadRouteTarget {
  return target.kind === "draft"
    ? { kind: "draft", draftId: DraftId.make(target.draftId) }
    : {
        kind: "server",
        threadRef: scopeThreadRef(
          EnvironmentId.make(target.threadRef.environmentId),
          ThreadId.make(target.threadRef.threadId),
        ),
      };
}

export function tabContentToRecord(content: LayoutTabContent): HoustonLayoutTabContent {
  switch (content.kind) {
    case "chat":
      return { kind: "chat", target: chatTargetToRecord(content.target) };
    case "surface":
      return {
        kind: "surface",
        threadRef: {
          environmentId: content.threadRef.environmentId,
          threadId: content.threadRef.threadId,
        },
        surfaceId: content.surfaceId,
      };
    case "launcher":
      return {
        kind: "launcher",
        id: content.id,
        context: content.context === null ? null : chatTargetToRecord(content.context),
      };
    case "settings":
    case "usage":
    case "pull-requests":
      return {
        kind: "page",
        page: content.kind,
        ...(content.href === undefined ? {} : { href: content.href }),
      };
  }
}

export function tabContentFromRecord(content: HoustonLayoutTabContent): LayoutTabContent {
  switch (content.kind) {
    case "chat":
      return { kind: "chat", target: chatTargetFromRecord(content.target) };
    case "surface":
      return {
        kind: "surface",
        threadRef: scopeThreadRef(
          EnvironmentId.make(content.threadRef.environmentId),
          ThreadId.make(content.threadRef.threadId),
        ),
        surfaceId: content.surfaceId,
      };
    case "launcher":
      return {
        kind: "launcher",
        id: content.id,
        context: content.context === null ? null : chatTargetFromRecord(content.context),
      };
    case "page":
      return { kind: content.page, ...(content.href === undefined ? {} : { href: content.href }) };
  }
}

/** The record has no unnamed workspace, so one without a name is named by where it sits. */
function nameOf(
  workspace: LayoutWorkspace,
  known: KnownLayoutRecord | undefined,
  place: number,
): string {
  const name = workspace.name?.trim() || known?.name || `Workspace ${place}`;
  return name.slice(0, HOUSTON_LAYOUT_WORKSPACE_LIMITS.nameChars);
}

/**
 * The workspaces to store. The empty workspace at the bottom of the strip is the place a new
 * workspace starts, so it is stored only once it holds tabs; when no workspace holds any, the
 * first stays so the server always has one. `position` is the server's to set and is filled
 * from the place in this list; the server ignores it on a put.
 */
export function layoutStateToRecords(
  state: LayoutState,
  known: ReadonlyMap<string, KnownLayoutRecord>,
  now: string,
): HoustonLayoutWorkspaceRecord[] {
  const filled = state.workspaces.filter((workspace) => workspace.columns.length > 0);
  const kept = filled.length > 0 ? filled : state.workspaces.slice(0, 1);
  return kept.map((workspace, index) => ({
    id: workspace.id,
    name: nameOf(workspace, known.get(workspace.id), index + 1),
    position: index,
    columns: workspace.columns.map((column) => ({
      id: column.id,
      // A column wider than the strip is stored at full width, the most a share can hold.
      width: Math.min(1, column.width),
      panes: column.panes.map((pane) => ({
        id: pane.id,
        size: pane.size,
        activeTabId: pane.activeTabId,
        tabs: pane.tabs.map((tab): HoustonLayoutTab => ({
          id: tab.id,
          content: tabContentToRecord(tab.content),
        })),
      })),
    })),
    pinnedAt: null,
    hidden: false,
    createdAt: known.get(workspace.id)?.createdAt ?? now,
    revision: 0,
    updatedAt: now,
  }));
}

/** The stored content of a workspace, so a local change and the server's copy can be compared. */
export function layoutRecordContentKey(
  record: Pick<HoustonLayoutWorkspaceRecord, "name" | "columns">,
): string {
  return JSON.stringify([record.name, record.columns]);
}

/**
 * The layout the server's workspaces make. Focus, the camera width and ghost marks belong to
 * this window and carry over from `previous`; `ghostTabIds` names the tabs that are ghosts.
 */
export function layoutStateFromRecords(
  records: ReadonlyArray<HoustonLayoutWorkspaceRecord>,
  previous: LayoutState | null,
  ghostTabIds: ReadonlySet<string>,
): LayoutState {
  const before = new Map(
    (previous?.workspaces ?? []).map((workspace) => [workspace.id, workspace]),
  );
  const ordered = records.toSorted((a, b) => a.position - b.position);
  const workspaces: LayoutWorkspace[] = ordered.map((record) => {
    const local = before.get(record.id);
    const columns: LayoutColumn[] = record.columns.map((column) => ({
      id: column.id,
      width: column.width,
      panes: column.panes.map((pane): LayoutPane => ({
        id: pane.id,
        size: pane.size,
        activeTabId: pane.activeTabId,
        tabs: pane.tabs.map((tab): LayoutTab => {
          const base = { id: tab.id, content: tabContentFromRecord(tab.content) };
          return ghostTabIds.has(tab.id) ? { ...base, ghostOf: null } : base;
        }),
      })),
    }));
    return {
      id: record.id,
      name: record.name,
      columns,
      focusedPaneId: local?.focusedPaneId ?? null,
      cameraWidth: local?.cameraWidth ?? null,
    };
  });
  const recordIds = new Set(workspaces.map((workspace) => workspace.id));
  // The strip's empty trailing workspace is not stored; keep the one the window already has.
  const emptyBefore = previous?.workspaces.find(
    (workspace) => workspace.columns.length === 0 && !recordIds.has(workspace.id),
  );
  const withEmpty = emptyBefore ? [...workspaces, emptyBefore] : workspaces;
  const focusedWorkspaceId =
    previous !== null && withEmpty.some((w) => w.id === previous.focusedWorkspaceId)
      ? previous.focusedWorkspaceId
      : (withEmpty[0]?.id ?? "");
  return normalizeLayout({ workspaces: withEmpty, focusedWorkspaceId });
}
