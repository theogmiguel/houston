import { useState } from "react";
import { ServerIcon } from "lucide-react";

import { useIsPhone } from "../../mobile/usePhone";
import { usePrimaryEnvironment } from "../../state/environments";
import { Button } from "../ui/button";
import { hostBridgeErrorMessage } from "../desktop/hostBridgeError";
import { Spinner } from "../ui/spinner";
import { SettingsRow } from "./settingsLayout";

// The desktop host owns the local server; this row restarts it, and the
// environment switch stays hidden because the host has no persisted toggle.
export function LocalEnvironmentSetting() {
  const isPhone = useIsPhone();
  const [isRestarting, setIsRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const primaryEnvironment = usePrimaryEnvironment();
  const address = primaryEnvironment?.displayUrl ?? "127.0.0.1";
  const version = primaryEnvironment?.serverConfig?.environment.serverVersion;
  const restartServer = window.hostBridge?.restartServer;

  const restart = async () => {
    if (!restartServer) return;
    setError(null);
    setIsRestarting(true);
    try {
      await restartServer();
    } catch (cause) {
      setError(hostBridgeErrorMessage(cause, "Couldn't restart the local server."));
    }
    setIsRestarting(false);
  };

  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-2">
          <ServerIcon aria-hidden className="size-4 text-muted-foreground" />
          This PC
        </span>
      }
      description={
        <span>
          <span className="font-mono">{address}</span>
          {version ? ` · v${version}` : null}
          {error ? <span className="block text-destructive">{error}</span> : null}
        </span>
      }
      control={
        <Button
          size="sm"
          variant={isPhone ? "outline" : "ghost"}
          className={isPhone ? "h-11 w-full" : undefined}
          disabled={isRestarting || !restartServer}
          onClick={() => void restart()}
        >
          {isRestarting ? (
            <>
              <Spinner size="sm" />
              Restarting…
            </>
          ) : (
            "Restart"
          )}
        </Button>
      }
    />
  );
}
