import type { EnvironmentId, ProjectId, ThreadId } from "@houston-app/contracts";
import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { useRouter } from "@tanstack/react-router";

import { useStableCallback } from "../hooks/useStableCallback";
import { openThreadInLayout } from "./openThreadInLayout";

/** Shows the thread in the layout: its existing tab takes focus, or one opens for it. */
export function useOpenThread(): (input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly threadId: ThreadId;
}) => Promise<void> {
  const router = useRouter();
  return useStableCallback(
    (input: {
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId | null;
      readonly threadId: ThreadId;
    }) =>
      openThreadInLayout(
        {
          navigate: (options) => router.navigate(options),
          pathname: () => router.state.location.pathname,
        },
        scopeThreadRef(input.environmentId, input.threadId),
      ),
  );
}
