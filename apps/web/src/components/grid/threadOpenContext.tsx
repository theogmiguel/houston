import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { createContext, useContext, type ReactNode } from "react";

import { buildThreadRouteParams } from "../../threadRoutes";

/**
 * How a thread view asks the app to open another thread. A single-thread route
 * navigates; a grid cell focuses (or adds) the thread inside its own grid.
 */
const ThreadOpenContext = createContext<((ref: ScopedThreadRef) => void) | null>(null);

export function ThreadOpenProvider({
  open,
  children,
}: {
  open: (ref: ScopedThreadRef) => void;
  children: ReactNode;
}) {
  return <ThreadOpenContext value={open}>{children}</ThreadOpenContext>;
}

export function useThreadOpen(): (ref: ScopedThreadRef) => void {
  const navigate = useNavigate();
  const provided = useContext(ThreadOpenContext);
  if (provided !== null) return provided;
  return (ref) =>
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
}
