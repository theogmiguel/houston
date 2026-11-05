import { scopeProjectRef } from "@houston-app/client-runtime/environment";
import {
  ProjectId,
  type EnvironmentId,
  type ResolvedKeybindingsConfig,
} from "@houston-app/contracts";
import { projectScriptCwd } from "@houston-app/shared/projectScripts";

import { gridTerminalThreadRef } from "../../grid/gridTerminal";
import type { GridRecord } from "../../grid/gridStore";
import { shortcutLabelForCommand } from "../../keybindings";
import { useProject } from "../../state/entities";
import { useTerminalUiStateStore, selectThreadTerminalUiState } from "../../terminalUiStateStore";
import {
  PersistentThreadTerminalDrawer,
  type PersistentTerminalLaunchContext,
} from "../PersistentThreadTerminals";

/**
 * The grid's one terminal, docked under the whole grid rather than inside a
 * cell. It runs in the grid's workspace root and belongs to no thread.
 */
export function GridTerminalDock({
  grid,
  keybindings,
}: {
  grid: GridRecord;
  keybindings: ResolvedKeybindingsConfig;
}) {
  const environmentId = grid.environmentId as EnvironmentId;
  const threadRef = gridTerminalThreadRef(environmentId, grid.id);
  const project = useProject(scopeProjectRef(environmentId, ProjectId.make(grid.projectId)));
  const cwd =
    project === null
      ? null
      : projectScriptCwd({ project: { cwd: project.workspaceRoot }, worktreePath: null });
  const launchContext: PersistentTerminalLaunchContext | null =
    cwd === null ? null : { cwd, worktreePath: null };
  const terminalOpen = useTerminalUiStateStore(
    (state) =>
      selectThreadTerminalUiState(state.terminalUiStateByThreadKey, threadRef).terminalOpen,
  );
  const shortcutLabelOptions = {
    context: { terminalFocus: true, terminalOpen },
  };

  return (
    <div data-grid-terminal-dock="" className="flex min-h-0 w-full min-w-0 flex-col">
      <PersistentThreadTerminalDrawer
        threadRef={threadRef}
        threadId={threadRef.threadId}
        active
        composerHeight={0}
        launchContext={launchContext}
        projectRef={scopeProjectRef(environmentId, ProjectId.make(grid.projectId))}
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
    </div>
  );
}
