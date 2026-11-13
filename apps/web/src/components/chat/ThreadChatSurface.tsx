import type { ScopedThreadRef } from "@houston-app/contracts";
import type { RefObject } from "react";

import type { DraftId } from "../../composerDraftStore";
import { useLayoutPane } from "../../layout/layoutPaneContext";
import { paneBarAnchor, usePaneBarSlot } from "../../layout/paneBarSlots";
import type { PaneDensity } from "../../threads/density";
import ChatView from "../ChatView";

/**
 * The chat of one thread, or of one draft of a thread, for a host that gives it a pane: the
 * timeline, composer, drafts and pending-input panels, without a page around it. The pane
 * context decides what the chat may do: only the focused pane runs window shortcuts, and only a
 * focused, visible one counts as visited.
 */
export function ThreadChatSurface({
  threadRef,
  draftId,
  paneDensity,
  detailsCardAnchor,
  detailsOpen,
  onDetailsOpenChange,
  hostTerminalRef,
  phoneShell,
}: {
  readonly threadRef: ScopedThreadRef;
  /** The thread is still a draft; the composer store holds its session. */
  readonly draftId?: DraftId | undefined;
  readonly paneDensity?: PaneDensity | undefined;
  readonly detailsCardAnchor?: RefObject<Element | null> | null | undefined;
  readonly detailsOpen?: boolean | undefined;
  readonly onDetailsOpenChange?: ((open: boolean) => void) | undefined;
  /** A host terminal dock takes this chat's terminal toggle and chords. */
  readonly hostTerminalRef?: ScopedThreadRef | null | undefined;
  readonly phoneShell?: boolean | undefined;
}) {
  const { focused, visible, tabId, paneId } = useLayoutPane();
  const paneBar = tabId !== null && phoneShell !== true;
  const barSlot = usePaneBarSlot(paneBar ? paneId : null);
  const barAnchor = paneBarAnchor(paneBar ? paneId : null);
  const shared = {
    embedded: true as const,
    shortcutsAtWindow: focused,
    visitActive: focused && visible,
    hostTerminalRef: hostTerminalRef ?? null,
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
    ...(paneDensity === undefined ? {} : { paneDensity }),
    ...(detailsCardAnchor
      ? { detailsCardAnchor }
      : barAnchor
        ? { detailsCardAnchor: barAnchor }
        : {}),
    ...(detailsOpen === undefined ? {} : { detailsOpen }),
    ...(onDetailsOpenChange === undefined ? {} : { onDetailsOpenChange }),
    phoneShell: phoneShell ?? false,
    // A layout pane's chat has no header row: its title is the tab, and its one control sits at
    // the trailing end of the pane's tab bar. The phone shell draws its own bar.
    paneHeader: paneBar,
    ...(paneBar ? { paneTabId: tabId, paneBarSlot: visible ? barSlot : null } : {}),
  };
  return draftId === undefined ? (
    <ChatView {...shared} routeKind="server" />
  ) : (
    <ChatView {...shared} draftId={draftId} routeKind="draft" />
  );
}
