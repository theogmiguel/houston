import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { ThreadId, type EnvironmentId, type ScopedThreadRef } from "@houston-app/contracts";

import { focusActiveDrawerTerminal } from "../lib/terminalFocus";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";

const GRID_TERMINAL_THREAD_PREFIX = "grid-terminal-";

/**
 * A grid's terminal belongs to no thread. Its UI state and sessions live under a
 * ref no thread can claim, so focusing another cell leaves them untouched.
 */
export function gridTerminalThreadRef(
  environmentId: EnvironmentId,
  gridId: string,
): ScopedThreadRef {
  return scopeThreadRef(environmentId, ThreadId.make(`${GRID_TERMINAL_THREAD_PREFIX}${gridId}`));
}

export function toggleGridTerminal(threadRef: ScopedThreadRef): void {
  const store = useTerminalUiStateStore.getState();
  const terminalUiState = selectThreadTerminalUiState(store.terminalUiStateByThreadKey, threadRef);
  store.setTerminalOpen(threadRef, !terminalUiState.terminalOpen);
  focusActiveDrawerTerminal(threadRef);
}
