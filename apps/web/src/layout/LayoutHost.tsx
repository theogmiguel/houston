import { scopedThreadKey } from "@houston-app/client-runtime/environment";
import { chatTabActions } from "./chatTabActions";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { readLocalApi } from "../localApi";
import type { ThreadRouteTarget } from "../threadRoutes";
import { threadKeysOfTabs } from "./layoutThreadRef";
import { LayoutHints } from "./LayoutHint";
import { LayoutOnboarding } from "./LayoutOnboarding";
import { LayoutOverview } from "./LayoutOverview";
import { LayoutDropZones } from "./DropZones";
import { LayoutShortcutsOverlay } from "./LayoutShortcutsOverlay";
import { useThreeFingerSwipe } from "./useThreeFingerSwipe";
import { LayoutLauncher } from "./LayoutLauncher";
import { setLayoutThreadDropListener } from "./layoutDrag";
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
import { listLayoutWorkspaces, workspaceDisplayName } from "./layoutWorkspaces";
import { useThreadMembershipStore } from "./threadMembership";
import { moveThreadToWorkspaceWithFeedback } from "../components/sidebar/workspaceMoveFeedback";
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

  const resolveWorkspaceTitle = (workspace: LayoutWorkspace) => {
    const lead = workspace.columns[0]?.panes[0]?.tabs[0];
    return lead ? tabLabel(lead).title : null;
  };

  const nameOf = (workspaceId: string) => {
    const { workspaces } = useLayoutStore.getState().layout;
    const index = workspaces.findIndex((workspace) => workspace.id === workspaceId);
    const workspace = workspaces[index];
    return workspace === undefined
      ? workspaceId
      : workspaceDisplayName(workspace, index, resolveWorkspaceTitle);
  };

  // A card dropped on a pane of another workspace moves the thread there; say so, and offer the
  // way back, like a drop on the sidebar does.
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- registers a module-level drop listener for the host's lifetime
  useEffect(
    () =>
      setLayoutThreadDropListener((drop) => {
        void moveThreadToWorkspaceWithFeedback({
          thread: {
            environmentId: drop.threadRef.environmentId,
            threadId: drop.threadRef.threadId,
          },
          threadTitle: drop.title,
          target: { workspaceId: drop.targetWorkspaceId, name: nameOf(drop.targetWorkspaceId) },
          nameOf,
          onOpenTarget: (id) => useLayoutStore.getState().focusWorkspace(id),
          placed: { previous: drop.previous },
        });
      }),
    [nameOf],
  );

  const onTabContextMenu = (tab: LayoutTab, position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return;
    const state = useLayoutStore.getState();
    const link = tab.content.kind === "chat" ? tab.content : null;
    const chat = link === null ? null : chatTabActions(tab.id);
    const workspaces = listLayoutWorkspaces(state.layout);
    const threadRef =
      tab.content.kind === "chat" && tab.content.target.kind === "server"
        ? tab.content.target.threadRef
        : null;
    const membership =
      threadRef === null
        ? undefined
        : useThreadMembershipStore.getState().byThread.get(scopedThreadKey(threadRef));
    // A thread that follows its parent, or one the server has not placed yet, cannot be moved.
    const canMove =
      threadRef !== null && membership !== undefined && membership.parentThreadId === null;
    const items = buildLayoutTabMenuItems(state.layout, tab.id, {
      maximizedTabId: state.maximizedTabId,
      canCopyLink: link !== null,
      canFindInThread: chat?.findInThread != null,
      canOpenProjectSettings: chat?.openProjectSettings != null,
      ...(canMove
        ? {
            moveToWorkspaceTargets: workspaces
              .filter((workspace) => workspace.id !== membership.workspaceId)
              .map((workspace) => ({ workspaceId: workspace.id, name: nameOf(workspace.id) })),
          }
        : {}),
    });
    if (items.length === 0) return;
    void api.contextMenu.show(items, position).then((action) => {
      if (action === null || !isLayoutTabMenuId(action)) return;
      runLayoutTabMenuAction(action, tab.id, {
        findInThread: () => chat?.findInThread?.(),
        openProjectSettings: () => chat?.openProjectSettings?.(),
        moveToWorkspace: (target, workspaceId) => {
          if (target.content.kind !== "chat" || target.content.target.kind !== "server") return;
          const ref = target.content.target.threadRef;
          void moveThreadToWorkspaceWithFeedback({
            thread: { environmentId: ref.environmentId, threadId: ref.threadId },
            threadTitle: tabLabel(target).title,
            target:
              workspaceId === "new-workspace"
                ? "new-workspace"
                : { workspaceId, name: nameOf(workspaceId) },
            nameOf,
            onOpenTarget: (id) => useLayoutStore.getState().focusWorkspace(id),
          });
        },
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
      {active ? <LayoutDropZones tabLabel={tabLabel} /> : null}
      <LayoutHints resolveWorkspaceTitle={resolveWorkspaceTitle} />
      <LayoutOnboarding />
      {active ? <LayoutOverview /> : null}
      <LayoutShortcutsOverlay />
      <LayoutSurfaceServices />
    </>
  );
}
