import type { ContextMenuItem } from "@houston-app/contracts";

import { closeLayoutTabByUser, closeOtherLayoutTabsByUser, splitLayoutTab } from "./layoutActions";
import {
  countLayoutTabs,
  findLayoutTab,
  isLayoutGhostTab,
  type LayoutState,
  type LayoutTab,
} from "./layoutModel";
import { useLayoutStore } from "./layoutStore";

export type LayoutTabMenuId =
  | "layout:keep"
  | "layout:split-right"
  | "layout:split-down"
  | "layout:new-column"
  | "layout:new-workspace"
  | "layout:fill"
  | "layout:find-in-thread"
  | "layout:project-settings"
  | "layout:copy-link"
  | "layout:close-tab"
  | "layout:close-other-tabs";

export interface LayoutTabMenuOptions {
  /** The tab whose pane fills the strip, if any: its fill item then undoes it. */
  maximizedTabId?: string | null;
  /** The caller can build a link for this tab (a thread's chat); the item runs `copyLink`. */
  canCopyLink?: boolean;
  /** The tab's chat can search its thread; the item runs `findInThread`. */
  canFindInThread?: boolean;
  /** The tab's chat has a project; the item runs `openProjectSettings`. */
  canOpenProjectSettings?: boolean;
}

/** The layout actions of a tab's context menu. Every tab can close. */
export function buildLayoutTabMenuItems(
  layout: LayoutState,
  tabId: string,
  options: LayoutTabMenuOptions = {},
): ContextMenuItem<LayoutTabMenuId>[] {
  const location = findLayoutTab(layout, (tab) => tab.id === tabId);
  if (!location) return [];
  const paneCount = location.workspace.columns.reduce(
    (sum, column) => sum + column.panes.length,
    0,
  );
  const hasSiblings = location.pane.tabs.length > 1;
  const items: ContextMenuItem<LayoutTabMenuId>[] = [];
  if (isLayoutGhostTab(location.tab)) {
    items.push({ id: "layout:keep", label: "Keep open", icon: "pin" });
  }
  items.push(
    { id: "layout:split-right", label: "Split right", icon: "panel-right" },
    { id: "layout:split-down", label: "Split down", icon: "panel-bottom" },
  );
  if (hasSiblings || paneCount > 1) {
    items.push({ id: "layout:new-column", label: "Move to a new column", icon: "columns-2" });
  }
  if (countLayoutTabs(layout) > 1) {
    items.push({ id: "layout:new-workspace", label: "Move to a new workspace", icon: "layers-2" });
  }
  if (paneCount > 1) {
    items.push({
      id: "layout:fill",
      label: options.maximizedTabId === tabId ? "Show every pane" : "Fill the window",
      icon: "maximize",
    });
  }
  const chatItems: ContextMenuItem<LayoutTabMenuId>[] = [];
  if (options.canFindInThread) {
    chatItems.push({ id: "layout:find-in-thread", label: "Find in thread", icon: "search" });
  }
  if (options.canOpenProjectSettings) {
    chatItems.push({ id: "layout:project-settings", label: "Project settings", icon: "settings" });
  }
  if (options.canCopyLink) {
    chatItems.push({ id: "layout:copy-link", label: "Copy link", icon: "link" });
  }
  const [firstChatItem, ...otherChatItems] = chatItems;
  if (firstChatItem) items.push({ ...firstChatItem, separatorBefore: true }, ...otherChatItems);
  items.push({
    id: "layout:close-tab",
    label: "Close",
    icon: "x",
    separatorBefore: !firstChatItem,
  });
  if (hasSiblings) {
    items.push({ id: "layout:close-other-tabs", label: "Close others", icon: "copy-x" });
  }
  return items;
}

export function isLayoutTabMenuId(id: string): id is LayoutTabMenuId {
  return id.startsWith("layout:");
}

export function runLayoutTabMenuAction(
  action: LayoutTabMenuId,
  tabId: string,
  handlers: {
    copyLink?: (tab: LayoutTab) => void;
    findInThread?: (tab: LayoutTab) => void;
    openProjectSettings?: (tab: LayoutTab) => void;
  } = {},
): void {
  const store = useLayoutStore.getState();
  const location = findLayoutTab(store.layout, (tab) => tab.id === tabId);
  if (!location) return;
  switch (action) {
    case "layout:keep":
      store.keepTab(tabId);
      return;
    case "layout:split-right":
      splitLayoutTab(tabId, "right");
      return;
    case "layout:split-down":
      splitLayoutTab(tabId, "down");
      return;
    case "layout:new-column":
      store.moveTab(tabId, {
        kind: "column",
        workspaceId: location.workspace.id,
        index: location.workspace.columns.indexOf(location.column) + 1,
      });
      return;
    case "layout:new-workspace":
      store.moveTabToNewWorkspace(tabId, store.layout.workspaces.indexOf(location.workspace) + 1);
      return;
    case "layout:fill":
      store.focusTab(tabId);
      store.toggleMaximizedTab(tabId);
      return;
    case "layout:find-in-thread":
      handlers.findInThread?.(location.tab);
      return;
    case "layout:project-settings":
      handlers.openProjectSettings?.(location.tab);
      return;
    case "layout:copy-link":
      handlers.copyLink?.(location.tab);
      return;
    case "layout:close-tab":
      closeLayoutTabByUser(tabId);
      return;
    case "layout:close-other-tabs":
      closeOtherLayoutTabsByUser(tabId);
      return;
  }
}
