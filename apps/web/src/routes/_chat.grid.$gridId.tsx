import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { focusWorkspaceInLayout } from "../layout/openWorkspaceInLayout";

export const Route = createFileRoute("/_chat/grid/$gridId")({
  component: GridToWorkspaceRedirect,
});

/** A grid link opens the workspace that carries the grid's id, on every screen size. */
function GridToWorkspaceRedirect() {
  const { gridId } = Route.useParams();
  const navigate = useNavigate();
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- focuses the workspace with the grid's id once, then leaves the retired route
  useEffect(() => {
    // A grid id with no workspace leaves the focused one in place.
    focusWorkspaceInLayout(gridId);
    void navigate({ to: "/", replace: true });
  }, [gridId, navigate]);
  return null;
}
