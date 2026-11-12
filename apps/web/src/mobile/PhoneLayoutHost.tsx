import { useEffect, useRef, useState } from "react";

import { LayoutLauncher } from "../layout/LayoutLauncher";
import { LayoutSurfaceServices } from "../layout/LayoutSurfaceServices";
import { type LayoutPane, type LayoutTab, selectFocusedPane } from "../layout/layoutModel";
import type { LayoutPaneState } from "../layout/layoutPaneContext";
import { threadKeysOfTabs } from "../layout/layoutThreadRef";
import { useLayoutStore } from "../layout/layoutStore";
import { useLayoutSurfaceSync } from "../layout/surfaceSync";
import { useLayoutRouteSync } from "../layout/useLayoutRouteSync";
import { useLayoutTabLabel } from "../layout/useLayoutTabLabel";
import { useLayoutTabRenderer } from "../layout/useLayoutTabRenderer";
import { LayoutPaneContext } from "../layout/layoutPaneContext";
import { SidebarInset } from "../components/ui/sidebar";
import type { ThreadRouteTarget } from "../threadRoutes";
import { PhonePaneBar } from "./PhonePaneBar";
import { PhoneThreadHostContext } from "./phoneThreadHost";

/**
 * The phone's main area while a thread is open: the layout's focused pane, one tab at a time,
 * under the phone bar. It draws tabs through the renderer the desktop strip uses. Nothing draws
 * before the first layout snapshot.
 */
export function PhoneLayoutHost(props: {
  /** The thread the URL names; the layout shows it. */
  readonly threadTarget: ThreadRouteTarget | null;
  /** False while a page other than the layout's own covers the thread. */
  readonly active: boolean;
}) {
  const loaded = useLayoutStore((state) => state.layoutLoaded);
  return loaded ? <LoadedPhoneLayoutHost {...props} /> : null;
}

function sameIds(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * The chat tabs of the shown pane that have been on screen, so leaving one for a surface and
 * coming back keeps its timeline and scroll. Switching to another pane starts over.
 */
function useRetainedChatTabs(pane: LayoutPane | null, activeTabId: string | null): string[] {
  const [retained, setRetained] = useState<{ paneId: string | null; ids: string[] }>({
    paneId: null,
    ids: [],
  });
  const paneId = pane?.id ?? null;
  const chatIds = new Set(
    (pane?.tabs ?? []).filter((tab) => tab.content.kind === "chat").map((tab) => tab.id),
  );
  const next = (retained.paneId === paneId ? retained.ids : []).filter((id) => chatIds.has(id));
  if (activeTabId !== null && chatIds.has(activeTabId) && !next.includes(activeTabId)) {
    next.push(activeTabId);
  }
  if (retained.paneId !== paneId || !sameIds(next, retained.ids))
    setRetained({ paneId, ids: next });
  return next;
}

function LoadedPhoneLayoutHost({
  threadTarget,
  active,
}: {
  readonly threadTarget: ThreadRouteTarget | null;
  readonly active: boolean;
}) {
  const layout = useLayoutRouteSync(threadTarget, false);
  useLayoutSurfaceSync();
  const tabLabel = useLayoutTabLabel();
  const renderTab = useLayoutTabRenderer(layout);
  const pane = selectFocusedPane(layout);
  const tabs = pane?.tabs ?? [];
  const activeTab = tabs.find((tab) => tab.id === pane?.activeTabId) ?? null;
  const retained = useRetainedChatTabs(pane, activeTab?.id ?? null);
  // Details belong to the tab that opened them: moving to another tab closes them.
  const [details, setDetails] = useState<{ tabId: string; open: boolean } | null>(null);
  const detailsAnchor = useRef<Element | null>(null);
  const activeTabId = activeTab?.id ?? null;

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- publishes the one tab on screen to the sidebar, and clears it when the host leaves
  useEffect(() => {
    if (!active || activeTabId === null) return;
    const { layout: current, setOnScreenThreadKeys } = useLayoutStore.getState();
    setOnScreenThreadKeys(threadKeysOfTabs(current, new Set([activeTabId])));
    return () => setOnScreenThreadKeys(new Set());
  }, [active, activeTabId]);

  const shown = tabs.filter((tab) => tab.id === activeTabId || retained.includes(tab.id));
  const stateOf = (tab: LayoutTab): LayoutPaneState => {
    const visible = active && tab.id === activeTabId;
    return {
      tabId: tab.id,
      paneId: pane?.id ?? null,
      split: false,
      narrow: false,
      leadingEdge: true,
      trailingEdge: true,
      focused: visible,
      related: false,
      visible,
      near: true,
      kept: true,
    };
  };

  return (
    <PhoneThreadHostContext
      value={{
        detailsOpen: details?.open === true && details.tabId === activeTabId,
        onDetailsOpenChange: (open) =>
          activeTabId === null ? undefined : setDetails({ tabId: activeTabId, open }),
        detailsAnchor,
        setDetailsAnchor: (node) => {
          detailsAnchor.current = node;
        },
      }}
    >
      <SidebarInset
        className="min-h-0 overflow-hidden overscroll-y-none"
        data-phone-layout-host=""
        inert={!active}
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col pb-safe">
          <PhonePaneBar
            paneId={pane?.id ?? null}
            tabs={tabs}
            activeTab={activeTab}
            tabLabel={tabLabel}
          />
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {activeTab === null ? <LayoutLauncher tabId={null} context={null} /> : null}
            {shown.map((tab) => {
              const state = stateOf(tab);
              return (
                <div
                  key={tab.id}
                  data-phone-tab-body={tab.id}
                  inert={!state.visible}
                  className={state.visible ? "flex min-h-0 min-w-0 flex-1 flex-col" : "hidden"}
                >
                  <LayoutPaneContext value={state}>{renderTab(tab, state)}</LayoutPaneContext>
                </div>
              );
            })}
          </div>
        </div>
      </SidebarInset>
      <LayoutSurfaceServices />
    </PhoneThreadHostContext>
  );
}
