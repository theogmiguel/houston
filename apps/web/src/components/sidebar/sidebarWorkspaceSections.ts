import { scopedThreadKey, scopeThreadRef } from "@houston-app/client-runtime/environment";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { effectiveSnoozed } from "@houston-app/client-runtime/state/thread-settled";
import { sortThreads } from "@houston-app/client-runtime/state/thread-sort";
import type { SidebarGridThreadSortOrder } from "@houston-app/contracts/settings";
import { workspaceKeyOf } from "@houston-app/shared/grid/record";

import type { LayoutState, LayoutWorkspace } from "../../layout/layoutModel";
import { listLayoutWorkspaces, workspaceDisplayName } from "../../layout/layoutWorkspaces";
import { pinnedThreadsFirst } from "../../threads/rail";
import { threadMatchesSidebarSearch } from "../../threads/sidebarModel";
import { isSidebarHiddenThread } from "../Sidebar.logic";

export interface SidebarWorkspaceSection {
  readonly workspaceId: string;
  readonly name: string;
  readonly pinned: boolean;
  readonly hidden: boolean;
  /** The workspace holds no chat tab; it is listed because the user is on it. */
  readonly empty: boolean;
  /** The rows the section draws, in order. */
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  /** Threads the "Needs you" section already lists; the section counts them in one line. */
  readonly needsYouThreads: ReadonlyArray<EnvironmentThreadShell>;
}

export interface SidebarWorkspaceSections {
  /** Pinned workspaces first, then the rest, each group in the layout's order. */
  readonly sections: ReadonlyArray<SidebarWorkspaceSection>;
  /** Hidden workspaces, for the menu that shows them again. Never searched. */
  readonly hiddenSections: ReadonlyArray<SidebarWorkspaceSection>;
  /** Threads that no workspace shows a chat for; they were put under the first workspace. */
  readonly unplacedThreadIds: ReadonlyArray<string>;
}

export interface SidebarWorkspaceSectionsInput {
  readonly layout: LayoutState;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly threadSort: SidebarGridThreadSortOrder;
  readonly nowIso: string;
  readonly query: string;
  /** `workspaceKeyOf` keys of the projects the rail shows; null shows every project. */
  readonly projectKeys: ReadonlySet<string> | null;
  /** Threads lifted into the "Needs you" section, so their workspaces do not repeat them. */
  readonly excludedThreadIds: ReadonlySet<string> | undefined;
  /** The title of a workspace without a name, such as its lead tab's title. */
  readonly resolveWorkspaceTitle?: ((workspace: LayoutWorkspace) => string | null) | undefined;
}

/** Threads that still belong on the rail: not archived, deleted, closed, held or a subagent child. */
export function isRailThread(thread: EnvironmentThreadShell, nowIso: string): boolean {
  return (
    thread.archivedAt === null &&
    thread.deletedAt === null &&
    thread.settledOverride !== "settled" &&
    !isSidebarHiddenThread(thread) &&
    !effectiveSnoozed(thread, { now: nowIso })
  );
}

/** Each thread's workspace, by `scopedThreadKey`, and the order its chat tabs sit in the layout. */
function chatPlacement(layout: LayoutState): { workspaceOf: Map<string, string>; order: string[] } {
  const workspaceOf = new Map<string, string>();
  const order: string[] = [];
  for (const workspace of layout.workspaces) {
    for (const column of workspace.columns) {
      for (const pane of column.panes) {
        for (const tab of pane.tabs) {
          if (tab.content.kind !== "chat" || tab.content.target.kind !== "server") continue;
          const key = scopedThreadKey(tab.content.target.threadRef);
          if (workspaceOf.has(key)) continue;
          workspaceOf.set(key, workspace.id);
          order.push(key);
        }
      }
    }
  }
  return { workspaceOf, order };
}

function sortRows(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  order: SidebarGridThreadSortOrder,
): EnvironmentThreadShell[] {
  return pinnedThreadsFirst(order === "grid" ? threads : sortThreads(threads, order));
}

const keyOf = (thread: EnvironmentThreadShell) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

/**
 * The rail's groups: the layout's workspaces, each with the threads whose chat tab it holds. A
 * thread no workspace shows goes under the first workspace, as the server places it, and is
 * reported in `unplacedThreadIds`.
 */
export function buildSidebarWorkspaceSections(
  input: SidebarWorkspaceSectionsInput,
): SidebarWorkspaceSections {
  const query = input.query.trim().toLocaleLowerCase();
  // The "Needs you" section only lifts rows while the rail is not searching; a search still finds
  // every thread where it lives.
  const excluded = query.length === 0 ? input.excludedThreadIds : undefined;
  const workspaces = listLayoutWorkspaces(input.layout);
  const first = workspaces[0];
  if (first === undefined) return { sections: [], hiddenSections: [], unplacedThreadIds: [] };

  const { workspaceOf, order } = chatPlacement(input.layout);
  const position = new Map(order.map((key, index) => [key, index]));
  const listed = new Set(workspaces.map((workspace) => workspace.id));
  const rows = input.threads
    .filter(
      (thread) =>
        isRailThread(thread, input.nowIso) &&
        (input.projectKeys === null ||
          input.projectKeys.has(workspaceKeyOf(thread.environmentId, thread.projectId))),
    )
    .toSorted(
      (left, right) =>
        (position.get(keyOf(left)) ?? Number.POSITIVE_INFINITY) -
        (position.get(keyOf(right)) ?? Number.POSITIVE_INFINITY),
    );

  const byWorkspace = new Map<string, EnvironmentThreadShell[]>();
  const unplacedThreadIds: string[] = [];
  for (const thread of rows) {
    const placed = workspaceOf.get(keyOf(thread));
    // A chat in the empty workspace the strip keeps at the bottom is placed there but not listed.
    const home = placed !== undefined && listed.has(placed) ? placed : first.id;
    if (placed === undefined) unplacedThreadIds.push(thread.id);
    const bucket = byWorkspace.get(home) ?? [];
    bucket.push(thread);
    byWorkspace.set(home, bucket);
  }

  const build = (workspace: LayoutWorkspace): SidebarWorkspaceSection | null => {
    const name = workspaceDisplayName(
      workspace,
      input.layout.workspaces.indexOf(workspace),
      input.resolveWorkspaceTitle,
    );
    const hidden = workspace.hidden ?? false;
    const nameMatches = query.length > 0 && name.toLocaleLowerCase().includes(query);
    const matched = (byWorkspace.get(workspace.id) ?? []).filter(
      (thread) =>
        query.length === 0 ||
        nameMatches ||
        threadMatchesSidebarSearch(
          { title: thread.title, branch: thread.branch, pullRequests: thread.pullRequests },
          query,
        ),
    );
    const lifted =
      excluded === undefined ? [] : matched.filter((thread) => excluded.has(thread.id));
    const shown = sortRows(
      excluded === undefined ? matched : matched.filter((thread) => !excluded.has(thread.id)),
      input.threadSort,
    );
    if (query.length > 0 && !nameMatches && shown.length === 0) return null;
    return {
      workspaceId: workspace.id,
      name,
      pinned: (workspace.pinnedAt ?? null) !== null,
      hidden,
      empty: workspace.columns.length === 0,
      threads: shown,
      needsYouThreads: lifted,
    };
  };

  const all = workspaces.flatMap((workspace) => {
    const built = build(workspace);
    return built === null ? [] : [built];
  });
  const shownSections = all.filter((section) => !section.hidden);
  return {
    sections: [
      ...shownSections.filter((section) => section.pinned),
      ...shownSections.filter((section) => !section.pinned),
    ],
    hiddenSections: all.filter((section) => section.hidden),
    unplacedThreadIds,
  };
}
