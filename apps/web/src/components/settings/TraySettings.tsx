import type { DesktopTrayState } from "@houston-app/contracts";
import { useEffect, useState } from "react";

import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/** Only shown when the desktop has a working tray; without one it cannot hide anything. */
export function KeepInTraySetting() {
  const bridge = window.hostBridge;
  const [state, setState] = useState<DesktopTrayState | null | undefined>(() =>
    bridge?.trayState ? undefined : null,
  );
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- reads the native tray's persisted state, which has no atom source
  useEffect(() => {
    if (!bridge?.trayState) return;
    let active = true;
    void bridge
      .trayState()
      .then((next) => {
        if (active) setState(next);
      })
      .catch(() => {
        if (active) setState(null);
      });
    return () => {
      active = false;
    };
  }, [bridge]);

  if (!state?.available) return null;

  return (
    <SettingsRow
      {...searchableSetting("keep-in-tray")}
      description={
        error ??
        "Closing the window hides Houston instead of quitting. Agents keep running, and the tray icon shows what they are doing."
      }
      control={
        <Switch
          checked={state.keepInTray}
          disabled={updating}
          onCheckedChange={async (checked) => {
            if (!bridge?.setKeepInTray) return;
            setError(null);
            setUpdating(true);
            try {
              const next = await bridge.setKeepInTray(checked);
              if (next) setState(next);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "Could not save the tray setting.");
            }
            setUpdating(false);
          }}
          aria-label="Keep Houston in the tray"
        />
      }
    />
  );
}
