import { createFileRoute } from "@tanstack/react-router";

import { InferenceSettingsPanel } from "../components/settings/InferenceSettings";

export const Route = createFileRoute("/_chat/settings/inference")({
  validateSearch: (raw: Record<string, unknown>): { setup?: "local"; repair?: string } => ({
    ...(raw.setup === "local" ? { setup: "local" as const } : {}),
    ...(typeof raw.repair === "string" && raw.repair !== "" ? { repair: raw.repair } : {}),
  }),
  component: SettingsInferenceRoute,
});

function SettingsInferenceRoute() {
  const { setup, repair } = Route.useSearch();
  return <InferenceSettingsPanel openLocalSetup={setup === "local"} repairServerId={repair} />;
}
