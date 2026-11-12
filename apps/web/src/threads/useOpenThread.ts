import type { EnvironmentId, ProjectId, ThreadId } from "@houston-app/contracts";
import { useNavigate } from "@tanstack/react-router";

import { useStableCallback } from "../hooks/useStableCallback";
import { resolveGridThreadTarget } from "../grid/gridNavigation";
import { useGridStore } from "../grid/gridStore";

/**
 * Lands in the thread's grid with its cell focused; the standalone route is the
 * fallback when no grid can take the thread.
 */
export function useOpenThread(): (input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly threadId: ThreadId;
}) => Promise<void> {
  const navigate = useNavigate();
  return useStableCallback(
    async (input: {
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId | null;
      readonly threadId: ThreadId;
    }) => {
      if (input.projectId !== null) {
        const target = resolveGridThreadTarget({
          environmentId: input.environmentId,
          projectId: input.projectId,
          threadId: input.threadId,
        });
        if (target !== null) {
          useGridStore.getState().focusThread(target.gridId, target.threadId);
          await navigate({ to: "/grid/$gridId", params: { gridId: target.gridId } });
          return;
        }
      }
      await navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: input.environmentId, threadId: input.threadId },
      });
    },
  );
}
