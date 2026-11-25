import type { EnvironmentId } from "@houston-app/contracts";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsRow } from "./settingsLayout";
import { Switch } from "../ui/switch";
import { Text } from "../ui/text";
import { stackedThreadToast, toastManager } from "../ui/toast";

/**
 * The remote-control security switches in Sharing & access. Both are opt-in and
 * reversible, and the E2EE row shows the host fingerprint an out-of-band check
 * compares against.
 */
export function EncryptedRemoteControlSettings({
  environmentId,
  canChange,
  fingerprint,
}: {
  readonly environmentId: EnvironmentId;
  readonly canChange: boolean;
  readonly fingerprint: string | null;
}) {
  const remoteTransportPolicy = useEnvironmentSettings(
    environmentId,
    (settings) => settings.remoteTransportPolicy,
  );
  const e2eeMode = useEnvironmentSettings(environmentId, (settings) => settings.e2eeMode);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const [saving, setSaving] = useState<"transport" | "e2ee" | null>(null);

  const apply = async (
    key: "transport" | "e2ee",
    patch: Parameters<typeof updateSettings>[0]["input"]["patch"],
  ) => {
    setSaving(key);
    const result = await updateSettings({ environmentId, input: { patch } });
    setSaving(null);
    if (result._tag === "Failure") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not update remote control security",
          description: "Try again in a moment.",
        }),
      );
    }
  };

  const handleTransportChange = (checked: boolean) =>
    void apply("transport", { remoteTransportPolicy: checked ? "private-e2ee-only" : "any" });

  const handleE2eeChange = (checked: boolean) => {
    if (!checked && e2eeMode !== "off") {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "End-to-end encryption is off",
          description: "Devices paired while it was on must pair again to reconnect.",
        }),
      );
    }
    void apply("e2ee", { e2eeMode: checked ? "prefer" : "off" });
  };

  return (
    <>
      <SettingsRow
        title="Private transports only"
        description="Refuse remote connections that do not arrive over this machine, Tailscale or SSH. Tunnels, public proxies and plain LAN addresses are refused. A connection that is already open stays open."
        status={remoteTransportPolicy === "private-e2ee-only" ? "On" : "Off"}
        control={
          <Switch
            checked={remoteTransportPolicy === "private-e2ee-only"}
            disabled={!canChange || saving !== null}
            aria-label="Private transports only"
            onCheckedChange={handleTransportChange}
          />
        }
      />
      <SettingsRow
        title="End-to-end encryption"
        description={
          "Encrypts the live session and verifies this host's identity. File transfers and pairing-code links are not covered. Turning it off means devices paired while it was on must pair again."
        }
        status={
          <span className="block">
            {e2eeMode === "off" ? "Off" : e2eeMode === "require" ? "Required" : "On"}
            {fingerprint ? (
              <Text as="span" variant="caption" tone="muted" mono className="mt-1 block">
                {fingerprint}
              </Text>
            ) : null}
          </span>
        }
        control={
          <Switch
            checked={e2eeMode !== "off"}
            disabled={!canChange || saving !== null}
            aria-label="End-to-end encryption"
            onCheckedChange={handleE2eeChange}
          />
        }
      />
    </>
  );
}
