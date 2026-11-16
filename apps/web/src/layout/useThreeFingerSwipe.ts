import type { LayoutKeybindingCommand } from "@houston-app/contracts";
import { useEffect } from "react";

import { isMacPlatform } from "../lib/utils";
import { registerMenuAction } from "../shortcuts/dispatcher";
import { isLayoutModalOpen } from "./layoutKeyGuards";
import { runLayoutCommand } from "./layoutCommands";
import { getLayoutDeviceSettings } from "./layoutDeviceSettings";

/**
 * The desktop host reports which way the fingers moved. Fingers left bring in the column on the
 * right, fingers up bring in the workspace below, like dragging the strip itself.
 */
export const SWIPE_COMMANDS: Readonly<Record<string, LayoutKeybindingCommand>> = {
  "layout-swipe-left": "layout.focusRight",
  "layout-swipe-right": "layout.focusLeft",
  "layout-swipe-up": "layout.focusWorkspaceDown",
  "layout-swipe-down": "layout.focusWorkspaceUp",
};

/**
 * Opt-in three-finger swipes (Settings › Layout, macOS only): one flick moves one column or one
 * workspace. Only the macOS desktop host emits the swipe menu actions; Linux and Windows have no
 * equivalent gesture, and the layout keys and the two-finger scroll do the same there.
 */
export function useThreeFingerSwipe(active = true): void {
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Register desktop swipe menu actions for the mounted layout host.
  useEffect(() => {
    if (!active || !isMacPlatform(navigator.platform)) return;
    const disposers = Object.entries(SWIPE_COMMANDS).map(([action, command]) =>
      registerMenuAction(action, () => {
        if (getLayoutDeviceSettings().threeFingerSwipe && !isLayoutModalOpen()) {
          runLayoutCommand(command);
        }
      }),
    );
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, [active]);
}
