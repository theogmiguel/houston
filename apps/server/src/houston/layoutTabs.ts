// Pure edits of a workspace's tabs, shared by the layout service (which moves tabs together with
// a thread's membership) and the workspace toolkit (which opens and closes a thread's chat).
import {
  type HoustonLayoutColumn,
  type HoustonLayoutPane,
  type HoustonLayoutTab,
  type HoustonLayoutTabContent,
  type HoustonLayoutWorkspaceRecord,
  layoutTabContentKey,
} from "@houston-app/contracts/houston/layoutWorkspaces";

export const chatContentOf = (
  environmentId: string,
  threadId: string,
): HoustonLayoutTabContent => ({
  kind: "chat",
  target: { kind: "server", threadRef: { environmentId, threadId } },
});

export const tabsOf = (workspace: HoustonLayoutWorkspaceRecord) =>
  workspace.columns.flatMap((column) => column.panes.flatMap((pane) => pane.tabs));

export const findTab = (workspace: HoustonLayoutWorkspaceRecord, key: string) =>
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
export const withoutTab = (
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
 * `workspace` with `tab` at `at` when that pane is in it, else at the end of its last pane. A workspace with no column gets one, whose
 * pane shows the tab; in an existing pane the focused tab stays focused.
 */
export const withTabAppended = (
  workspace: HoustonLayoutWorkspaceRecord,
  tab: HoustonLayoutTab,
  stem: string,
  at?: { readonly paneId: string; readonly index?: number | undefined },
): HoustonLayoutWorkspaceRecord => {
  if (at !== undefined && workspace.columns.some((c) => c.panes.some((p) => p.id === at.paneId))) {
    return {
      ...workspace,
      columns: workspace.columns.map((column) => ({
        ...column,
        panes: column.panes.map((pane) => {
          if (pane.id !== at.paneId) return pane;
          const index = Math.min(at.index ?? pane.tabs.length, pane.tabs.length);
          return {
            ...pane,
            tabs: [...pane.tabs.slice(0, index), tab, ...pane.tabs.slice(index)],
          };
        }),
      })),
    };
  }
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

/** Where the tab showing `key` sits: its pane and its index in that pane. */
export const locateTab = (
  workspace: HoustonLayoutWorkspaceRecord,
  key: string,
): { readonly paneId: string; readonly index: number } | undefined => {
  for (const column of workspace.columns) {
    for (const pane of column.panes) {
      const index = pane.tabs.findIndex((tab) => layoutTabContentKey(tab.content) === key);
      if (index !== -1) return { paneId: pane.id, index };
    }
  }
  return undefined;
};
