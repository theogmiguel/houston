import type {
  ResolvedKeybindingsConfig,
  ScopedProjectRef,
  ScopedThreadRef,
} from "@houston-app/contracts";

import { shortcutLabelForCommand } from "../../keybindings";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";
import {
  PersistentThreadTerminalDrawer,
  type PersistentTerminalLaunchContext,
} from "../PersistentThreadTerminals";

/**
 * The terminal of one thread ref, drawn as a drawer in whatever box holds it. The ref owns the
 * terminal's UI state and sessions, so the host decides which thread, or stand-in ref, it is.
 */
export function ThreadTerminalDock({
  threadRef,
  projectRef,
  launchContext,
  keybindings,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly projectRef: ScopedProjectRef;
  readonly launchContext: PersistentTerminalLaunchContext | null;
  readonly keybindings: ResolvedKeybindingsConfig;
}) {
  const terminalOpen = useTerminalUiStateStore(
    (state) =>
      selectThreadTerminalUiState(state.terminalUiStateByThreadKey, threadRef).terminalOpen,
  );
  const shortcutLabelOptions = {
    context: { terminalFocus: true, terminalOpen },
  };

  return (
    <PersistentThreadTerminalDrawer
      threadRef={threadRef}
      threadId={threadRef.threadId}
      active
      composerHeight={0}
      launchContext={launchContext}
      projectRef={projectRef}
      splitShortcutLabel={
        shortcutLabelForCommand(keybindings, "terminal.split", shortcutLabelOptions) ?? undefined
      }
      splitVerticalShortcutLabel={
        shortcutLabelForCommand(keybindings, "terminal.splitVertical", shortcutLabelOptions) ??
        undefined
      }
      newShortcutLabel={
        shortcutLabelForCommand(keybindings, "terminal.new", shortcutLabelOptions) ?? undefined
      }
      closeShortcutLabel={
        shortcutLabelForCommand(keybindings, "terminal.close", shortcutLabelOptions) ?? undefined
      }
      keybindings={keybindings}
    />
  );
}
