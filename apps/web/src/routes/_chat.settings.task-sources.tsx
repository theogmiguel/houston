import { createFileRoute } from "@tanstack/react-router";

import { TaskSourcesSettingsPanel } from "../components/settings/TaskSourcesSettings";

export const Route = createFileRoute("/_chat/settings/task-sources")({
  component: TaskSourcesSettingsPanel,
});
