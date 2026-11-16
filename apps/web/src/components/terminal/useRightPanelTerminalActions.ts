import { AuthTerminalOperateScope, type ScopedThreadRef } from "@houston-app/contracts";

import { useStableCallback } from "../../hooks/useStableCallback";
import { focusActivePanelTerminal, focusTerminal } from "../../lib/terminalFocus";
import {
  selectThreadRightPanelState,
  type RightPanelSurface,
  useRightPanelStore,
} from "../../rightPanelStore";
import { readEnvironmentScope } from "../../state/session";
import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import { MAX_TERMINALS_PER_GROUP } from "../../types";
import { useThreadTerminalActions } from "./useThreadTerminalActions";

/**
 * Adds, splits, activates and closes the terminals of a thread's right-panel terminal tabs.
 * `surface` is the tab the split and activate actions act on.
 */
export function useRightPanelTerminalActions(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly surface: RightPanelSurface | null;
}) {
  const { threadRef, surface } = input;
  const terminalActions = useThreadTerminalActions(threadRef);
  const storeCloseTerminal = useTerminalUiStateStore((state) => state.closeTerminal);

  const addTerminalSurface = () => {
    if (!threadRef) return;
    const launched = terminalActions.launchTerminal({
      place: (terminalId) => useRightPanelStore.getState().openTerminal(threadRef, terminalId),
    });
    if (!launched) return;
    focusTerminal(threadRef, launched.terminalId);
    void launched.result;
  };
  const addTerminalSurfaceStable = useStableCallback(addTerminalSurface);
  const splitPanelTerminal = (direction: "horizontal" | "vertical" = "horizontal") => {
    if (
      !threadRef ||
      surface?.kind !== "terminal" ||
      surface.terminalIds.length >= MAX_TERMINALS_PER_GROUP
    ) {
      return;
    }
    const surfaceId = surface.id;
    const launched = terminalActions.launchTerminal({
      place: (terminalId) =>
        useRightPanelStore.getState().splitTerminal(threadRef, surfaceId, terminalId, direction),
    });
    if (!launched) return;
    focusTerminal(threadRef, launched.terminalId);
    void launched.result;
  };
  const splitPanelTerminalStable = useStableCallback(splitPanelTerminal);
  const splitPanelTerminalVertical = () => {
    splitPanelTerminal("vertical");
  };
  const splitPanelTerminalVerticalStable = useStableCallback(splitPanelTerminalVertical);
  const activatePanelTerminal = (terminalId: string) => {
    if (!threadRef || surface?.kind !== "terminal") return;
    useRightPanelStore.getState().activateTerminal(threadRef, surface.id, terminalId);
    focusTerminal(threadRef, terminalId);
  };
  const activatePanelTerminalStable = useStableCallback(activatePanelTerminal);
  const closePanelTerminal = (terminalId: string, target = threadRef) => {
    if (!target || !readEnvironmentScope(target.environmentId, AuthTerminalOperateScope)) return;
    const store = useRightPanelStore.getState();
    const owner = selectThreadRightPanelState(store.byThreadKey, target).surfaces.find(
      (entry) => entry.kind === "terminal" && entry.terminalIds.includes(terminalId),
    );
    if (!owner) return;
    terminalActions.closeTerminalSession(terminalId, target);
    storeCloseTerminal(target, terminalId);
    store.closeTerminal(target, owner.id, terminalId);
    focusActivePanelTerminal(target);
  };
  const closePanelTerminalStable = useStableCallback(closePanelTerminal);

  return {
    addTerminalSurface,
    addTerminalSurfaceStable,
    splitPanelTerminal,
    splitPanelTerminalStable,
    splitPanelTerminalVerticalStable,
    activatePanelTerminalStable,
    closePanelTerminal,
    closePanelTerminalStable,
  };
}
