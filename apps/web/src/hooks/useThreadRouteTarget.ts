import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@houston-app/contracts";
import { useParams } from "@tanstack/react-router";

import { useGrid } from "../grid/gridStore";

import {
  resolveThreadRouteRef,
  resolveThreadRouteTarget,
  type ThreadRouteTarget,
} from "../threadRoutes";

function useThreadRouteIds() {
  const environmentId = useParams({ strict: false, select: (params) => params.environmentId });
  const threadId = useParams({ strict: false, select: (params) => params.threadId });
  return { environmentId, threadId };
}

export function useThreadRouteTarget(): ThreadRouteTarget | null {
  const { environmentId, threadId } = useThreadRouteIds();
  const draftId = useParams({ strict: false, select: (params) => params.draftId });
  return resolveThreadRouteTarget({ environmentId, threadId, draftId });
}

export function useThreadRouteRef(): ScopedThreadRef | null {
  return resolveThreadRouteRef(useThreadRouteIds());
}

/**
 * The route's thread target, or the focused cell's thread on a grid route.
 * Palette thread actions read this so they act on the pane on screen.
 */
export function useActiveThreadRouteTarget(): ThreadRouteTarget | null {
  const routeTarget = useThreadRouteTarget();
  const gridId = useParams({ strict: false, select: (params) => params.gridId });
  const grid = useGrid(typeof gridId === "string" ? gridId : null);
  if (routeTarget !== null) return routeTarget;
  if (grid === null || grid.focusedThreadId === null) return null;
  return {
    kind: "server",
    threadRef: scopeThreadRef(
      grid.environmentId as EnvironmentId,
      grid.focusedThreadId as ThreadId,
    ),
  };
}
