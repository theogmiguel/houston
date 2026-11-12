import { scopeProjectRef } from "@houston-app/client-runtime/environment";
import {
  ProjectId,
  type EnvironmentId,
  type ResolvedKeybindingsConfig,
} from "@houston-app/contracts";
import { projectScriptCwd } from "@houston-app/shared/projectScripts";

import { gridTerminalThreadRef } from "../../grid/gridTerminal";
import type { GridRecord } from "../../grid/gridStore";
import { useProject } from "../../state/entities";
import type { PersistentTerminalLaunchContext } from "../PersistentThreadTerminals";
import { ThreadTerminalDock } from "../terminal/ThreadTerminalDock";

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
  const projectRef = scopeProjectRef(environmentId, ProjectId.make(grid.projectId));
  const project = useProject(projectRef);
  const cwd =
    project === null
      ? null
      : projectScriptCwd({ project: { cwd: project.workspaceRoot }, worktreePath: null });
  const launchContext: PersistentTerminalLaunchContext | null =
    cwd === null ? null : { cwd, worktreePath: null };

  return (
    <div data-grid-terminal-dock="" className="flex min-h-0 w-full min-w-0 flex-col">
      <ThreadTerminalDock
        threadRef={gridTerminalThreadRef(environmentId, grid.id)}
        projectRef={projectRef}
        launchContext={launchContext}
        keybindings={keybindings}
      />
    </div>
  );
}
