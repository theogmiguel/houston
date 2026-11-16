/**
 * Draws a chat late and lets go late. A chat is the expensive tab: it renders after its pane
 * comes near the strip's camera, one per task so typing never queues behind a workspace of them,
 * and it is released once the pane has left, unless it holds live work or the keyboard. Until
 * then, and after, a stand-in fills the pane.
 */
import { useEffect, useState, type ReactNode } from "react";

import { LayoutStandIn } from "../components/ui/layout-pane";
import type { ThreadRouteTarget } from "../threadRoutes";
import {
  chatHoldsLiveWork,
  queueChatRender,
  registerWaitingChat,
  renderWaitingChatNow,
} from "./chatRenderGate";
import { useLayoutPane } from "./layoutPaneContext";

/** An off-screen chat unmounts once it has stayed outside the kept set this long. */
const UNRENDER_DELAY_MS = 1500;

/** A modal dialog is open; dialogs portal out of their chat, so any one holds the chat. */
const OPEN_DIALOG_SELECTOR =
  '[aria-modal="true"]:is([role="dialog"], [role="alertdialog"]), [data-slot$="dialog-popup"][data-open]';

/** Set once the first chat pane of this page load has committed. */
let documentFirstFrameDrawn = false;

export function LayoutChatGate({
  target,
  children,
}: {
  readonly target: ThreadRouteTarget;
  /** The chat. It mounts when the gate lets it and unmounts when the gate lets it go. */
  readonly children: ReactNode;
}) {
  const { tabId, visible, near, kept, focused, related } = useLayoutPane();
  const wanted = visible && near;
  // The first frame after a load has no stand-in to hold steady, so the focused chat renders in it.
  const [rendered, setRendered] = useState(
    () => !documentFirstFrameDrawn && wanted && (focused || related),
  );
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Mark the document's first frame as committed so later panes keep the stand-in.
  useEffect(() => {
    documentFirstFrameDrawn = true;
  }, []);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Schedule the chat's first render through the shared queue and cancel it when the pane leaves.
  useEffect(() => {
    if (rendered || !wanted) return;
    return queueChatRender(() => setRendered(true), focused || related ? "focused" : "normal");
  }, [focused, related, rendered, wanted]);
  // A press or key that reaches the stand-in draws the chat now instead of waiting for its turn.
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Publish the synchronous render for input that arrives before the chat's turn.
  useEffect(() => {
    if (rendered || tabId === null) return;
    return registerWaitingChat(tabId, () => setRendered(true));
  }, [rendered, tabId]);
  // Outside the kept set it unmounts once the person has moved on, never while it has the keyboard,
  // live work or an open dialog. Its draft, scroll and terminal live outside it and come back.
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Delay unmounting an off-screen chat while DOM focus, dialogs or provider work still hold it.
  useEffect(() => {
    if (kept || related || !rendered) return;
    let timer = 0;
    const release = () => {
      const typing = document.activeElement?.closest("[data-layout-chat-tab]");
      const busy =
        typing?.getAttribute("data-layout-chat-tab") === tabId ||
        document.querySelector(OPEN_DIALOG_SELECTOR) !== null ||
        chatHoldsLiveWork(target);
      if (busy) timer = window.setTimeout(release, UNRENDER_DELAY_MS * 4);
      else setRendered(false);
    };
    timer = window.setTimeout(release, UNRENDER_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [kept, related, rendered, tabId, target]);
  return rendered ? (
    children
  ) : (
    <LayoutStandIn onPointerDownCapture={() => renderWaitingChatNow(tabId)} />
  );
}
