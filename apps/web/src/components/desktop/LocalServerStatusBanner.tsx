import type { DesktopLocalServerStatus } from "@houston-app/contracts";
import { useEffect, useState } from "react";

import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { hostBridgeErrorMessage } from "./hostBridgeError";

const STATUS_POLL_MS = 4_000;

/**
 * The window opens before the local server does. This banner names a slow start,
 * a failed start with its cause, and a degraded start (a temporary keychain secret).
 */
export function LocalServerStatusBanner() {
  const bridge = window.hostBridge;
  const [status, setStatus] = useState<DesktopLocalServerStatus | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissedWarning, setDismissedWarning] = useState<string | null>(null);
  const [startingVisible, setStartingVisible] = useState(false);

  const showStarting = status?.state === "starting" && startingVisible;

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- holds back a fast start's banner with a timer, so a normal launch does not flash one
  useEffect(() => {
    if (status?.state !== "starting") return;
    const timer = window.setTimeout(() => setStartingVisible(true), 2_000);
    return () => window.clearTimeout(timer);
  }, [status?.state]);

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- subscribes to the host's server status and polls it until ready
  useEffect(() => {
    if (!bridge?.getServerStatus) return;
    let active = true;
    const refresh = () => {
      void bridge
        .getServerStatus?.()
        .then((next) => {
          if (active) setStatus(next);
        })
        .catch(() => undefined);
    };
    refresh();
    const unsubscribe = bridge.onServerStatus?.((next) => {
      if (active) setStatus(next);
    });
    const timer = window.setInterval(refresh, STATUS_POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
      unsubscribe?.();
    };
  }, [bridge]);

  if (!bridge?.getServerStatus || status === null) return null;
  if (status.state === "starting" && !showStarting) return null;
  if (status.state === "ready" && (!status.warning || status.warning === dismissedWarning)) {
    return null;
  }

  const restart = async () => {
    if (!bridge.restartServer) return;
    setError(null);
    setRestarting(true);
    try {
      const next = await bridge.restartServer();
      setStatus(next);
    } catch (cause) {
      setError(hostBridgeErrorMessage(cause, "Could not restart the local server."));
    }
    setRestarting(false);
  };

  const failed = status.state === "error";
  const message = failed
    ? (status.error ?? "The local server did not start.")
    : status.state === "starting"
      ? "Starting the local server…"
      : status.warning;

  return (
    <div className="fixed inset-x-4 top-4 z-100 mx-auto max-w-2xl">
      <Alert
        variant={failed ? "error" : "warning"}
        controlAlignment="first-line"
        className="items-start"
      >
        {status.state === "starting" ? <Spinner size="sm" /> : null}
        <AlertDescription>
          <p>{message}</p>
          {error ? <p>{error}</p> : null}
          {status.logPath ? <p>{status.logPath}</p> : null}
        </AlertDescription>
        <AlertAction>
          {status.state === "ready" ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDismissedWarning(status.warning ?? null)}
            >
              Dismiss
            </Button>
          ) : (
            <Button
              size="sm"
              variant={failed ? "default" : "outline"}
              disabled={restarting}
              onClick={() => void restart()}
            >
              {restarting ? (
                <>
                  <Spinner size="sm" />
                  Restarting…
                </>
              ) : (
                "Retry"
              )}
            </Button>
          )}
        </AlertAction>
      </Alert>
    </div>
  );
}
