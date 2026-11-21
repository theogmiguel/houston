import { persistClientSettingsPatch, useClientSettings } from "~/hooks/useSettings";
import { useT } from "~/i18n/useT";

import { SettingsRow, SettingsSection } from "./settingsLayout";
import { Switch } from "../ui/switch";

export function PortForwardingSetting() {
  const t = useT();
  const enabled = useClientSettings((settings) => settings.portForwardingEnabled);
  return (
    <SettingsSection id="port-forwarding" title={t("Port forwarding")}>
      <SettingsRow
        title={t("Forward remote ports to this machine")}
        description={t(
          "Forward a remote environment's TCP ports to this machine's localhost. Nothing is forwarded until you forward a port, and every forward stops when this is off.",
        )}
        status={enabled ? t("On") : t("Off")}
        control={
          <Switch
            checked={enabled}
            aria-label={t("Forward remote ports to this machine")}
            onCheckedChange={(checked) => {
              void persistClientSettingsPatch({ portForwardingEnabled: checked });
            }}
          />
        }
      />
    </SettingsSection>
  );
}
