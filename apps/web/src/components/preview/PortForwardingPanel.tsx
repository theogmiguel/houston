import type { EnvironmentId } from "@houston-app/contracts";
import { type FormEvent, useState } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { useT } from "~/i18n/useT";
import { usePortForwards } from "~/state/portForwards";
import { Button } from "../ui/button";
import {
  DiscoveryHint,
  DiscoveryIntro,
  DiscoveryList,
  DiscoveryRowText,
  DiscoveryStaticRow,
} from "../ui/discovery-list";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { stackedThreadToast, toastManager } from "../ui/toast";

const PORT_MIN = 1;
const PORT_MAX = 65_535;

export function PortForwardingPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly compact?: boolean;
}) {
  const t = useT();
  const enabled = useClientSettings((settings) => settings.portForwardingEnabled);
  const forwards = usePortForwards();
  const [port, setPort] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const available =
    typeof window !== "undefined" && window.hostBridge?.startPortForward !== undefined;

  const report = (title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  const start = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const bridge = window.hostBridge;
    if (bridge === undefined) return;
    const remotePort = Number.parseInt(port, 10);
    if (!Number.isInteger(remotePort) || remotePort < PORT_MIN || remotePort > PORT_MAX) {
      report(t("Could not forward port"), new Error(t("Remote port must be between 1 and 65535.")));
      return;
    }
    setBusy("start");
    try {
      await bridge.startPortForward({ environmentId: props.environmentId, remotePort });
      setPort("");
    } catch (error) {
      report(t("Could not forward port"), error);
    } finally {
      setBusy(null);
    }
  };

  const stop = async (id: string) => {
    const bridge = window.hostBridge;
    if (bridge === undefined) return;
    setBusy(id);
    try {
      await bridge.stopPortForward({ id });
    } catch (error) {
      report(t("Could not stop the forward"), error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <DiscoveryIntro title={t("Forwarded ports")}>
        {t("A remote environment's TCP ports reach this machine through its saved connection.")}
      </DiscoveryIntro>
      {available ? null : (
        <DiscoveryHint>{t("Port forwarding is available in the Houston desktop app.")}</DiscoveryHint>
      )}
      {!enabled || !available ? null : (
        <DiscoveryHint>
          {t("Port forwarding is off. Turn it on in Settings → Connections → Port forwarding.")}
        </DiscoveryHint>
      )}
      {available && forwards.length > 0 ? (
        <DiscoveryList>
          {forwards.map((forward) => (
            <DiscoveryStaticRow key={forward.id}>
              <DiscoveryRowText
                primary={forward.environmentLabel}
                secondary={`localhost:${forward.localPort} → ${forward.environmentLabel}:${forward.remotePort}`}
                tertiary={forward.error ?? t("Active")}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => void stop(forward.id)}
              >
                {t("Stop")}
              </Button>
            </DiscoveryStaticRow>
          ))}
        </DiscoveryList>
      ) : (
        available ? <DiscoveryHint>{t("No ports are forwarded.")}</DiscoveryHint> : null
      )}
      {available ? <form className="flex items-end gap-2 px-1" onSubmit={(event) => void start(event)}>
        <Label className="flex min-w-0 flex-1 flex-col items-stretch gap-1">
          <span>{t("Remote port")}</span>
          <Input
            type="number"
            inputMode="numeric"
            min={PORT_MIN}
            max={PORT_MAX}
            step={1}
            value={port}
            placeholder="3000"
            disabled={!enabled || busy !== null}
            onChange={(event) => setPort(event.target.value)}
          />
        </Label>
        <Button type="submit" disabled={!enabled || busy !== null || port.trim().length === 0}>
          {t("Forward")}
        </Button>
      </form> : null}
      {props.compact || !available ? null : (
        <DiscoveryHint>
          {t("Up to 8 ports per environment and 16 in all. Each forward binds 127.0.0.1 only.")}
        </DiscoveryHint>
      )}
    </div>
  );
}
