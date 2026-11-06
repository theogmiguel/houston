import { Link } from "@tanstack/react-router";

import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { ComposerFeaturesSection } from "./SettingsPanels";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

/** Optional features that are off by default. */
export function LabsSettingsPanel() {
  return (
    <SettingsPageContainer>
      <p className="px-1 text-sm text-muted-foreground">
        Optional features, each off unless you turn it on. Some are experiments that may change or
        disappear.
      </p>
      <SettingsSection id="labs-environments" title="Environments">
        <LinkedEnvironmentsRow />
        <SimlockHostsRow />
      </SettingsSection>
      <ComposerFeaturesSection />
    </SettingsPageContainer>
  );
}

function LinkedEnvironmentsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("linked-environments-beta")}
      settingKeys={["linkedEnvironmentsEnabled"]}
      description={
        <>
          Let agents here work on your other machines, and theirs here. Turn it on for each machine,
          then link them in{" "}
          <Link to="/settings/connections" className="underline underline-offset-2">
            Connections
          </Link>
          . While it is off, nothing new starts over a link; tasks already running finish.
        </>
      }
      control={
        <ScopedSwitch
          settingKeys={["linkedEnvironmentsEnabled"]}
          checked={settings.linkedEnvironmentsEnabled}
          onCheckedChange={(checked) =>
            updateSettings({ linkedEnvironmentsEnabled: Boolean(checked) })
          }
          aria-label="Linked environments"
        />
      }
    />
  );
}

function SimlockHostsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("simlock-hosts")}
      settingKeys={["simlockDeviceHostsEnabled"]}
      description={
        <>
          Let the Device panel lease simulators and emulators from your own{" "}
          <a
            href="https://incubator.callstack.com/simlock/"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            Simlock
          </a>{" "}
          pool, added in{" "}
          <Link to="/settings/devices" className="underline underline-offset-2">
            Devices
          </Link>
          . An alpha that may change or break. Houston never installs Simlock.
        </>
      }
      control={
        <ScopedSwitch
          settingKeys={["simlockDeviceHostsEnabled"]}
          checked={settings.simlockDeviceHostsEnabled}
          onCheckedChange={(checked) =>
            updateSettings({ simlockDeviceHostsEnabled: Boolean(checked) })
          }
          aria-label="Simlock device hosts"
        />
      }
    />
  );
}
