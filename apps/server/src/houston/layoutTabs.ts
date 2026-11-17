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

/** `workspace` without the tab showing `key`; a pane or column it empties goes, and a pane it
 * refocuses shows its first tab. The columns that stay take an emptied column's room, up to the
 * window's width: a strip that ran past the window fills it, a shorter one keeps its length. */
export const withoutTab = (
  workspace: HoustonLayoutWorkspaceRecord,
  key: string,
): HoustonLayoutWorkspaceRecord => {
  const columns = columnsWithoutTab(workspace.columns, key);
  if (columns.length === workspace.columns.length || columns.length === 0) {
    return { ...workspace, columns };
  }
  const sum = (list: ReadonlyArray<HoustonLayoutColumn>) =>
    list.reduce((total, column) => total + column.width, 0);
  const kept = sum(columns);
  const scale = kept > 0 ? Math.max(1, Math.min(1, sum(workspace.columns)) / kept) : 1;
  return {
    ...workspace,
    columns:
      scale === 1 ? columns : columns.map((column) => ({ ...column, width: column.width * scale })),
  };
};

const columnsWithoutTab = (
  columns: ReadonlyArray<HoustonLayoutColumn>,
  key: string,
): HoustonLayoutColumn[] =>
  columns.flatMap((column): HoustonLayoutColumn[] => {
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
  });

/** `workspace` with `tab` at `at` when that pane is in it, else at the end of its last pane. A
 * workspace with no column gets one, whose pane shows the tab; an existing pane keeps its focus. */
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

/** Whether `paneId` names a pane of `workspace`. */
export const hasPane = (workspace: HoustonLayoutWorkspaceRecord, paneId: string | undefined) =>
  paneId !== undefined && workspace.columns.some((c) => c.panes.some((p) => p.id === paneId));

/** The renderer's narrowest column, as a share of the strip; a new column never squeezes past it. */
const MIN_COLUMN_WIDTH = 0.2;

/** `workspace` with `tab` in a new column at the end, as wide as the others on average; the strip
 * shrinks its columns to fit the window, none below the narrowest the renderer draws. */
export const withTabInNewColumn = (
  workspace: HoustonLayoutWorkspaceRecord,
  tab: HoustonLayoutTab,
  stem: string,
): HoustonLayoutWorkspaceRecord => {
  const widths = workspace.columns.map((column) => column.width);
  const average =
    widths.length === 0 ? 1 : widths.reduce((sum, width) => sum + width, 0) / widths.length;
  const added: HoustonLayoutColumn = {
    id: `column:${stem}`,
    width: average,
    panes: [{ id: `pane:${stem}`, size: 1, activeTabId: tab.id, tabs: [tab] }],
  };
  const columns = [...workspace.columns, added];
  const total = columns.reduce((sum, column) => sum + column.width, 0);
  if (total <= 1) return { ...workspace, columns };
  return {
    ...workspace,
    columns: columns.map((column) => ({
      ...column,
      width: Math.max(Math.min(MIN_COLUMN_WIDTH, column.width), column.width / total),
    })),
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
