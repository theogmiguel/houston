import { useRouter } from "@tanstack/react-router";

import { readLocalApi } from "../localApi";
import type { ThreadRouteTarget } from "../threadRoutes";
import { threadKeysOfTabs } from "./layoutThreadRef";
import { LayoutHints } from "./LayoutHint";
import { LayoutOnboarding } from "./LayoutOnboarding";
import { LayoutOverview } from "./LayoutOverview";
import { LayoutShortcutsOverlay } from "./LayoutShortcutsOverlay";
import { useThreeFingerSwipe } from "./useThreeFingerSwipe";
import { LayoutLauncher } from "./LayoutLauncher";
import { openLayoutNewTab } from "./layoutActions";
import { layoutChatRoute } from "./layoutChatRoute";
import { type LayoutTab, type LayoutWorkspace } from "./layoutModel";
import { LayoutSurfaceServices } from "./LayoutSurfaceServices";
import { useLayoutStore } from "./layoutStore";
import {
  buildLayoutTabMenuItems,
  isLayoutTabMenuId,
  runLayoutTabMenuAction,
} from "./layoutTabMenu";
import { useLayoutRouteSync } from "./useLayoutRouteSync";
import { useLayoutTabLabel } from "./useLayoutTabLabel";
import { useLayoutSurfaceSync } from "./surfaceSync";
import { LayoutWorkspaceStrip } from "./WorkspaceStrip";
import { useLayoutTabRenderer } from "./useLayoutTabRenderer";

interface LayoutHostProps {
  /** The thread the URL names, or null on the index and on page routes. */
  readonly threadTarget: ThreadRouteTarget | null;
  readonly atIndex: boolean;
  /** False while a page other than the layout's own fills the main area. */
  readonly active: boolean;
  /** One pane fills the window; the strip's own breakpoint decides when this is left out. */
  readonly narrow?: boolean;
}

/** A chat is the tab worth keeping mounted off screen. */
const retainsChat = (tab: LayoutTab) => tab.content.kind === "chat";

/** The main area of the chat routes. Nothing draws before the first layout snapshot. */
export function LayoutHost(props: LayoutHostProps) {
  const loaded = useLayoutStore((state) => state.layoutLoaded);
  return loaded ? <LoadedLayoutHost {...props} /> : null;
}

function LoadedLayoutHost({ threadTarget, atIndex, active, narrow }: LayoutHostProps) {
  const router = useRouter();
  const layout = useLayoutRouteSync(threadTarget, atIndex);
  useLayoutSurfaceSync();
  useThreeFingerSwipe(active);
  const tabLabel = useLayoutTabLabel();
  const renderTab = useLayoutTabRenderer(layout);

  const onAddTab = (paneId: string) => {
    useLayoutStore.getState().focusPane(paneId);
    openLayoutNewTab();
  };

  const onTabContextMenu = (tab: LayoutTab, position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return;
    const state = useLayoutStore.getState();
    const link = tab.content.kind === "chat" ? tab.content : null;
    const items = buildLayoutTabMenuItems(state.layout, tab.id, {
      maximizedTabId: state.maximizedTabId,
      canCopyLink: link !== null,
    });
    if (items.length === 0) return;
    void api.contextMenu.show(items, position).then((action) => {
      if (action === null || !isLayoutTabMenuId(action)) return;
      runLayoutTabMenuAction(action, tab.id, {
        copyLink: (target) => {
          if (target.content.kind !== "chat") return;
          const route = layoutChatRoute(target.content);
          const href = router.buildLocation(route).href;
          void navigator.clipboard.writeText(new URL(href, window.location.origin).toString());
        },
      });
    });
  };

  const onScreenTabsChange = (tabIds: ReadonlySet<string>) =>
    useLayoutStore
      .getState()
      .setOnScreenThreadKeys(threadKeysOfTabs(useLayoutStore.getState().layout, tabIds));

  const resolveWorkspaceTitle = (workspace: LayoutWorkspace) => {
    const lead = workspace.columns[0]?.panes[0]?.tabs[0];
    return lead ? tabLabel(lead).title : null;
  };

  return (
    <>
      <LayoutWorkspaceStrip
        layout={layout}
        renderTab={renderTab}
        tabLabel={tabLabel}
        onAddTab={onAddTab}
        onTabContextMenu={onTabContextMenu}
        empty={<LayoutLauncher tabId={null} context={null} />}
        active={active}
        onScreenTabsChange={onScreenTabsChange}
        retainTab={retainsChat}
        {...(narrow === undefined ? {} : { narrow })}
      />
      <LayoutHints resolveWorkspaceTitle={resolveWorkspaceTitle} />
      <LayoutOnboarding />
      {active ? <LayoutOverview /> : null}
      <LayoutShortcutsOverlay />
      <LayoutSurfaceServices />
    </>
  );
}
