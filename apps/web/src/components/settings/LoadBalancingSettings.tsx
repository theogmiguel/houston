import { resolveEnvironmentMachineKind } from "@t3tools/contracts";

import {
  useClientSettings,
  useClientSettingsHydrated,
  updateClientSettings,
} from "~/hooks/useSettings";
import type { EnvironmentPresentation } from "~/state/environments";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { EnvironmentRow, environmentTransportLabel } from "./EnvironmentRow";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const preferences = [
  { value: 100, label: "Prefer" },
  { value: 50, label: "Normal" },
  { value: 25, label: "Less often" },
  { value: 0, label: "Manual only" },
] as const;

type LoadPreference = (typeof preferences)[number]["value"];

function loadPreferenceForWeight(weight: number | undefined): LoadPreference {
  if (weight === undefined || weight === 50) return 50;
  if (weight === 0) return 0;
  return weight < 50 ? 25 : 100;
}

function preferenceLabel(preference: LoadPreference): string {
  return preferences.find((entry) => entry.value === preference)!.label;
}

function summarizeLoadPreferences(
  environments: ReadonlyArray<Pick<EnvironmentPresentation, "environmentId" | "label">>,
  weights: Readonly<Record<string, number>>,
): string | null {
  const parts = environments.flatMap((environment) => {
    const preference = loadPreferenceForWeight(weights[environment.environmentId]);
    return preference === 50
      ? []
      : [`${environment.label} ${preferenceLabel(preference).toLowerCase()}`];
  });
  return parts.length === 0 ? null : parts.join(" · ");
}

export function LoadBalancingSettings({
  environments,
}: {
  environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const settings = useClientSettings((current) => ({
    loadBalancingEnabled: current.loadBalancingEnabled,
    loadBalancingWeights: current.loadBalancingWeights,
  }));
  const settingsHydrated = useClientSettingsHydrated();

  const { id } = searchableSetting("load-balancing");
  const summary = settings.loadBalancingEnabled
    ? summarizeLoadPreferences(environments, settings.loadBalancingWeights)
    : null;
  return (
    <SettingsSection id={id} title="Routing">
      <SettingsRow
        title="Load balancing"
        description={
          summary
            ? `Spread new threads across environments that have the project. ${summary}.`
            : "Spread new threads across environments that have the project."
        }
        control={
          <Switch
            aria-label="Load balancing"
            checked={settings.loadBalancingEnabled}
            disabled={!settingsHydrated}
            onCheckedChange={(loadBalancingEnabled) =>
              updateClientSettings({ loadBalancingEnabled })
            }
          />
        }
      />
      {environments.length > 1
        ? environments.map((environment) => (
            <EnvironmentRow
              key={environment.environmentId}
              kind={resolveEnvironmentMachineKind(environment.serverConfig)}
              label={environment.label}
              subtitle={environmentTransportLabel(environment)}
            >
              <Select
                items={preferences}
                value={loadPreferenceForWeight(
                  settings.loadBalancingWeights[environment.environmentId],
                )}
                disabled={!settingsHydrated || !settings.loadBalancingEnabled}
                onValueChange={(value) => {
                  if (value === null) return;
                  updateClientSettings({
                    loadBalancingWeights: {
                      ...settings.loadBalancingWeights,
                      [environment.environmentId]: value,
                    },
                  });
                }}
              >
                <SelectTrigger
                  size="xs"
                  className="w-32"
                  aria-label={`${environment.label} load preference`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {preferences.map(({ value, label }) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </EnvironmentRow>
          ))
        : null}
    </SettingsSection>
  );
}
