import { AuthTerminalOperateScope, type ScopedThreadRef } from "@houston-app/contracts";
import { getTerminalLabel } from "@houston-app/shared/terminalLabels";

import { agentControlledBrowserCloseConfirmation } from "../components/ChatView.logic";
import { confirmTerminalClose } from "../lib/terminalCloseConfirm";
import { readLocalApi } from "../localApi";
import { readThreadPreviewState } from "../previewStateStore";
import {
  selectThreadRightPanelState,
  useRightPanelStore,
  type RightPanelSurface,
} from "../rightPanelStore";
import { readEnvironmentScope } from "../state/session";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { THREAD_TERMINAL_SURFACE_ID } from "./layoutModel";

/** What closing a surface ends beyond its tab; the host mounts the implementation. */
export interface SurfaceResourceServices {
  /** Ends one terminal session and deletes its history. */
  readonly closeTerminalSession: (threadRef: ScopedThreadRef, terminalId: string) => void;
  /** Ends the browser session or deletes the unused side chat that `surface` holds. */
  readonly releaseSurface: (threadRef: ScopedThreadRef, surface: RightPanelSurface) => void;
}

let services: SurfaceResourceServices | null = null;

/** The host's resource services; the returned function removes them again. */
export function registerSurfaceResourceServices(next: SurfaceResourceServices): () => void {
  services = next;
  return () => {
    if (services === next) services = null;
  };
}

/**
 * A user's close of a surface tab. A terminal (the thread's own or a panel's) asks first and ends
 * its sessions; an agent-driven browser asks first; every other surface closes at once. The
 * surface stores drop the surface, and the layout sync closes its tab.
 */
export async function closeThreadSurface(
  threadRef: ScopedThreadRef,
  surfaceId: string,
  options: { readonly bulk?: boolean } = {},
): Promise<void> {
  const canOperateTerminal = readEnvironmentScope(
    threadRef.environmentId,
    AuthTerminalOperateScope,
  );
  if (surfaceId === THREAD_TERMINAL_SURFACE_ID) {
    const terminals = useTerminalUiStateStore.getState();
    const { terminalIds } = selectThreadTerminalUiState(
      terminals.terminalUiStateByThreadKey,
      threadRef,
    );
    const [first, ...rest] = terminalIds.map(getTerminalLabel);
    if (canOperateTerminal && first !== undefined) {
      if (options.bulk !== true && !(await confirmTerminalClose([first, ...rest]))) return;
      for (const terminalId of terminalIds) {
        terminals.closeTerminal(threadRef, terminalId);
        services?.closeTerminalSession(threadRef, terminalId);
      }
    }
    terminals.setTerminalOpen(threadRef, false);
    return;
  }
  const surface = selectThreadRightPanelState(
    useRightPanelStore.getState().byThreadKey,
    threadRef,
  ).surfaces.find((candidate) => candidate.id === surfaceId);
  if (!surface) return;
  if (surface.kind === "preview") {
    const message = agentControlledBrowserCloseConfirmation(
      [surface],
      readThreadPreviewState(threadRef).desktopByTabId,
    );
    if (message !== null) {
      const confirmed = await readLocalApi()
        ?.dialogs.confirm(message, { variant: "destructive" })
        .catch(() => false);
      if (confirmed !== true) return;
    }
  }
  if (surface.kind === "terminal" && canOperateTerminal && options.bulk !== true) {
    const [first = "Terminal", ...rest] = surface.terminalIds.map(getTerminalLabel);
    if (!(await confirmTerminalClose([first, ...rest]))) return;
  }
  // Closed first so the close stays a user action that hides the panel after the last surface.
  useRightPanelStore.getState().closeSurface(threadRef, surface.id);
  if (surface.kind === "terminal" && canOperateTerminal) {
    for (const terminalId of surface.terminalIds) {
      useTerminalUiStateStore.getState().closeTerminal(threadRef, terminalId);
    }
  }
  services?.releaseSurface(threadRef, surface);
}
