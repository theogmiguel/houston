import { createFileRoute } from "@tanstack/react-router";

import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { UsagePage } from "../components/usage/UsagePage";

function SettingsUsageRoute() {
  return (
    <SettingsPageContainer width="wide" className="gap-7 px-6 pt-4 pb-16 sm:px-8">
      <UsagePage embedded />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/_chat/settings/usage")({
  component: SettingsUsageRoute,
});
