import { createFileRoute, Navigate } from "@tanstack/react-router";

import { UsagePage } from "../components/usage/UsagePage";
import { useIsPhone } from "../mobile/usePhone";

/** A phone keeps Usage as a page of its own; a desktop window shows it as a Settings section. */
function UsageRoute() {
  return useIsPhone() ? <UsagePage /> : <Navigate to="/settings/usage" replace />;
}

export const Route = createFileRoute("/_chat/usage")({
  component: UsageRoute,
});
