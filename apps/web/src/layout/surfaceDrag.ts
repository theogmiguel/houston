import type { EnvironmentId, ScopedThreadRef } from "@houston-app/contracts";
import type { PointerEvent as ReactPointerEvent } from "react";

import { usePullRequestPreviewTarget } from "../lib/openPullRequestLink";
import { pullRequestSurfaceId, useRightPanelStore } from "../rightPanelStore";
import { beginLayoutSurfaceDrag } from "./layoutTabDrag";
import { layoutSurfacePlacementForDestination, requestLayoutSurfacePlacement } from "./surfaceSync";

export interface SurfaceDragProps {
  readonly onPointerDown?: ((event: ReactPointerEvent<HTMLElement>) => void) | undefined;
}

const NO_DRAG: SurfaceDragProps = {};

/**
 * A pull request chip or badge as a layout drag source. It offers the drag only when the
 * launcher could open the pull request: the link resolves to a project on an environment whose
 * server reads pull requests.
 */
export function usePullRequestSurfaceDrag({
  threadRef,
  environmentId,
  url,
  title,
  stopPropagation = false,
}: {
  readonly threadRef: ScopedThreadRef | null | undefined;
  readonly environmentId: EnvironmentId | null;
  readonly url: string;
  readonly title?: string | undefined;
  /** The sidebar row also drags; starting on the badge must not start both. */
  readonly stopPropagation?: boolean | undefined;
}): SurfaceDragProps {
  const target = usePullRequestPreviewTarget(environmentId, url);
  if (threadRef === null || threadRef === undefined || target === null) return NO_DRAG;
  const input = target.input;
  const panelTarget = {
    projectId: input.projectId,
    repository: input.repository,
    number: input.number,
    ...(input.host === undefined ? {} : { host: input.host }),
  };
  const surfaceId = pullRequestSurfaceId({
    ...panelTarget,
    // Mirrors the target `openPullRequest` stores: its id keeps an environment only when it
    // differs from the thread's.
    ...(target.environmentId !== threadRef.environmentId
      ? { environmentId: target.environmentId }
      : {}),
  });
  return {
    onPointerDown: (event) => {
      if (stopPropagation) event.stopPropagation();
      beginLayoutSurfaceDrag(event, {
        kind: "surface",
        threadRef,
        surfaceId,
        ...(title === undefined ? {} : { title }),
        open: (destination) => {
          requestLayoutSurfacePlacement(
            threadRef,
            layoutSurfacePlacementForDestination(destination),
          );
          useRightPanelStore.getState().openPullRequest(threadRef, {
            ...panelTarget,
            ...(target.environmentId !== threadRef.environmentId
              ? { environmentId: target.environmentId }
              : {}),
            url,
          });
        },
      });
    },
  };
}
