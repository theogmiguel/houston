import { scopedThreadKey, scopeThreadRef } from "@houston-app/client-runtime/environment";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { effectiveSnoozed } from "@houston-app/client-runtime/state/thread-settled";
import { sortThreads } from "@houston-app/client-runtime/state/thread-sort";
import type { SidebarGridThreadSortOrder } from "@houston-app/contracts/settings";
import { projectKeyOf } from "@houston-app/shared/projectKey";

import type { LayoutState, LayoutWorkspace } from "../../layout/layoutModel";
import { listLayoutWorkspaces, workspaceDisplayName } from "../../layout/layoutWorkspaces";
import type { ThreadMembershipState } from "../../layout/threadMembership";
import { pinnedThreadsFirst } from "../../threads/rail";
import { threadMatchesSidebarSearch } from "../../threads/sidebarModel";
import { isSidebarHiddenThread } from "../Sidebar.logic";

export interface SidebarWorkspaceSection {
  readonly workspaceId: string;
  readonly name: string;
  readonly pinned: boolean;
  readonly hidden: boolean;
  /** The workspace has no tab open; it is listed because threads belong to it or the user is on it. */
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
}

export interface SidebarWorkspaceSectionsInput {
  readonly layout: LayoutState;
  /** The workspace each thread belongs to; a thread without an entry is not listed yet. */
  readonly memberships: ThreadMembershipState;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly threadSort: SidebarGridThreadSortOrder;
  readonly nowIso: string;
  readonly query: string;
  /** `projectKeyOf` keys of the projects the rail shows; null shows every project. */
  readonly projectKeys: ReadonlySet<string> | null;
  /** Threads lifted into the "Needs you" section, so their workspaces do not repeat them. */
  readonly excludedThreadIds: ReadonlySet<string> | undefined;
  /** Where each row last sat; without it a thread whose tab closed drops to the end. */
  readonly rowOrder?: SidebarRowOrderMemory | undefined;
  /** The title of a workspace without a name, such as its lead tab's title. */
  readonly resolveWorkspaceTitle?: ((workspace: LayoutWorkspace) => string | null) | undefined;
}

/**
 * The tab position each thread last held and when it took it. A thread that loses its tab keeps
 * its place, so two threads that take turns in one tab do not swap rows on every click.
 */
export interface SidebarRowOrderMemory {
  readonly slots: Map<string, { readonly position: number; readonly since: number }>;
  next: number;
}

export function createSidebarRowOrderMemory(): SidebarRowOrderMemory {
  return { slots: new Map(), next: 0 };
}

const UNPLACED = { position: Number.POSITIVE_INFINITY, since: Number.POSITIVE_INFINITY };

/** Records the positions the open tabs hold now and ranks a thread by the last one it held. */
function rowRanker(layout: LayoutState, memory: SidebarRowOrderMemory | undefined) {
  const slots = memory?.slots ?? new Map<string, { position: number; since: number }>();
  let next = memory?.next ?? 0;
  chatTabOrder(layout).forEach((key, position) => {
    if (slots.get(key)?.position !== position) slots.set(key, { position, since: next++ });
  });
  if (memory) memory.next = next;
  return (key: string) => slots.get(key) ?? UNPLACED;
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

/** The order the chat tabs sit in the layout, by `scopedThreadKey`; rows follow it. */
function chatTabOrder(layout: LayoutState): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const workspace of layout.workspaces) {
    for (const column of workspace.columns) {
      for (const pane of column.panes) {
        for (const tab of pane.tabs) {
          if (tab.content.kind !== "chat" || tab.content.target.kind !== "server") continue;
          const key = scopedThreadKey(tab.content.target.threadRef);
          if (seen.has(key)) continue;
          seen.add(key);
          order.push(key);
        }
      }
    }
  }
  return order;
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
 * The rail's groups: the layout's workspaces, each with the threads that belong to it. A thread
 * the server has not placed yet, or whose workspace the layout does not hold yet, is left out until
 * it is, so it never shows under one workspace and then jumps to another.
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
  if (first === undefined) return { sections: [], hiddenSections: [] };

  const rank = rowRanker(input.layout, input.rowOrder);
  const listed = new Set(workspaces.map((workspace) => workspace.id));
  const rows = input.threads
    .filter(
      (thread) =>
        isRailThread(thread, input.nowIso) &&
        (input.projectKeys === null ||
          input.projectKeys.has(projectKeyOf(thread.environmentId, thread.projectId))),
    )
    .toSorted((left, right) => {
      const [a, b] = [rank(keyOf(left)), rank(keyOf(right))];
      // Infinity minus Infinity is NaN, so equal positions are compared before subtracting.
      if (a.position !== b.position) return a.position - b.position;
      return a.since === b.since ? 0 : a.since - b.since;
    });

  const byWorkspace = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of rows) {
    const home = input.memberships.byThread.get(keyOf(thread))?.workspaceId;
    if (home === undefined || !listed.has(home)) continue;
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
  };
}
