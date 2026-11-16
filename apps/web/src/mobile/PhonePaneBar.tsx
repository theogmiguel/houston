import { scopedThreadKey, scopeThreadRef } from "@houston-app/client-runtime/environment";
import type { ScopedThreadRef } from "@houston-app/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState, type ReactNode } from "react";

import { resolveThreadStatusPill } from "../components/Sidebar.logic";
import { ThreadStateGlyph } from "../components/ui/thread-state-glyph";
import { useStableCallback } from "../hooks/useStableCallback";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useThreadActionMenu } from "../hooks/useThreadActionMenu";
import { useThreadActions } from "../hooks/useThreadActions";
import { closeLayoutTabByUser, openLayoutNewTab } from "../layout/layoutActions";
import type { LayoutTab } from "../layout/layoutModel";
import { chatTargetThreadRef } from "../layout/layoutThreadRef";
import { useLayoutStore } from "../layout/layoutStore";
import type { LayoutTabLabel } from "../layout/PaneTabBar";
import { useQuietThreadShell, useQuietThreadShells } from "../state/entities";
import { PhoneThreadBar } from "./PhoneThreadBar";
import { PhoneTabsSheet } from "./PhoneTabsSheet";
import { usePhoneThreadHost } from "./phoneThreadHost";

/** The thread a tab belongs to: a chat's own, a surface's owner; none for a launcher or a page. */
function tabThreadRef(tab: LayoutTab | null): ScopedThreadRef | null {
  if (tab === null) return null;
  if (tab.content.kind === "chat") return chatTargetThreadRef(tab.content.target);
  return tab.content.kind === "surface" ? tab.content.threadRef : null;
}

/** A tab's mark: a thread's status glyph for its chat, the tab's own icon for anything else. */
function useTabMark(): (tab: LayoutTab, label: LayoutTabLabel) => ReactNode {
  const shells = useQuietThreadShells();
  const byKey = new Map(
    shells.map(
      (shell) => [scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id)), shell] as const,
    ),
  );
  return (tab, label) => {
    const ref = tab.content.kind === "chat" ? chatTargetThreadRef(tab.content.target) : null;
    const shell = ref === null ? null : (byKey.get(scopedThreadKey(ref)) ?? null);
    const status = shell === null ? null : resolveThreadStatusPill({ thread: shell });
    if (status === null) return label.icon ?? null;
    return (
      <span role="img" aria-label={status.label} className="inline-grid place-items-center">
        <ThreadStateGlyph state={status.state} colored />
      </span>
    );
  };
}

/**
 * The phone's bar over its one pane: the active tab and the pane's tab count open the sheet of
 * tabs; rename, details and the thread menu act on the thread the active tab belongs to.
 */
export function PhonePaneBar({
  paneId,
  tabs,
  activeTab,
  tabLabel,
}: {
  paneId: string | null;
  tabs: readonly LayoutTab[];
  activeTab: LayoutTab | null;
  tabLabel: (tab: LayoutTab) => LayoutTabLabel;
}) {
  const navigate = useNavigate();
  const host = usePhoneThreadHost();
  const markOf = useTabMark();
  const [sheetOpen, setSheetOpen] = useState(false);
  const threadRef = tabThreadRef(activeTab);
  const shell = useQuietThreadShell(threadRef);
  const { renameThread } = useThreadActions();
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const handleNewThread = useNewThreadHandler();

  const startRename = () => {
    if (shell === null) return;
    setRenameValue(shell.title);
    setRenaming(true);
  };
  const commitRename = () => {
    if (!renaming) return;
    setRenaming(false);
    const title = renameValue.trim();
    if (threadRef === null || title.length === 0 || title === shell?.title) return;
    void renameThread(threadRef, title);
  };
  const isServerThread =
    activeTab?.content.kind !== "chat" || activeTab.content.target.kind === "server";
  const { openMenu } = useThreadActionMenu({
    threadRef: isServerThread ? threadRef : null,
    thread: shell,
    onStartRename: useStableCallback(startRename),
    handleNewThread,
  });
  const openThreadMenu = () => {
    const rect = menuButtonRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    void openMenu({ x: rect.left, y: rect.bottom + 4 });
  };

  const label = activeTab === null ? null : tabLabel(activeTab);
  const detailsOpen = host?.detailsOpen === true;
  return (
    <>
      <PhoneThreadBar
        title={label?.title ?? "New tab"}
        mark={activeTab === null || label === null ? null : markOf(activeTab, label)}
        tabCount={tabs.length}
        {...(activeTab === null ? {} : { onOpenTabs: () => setSheetOpen(true) })}
        renaming={renaming}
        renameValue={renameValue}
        onChangeRename={setRenameValue}
        onCommitRename={commitRename}
        onCancelRename={() => setRenaming(false)}
        detailsOpen={detailsOpen}
        {...(host === null || activeTab?.content.kind !== "chat"
          ? {}
          : {
              onToggleDetails: () => host.onDetailsOpenChange(!detailsOpen),
              onDetailsRef: host.setDetailsAnchor,
            })}
        {...(isServerThread && threadRef !== null
          ? { menuButtonRef, onOpenMenu: openThreadMenu }
          : {})}
        onBack={() => void navigate({ to: "/" })}
      />
      <PhoneTabsSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        tabs={tabs.map((tab) => {
          const tabLabelOf = tabLabel(tab);
          return { id: tab.id, title: tabLabelOf.title, mark: markOf(tab, tabLabelOf) };
        })}
        activeTabId={activeTab?.id ?? null}
        onPick={(tabId) => useLayoutStore.getState().focusTab(tabId)}
        onClose={(tabId) => closeLayoutTabByUser(tabId)}
        onNewTab={() => {
          if (paneId !== null) useLayoutStore.getState().focusPane(paneId);
          openLayoutNewTab();
        }}
      />
    </>
  );
}
