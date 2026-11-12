import type { ScopedThreadRef } from "@houston-app/contracts";
import type { RefObject } from "react";

import type { DraftId } from "../../composerDraftStore";
import { useLayoutPane } from "../../layout/layoutPaneContext";
import type { PaneDensity } from "../../threads/density";
import ChatView, { type RightPanelPortalTarget } from "../ChatView";

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
  rightPanelPortal,
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
  /** Where the focused chat mounts its thread's right panel, when the host owns one. */
  readonly rightPanelPortal?: RightPanelPortalTarget | null | undefined;
  readonly detailsCardAnchor?: RefObject<Element | null> | null | undefined;
  readonly detailsOpen?: boolean | undefined;
  readonly onDetailsOpenChange?: ((open: boolean) => void) | undefined;
  /** A host terminal dock takes this chat's terminal toggle and chords. */
  readonly hostTerminalRef?: ScopedThreadRef | null | undefined;
  readonly phoneShell?: boolean | undefined;
}) {
  const { focused, visible, tabId } = useLayoutPane();
  const shared = {
    embedded: true as const,
    shortcutsAtWindow: focused,
    visitActive: focused && visible,
    hostTerminalRef: hostTerminalRef ?? null,
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
    ...(paneDensity === undefined ? {} : { paneDensity }),
    rightPanelPortal: rightPanelPortal ?? null,
    ...(detailsCardAnchor ? { detailsCardAnchor } : {}),
    ...(detailsOpen === undefined ? {} : { detailsOpen }),
    ...(onDetailsOpenChange === undefined ? {} : { onDetailsOpenChange }),
    phoneShell: phoneShell ?? false,
    // A layout pane's chat carries its own header; the grid cell and the phone shell draw theirs.
    paneHeader: tabId !== null && phoneShell !== true,
  };
  return draftId === undefined ? (
    <ChatView {...shared} routeKind="server" />
  ) : (
    <ChatView {...shared} draftId={draftId} routeKind="draft" />
  );
}
