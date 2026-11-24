import { createFileRoute } from "@tanstack/react-router";

import { InferenceSettingsPanel } from "../components/settings/InferenceSettings";

export const Route = createFileRoute("/_chat/settings/inference")({
  component: InferenceSettingsPanel,
});
