import type { ScopedThreadRef } from "@houston-app/contracts";

import { focusActiveDrawerTerminal } from "../../lib/terminalFocus";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";

/** Opens the terminal drawer of `threadRef` when closed, closes it when open, and focuses it. */
export function toggleTerminal(threadRef: ScopedThreadRef): void {
  const store = useTerminalUiStateStore.getState();
  const terminalUiState = selectThreadTerminalUiState(store.terminalUiStateByThreadKey, threadRef);
  store.setTerminalOpen(threadRef, !terminalUiState.terminalOpen);
  focusActiveDrawerTerminal(threadRef);
}
