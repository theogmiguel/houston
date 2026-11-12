import type { ScopedThreadRef } from "@houston-app/contracts";
import { scopedThreadKey } from "@houston-app/client-runtime/environment";
import { useRouter } from "@tanstack/react-router";

import { requestReopenClosedView } from "../components/ReopenClosedViewShortcut";
import { readLocalApi } from "../localApi";
import { openThreadInLayout } from "../threads/openThreadInLayout";
import type { ThreadOpenIntent } from "../threads/threadOpenContext";
import type { ThreadRouteTarget } from "../threadRoutes";
import { chatTargetThreadRef } from "./layoutThreadRef";
import { ClosedTabRestoreButton } from "./ClosedTabRestore";
import { LayoutHints } from "./LayoutHint";
import { LayoutOnboarding } from "./LayoutOnboarding";
import { LayoutOverview } from "./LayoutOverview";
import { LayoutShortcutsOverlay } from "./LayoutShortcutsOverlay";
import { useThreeFingerSwipe } from "./useThreeFingerSwipe";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { LayoutChatTab } from "./LayoutChatTab";
import { LayoutLauncher } from "./LayoutLauncher";
import { openLayoutNewTab } from "./layoutActions";
import { layoutChatRoute } from "./layoutChatRoute";
import { selectFocusedTab, type LayoutTab, type LayoutWorkspace } from "./layoutModel";
import { LayoutPaneContext } from "./layoutPaneContext";
import { LayoutPageTab } from "./LayoutPageTab";
import { useLayoutStore } from "./layoutStore";
import {
  buildLayoutTabMenuItems,
  isLayoutTabMenuId,
  runLayoutTabMenuAction,
} from "./layoutTabMenu";
import { LayoutSurfaceTab } from "./LayoutSurfaceTab";
import { useLayoutRouteSync } from "./useLayoutRouteSync";
import { useLayoutTabLabel } from "./useLayoutTabLabel";
import { useLayoutSurfaceSync } from "./surfaceSync";
import { LayoutWorkspaceStrip, type LayoutTabRenderContext } from "./WorkspaceStrip";

interface LayoutHostProps {
  /** The thread the URL names, or null on the index and on page routes. */
  readonly threadTarget: ThreadRouteTarget | null;
  readonly atIndex: boolean;
  /** False while a page other than the layout's own fills the main area. */
  readonly active: boolean;
  /** One pane fills the window; the strip's own breakpoint decides when this is left out. */
  readonly narrow?: boolean;
}

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
  const focusedContent = selectFocusedTab(layout)?.content ?? null;
  const focusedSurfaceThread = focusedContent?.kind === "surface" ? focusedContent.threadRef : null;
  const focusedSurfaceKey =
    focusedSurfaceThread === null ? null : scopedThreadKey(focusedSurfaceThread);

  const openThread = (
    ref: ScopedThreadRef,
    intent: ThreadOpenIntent | undefined,
    from: ScopedThreadRef | null,
  ) =>
    void openThreadInLayout(
      {
        navigate: (options) => router.navigate(options),
        pathname: () => router.state.location.pathname,
      },
      ref,
      { intent, from },
    );

  const renderTab = (tab: LayoutTab, context: LayoutTabRenderContext) => {
    const content = tab.content;
    const body = (() => {
      switch (content.kind) {
        case "chat":
          return (
            <LayoutChatTab
              tab={tab}
              target={content.target}
              split={context.split}
              onOpenThread={openThread}
            />
          );
        case "surface":
          return <LayoutSurfaceTab content={content} />;
        case "launcher":
          return <LayoutLauncher tabId={tab.id} context={content.context} />;
        default:
          return <LayoutPageTab content={content} />;
      }
    })();
    const thread = content.kind === "chat" ? chatTargetThreadRef(content.target) : null;
    const related =
      thread !== null &&
      focusedSurfaceKey !== null &&
      scopedThreadKey(thread) === focusedSurfaceKey;
    // The strip reports `related: false`; a chat whose surface has focus overrides it here.
    return related ? (
      <LayoutPaneContext value={{ ...context, related: true }}>{body}</LayoutPaneContext>
    ) : (
      body
    );
  };

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
        windowBarTrailing={
          <>
            <ClosedTabRestoreButton reopen={requestReopenClosedView} />
            <WorkspaceSwitcher resolveWorkspaceTitle={resolveWorkspaceTitle} />
          </>
        }
        {...(narrow === undefined ? {} : { narrow })}
      />
      <LayoutHints resolveWorkspaceTitle={resolveWorkspaceTitle} />
      <LayoutOnboarding />
      {active ? <LayoutOverview /> : null}
      <LayoutShortcutsOverlay />
    </>
  );
}
