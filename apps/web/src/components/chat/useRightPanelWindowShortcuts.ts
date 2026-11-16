import { scopedThreadKey } from "@houston-app/client-runtime/environment";
import type { ResolvedKeybindingsConfig, ScopedThreadRef } from "@houston-app/contracts";
import { useEffect } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { resolveShortcutCommand } from "../../keybindings";
import { useRightPanelStore } from "../../rightPanelStore";

/**
 * Window shortcuts for the right panel of the thread a host has in front: toggle, maximize and
 * the thread-details card. Embedded chats leave these to the host, which knows which thread
 * that is.
 */
export function useRightPanelWindowShortcuts({
  keybindings,
  getThreadRef,
  onToggleThreadDetails,
  onPanelClosed,
}: {
  readonly keybindings: ResolvedKeybindingsConfig;
  /** The thread whose panel the shortcut acts on, read when the key is pressed. */
  readonly getThreadRef: () => ScopedThreadRef | null;
  readonly onToggleThreadDetails: () => void;
  /** Runs after the shortcut closed the thread's open panel. */
  readonly onPanelClosed?: (() => void) | undefined;
}) {
  const readThreadRef = useStableCallback(getThreadRef);
  const toggleThreadDetails = useStableCallback(onToggleThreadDetails);
  const panelClosed = useStableCallback(onPanelClosed ?? (() => {}));

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- window keydown listener for the front thread's right panel shortcuts
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, { context: {} });
      if (
        command !== "rightPanel.toggle" &&
        command !== "rightPanel.toggleMaximized" &&
        command !== "threadPanel.toggle"
      )
        return;
      if (command === "threadPanel.toggle") {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        toggleThreadDetails();
        return;
      }
      const ref = readThreadRef();
      if (ref === null) return;
      const store = useRightPanelStore.getState();
      const threadPanel = store.byThreadKey[scopedThreadKey(ref)];
      if (command === "rightPanel.toggleMaximized" && threadPanel?.isOpen !== true) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (command === "rightPanel.toggle" && threadPanel?.isOpen === true) {
        store.setMaximized(ref, false);
        store.close(ref);
        panelClosed();
        return;
      }
      if (command === "rightPanel.toggle") {
        store.toggleVisibility(ref);
        return;
      }
      store.setMaximized(ref, threadPanel?.maximized !== true);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [keybindings, panelClosed, readThreadRef, toggleThreadDetails]);
}
