import type { ScopedThreadRef } from "@houston-app/contracts";
import { useParams } from "@tanstack/react-router";

import { selectFocusedChatTab } from "../layout/layoutModel";
import { useLayoutStore } from "../layout/layoutStore";

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
 * The route's thread target, or the chat the layout has focused. Palette thread actions read
 * this so they act on the pane on screen.
 */
export function useActiveThreadRouteTarget(): ThreadRouteTarget | null {
  const routeTarget = useThreadRouteTarget();
  const focused = useLayoutStore((state) => selectFocusedChatTab(state.layout));
  if (routeTarget !== null) return routeTarget;
  return focused?.tab.content.kind === "chat" ? focused.tab.content.target : null;
}
