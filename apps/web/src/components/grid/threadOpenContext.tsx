import type { ScopedThreadRef } from "@houston-app/contracts";
import { useNavigate } from "@tanstack/react-router";
import { createContext, useContext, type ReactNode } from "react";

import type { ThreadOpenIntent } from "../../grid/gridThreadOpen";
import { buildThreadRouteParams } from "../../threadRoutes";

type ThreadOpen = (ref: ScopedThreadRef, intent?: ThreadOpenIntent) => void;

// How a thread view opens another thread: a single-thread route navigates; a grid cell or
// empty grid places it inside its own grid by intent (`peek` when omitted).
const ThreadOpenContext = createContext<ThreadOpen | null>(null);

export function ThreadOpenProvider({ open, children }: { open: ThreadOpen; children: ReactNode }) {
  return <ThreadOpenContext value={open}>{children}</ThreadOpenContext>;
}

export function useThreadOpen(): ThreadOpen {
  const navigate = useNavigate();
  const provided = useContext(ThreadOpenContext);
  if (provided !== null) return provided;
  return (ref) =>
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
}
