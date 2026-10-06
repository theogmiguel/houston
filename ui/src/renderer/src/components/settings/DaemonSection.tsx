import { useCallback, useEffect, useState } from "react";
import {
  daemonShutdown,
  daemonStatus,
  type DaemonStatus,
} from "../../houston/manage";
import {
  setKeepInTray,
  trayState,
  type TrayStateView,
} from "../../houston/tray";
import { Button } from "../ui";
import { ConfirmModal } from "../ConfirmModal";
import { pluralize, stopConfirmCopy } from "../daemonStopConfirmCopy";
import { Toggle } from "../ui/settingsPrimitives";
import { Readout, ReadoutGrid, Text, Stack } from "../ui";
import { Group, Row } from "./shared";

// Fallback only, used before `reap.deadline_ms` arrives — must match the
// daemon's own grace period or the copy below states the wrong number.
const REAP_GRACE_MINUTES = 5;
// daemon_status is cheap (in-memory counters, no DB read); 5s keeps this
// panel fresh without hammering the daemon.
const POLL_MS = 5_000;

function formatRunningSince(startedAt: string): {
  relative: string;
  absolute: string;
} {
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return { relative: "unknown", absolute: startedAt };
  const totalMinutes = Math.max(0, Math.floor((Date.now() - start) / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const relative =
    days > 0
      ? `${days}d ${hours}h ago`
      : hours > 0
        ? `${hours}h ${minutes}m ago`
        : `${pluralize(minutes, "minute")} ago`;
  return { relative, absolute: new Date(start).toLocaleString() };
}

function reapCopy(status: DaemonStatus): string {
  if (status.reap.armed) {
    const mins =
      status.reap.deadline_ms !== null
        ? Math.max(0, Math.ceil(status.reap.deadline_ms / 60_000))
        : REAP_GRACE_MINUTES;
    return `Will exit in ${mins} min if nothing connects; enabled routines and live sessions keep it running.`;
  }
  const reasons: string[] = [];
  if (status.clients_connected > 0)
    reasons.push(pluralize(status.clients_connected, "connected client"));
  if (status.live_sessions.count > 0)
    reasons.push(pluralize(status.live_sessions.count, "live session"));
  if (status.routines_enabled > 0)
    reasons.push(pluralize(status.routines_enabled, "armed routine"));
  const why = reasons.length > 0 ? reasons.join(", ") : "nothing yet";
  return `Staying up: it exits ${REAP_GRACE_MINUTES} minutes after no client is connected, no session is live and no routine is armed. Right now: ${why}.`;
}

function Fact({
  label,
  value,
  sub,
  mono,
  numeric,
  testId,
}: {
  label: string;
  value: string;
  sub?: string;
  mono?: boolean;
  numeric?: boolean;
  testId: string;
}): React.JSX.Element {
  return <Readout data-testid={testId} label={label} value={value} sub={sub} mono={mono} tabular={numeric} />;
}

export function DaemonSection(): React.JSX.Element {
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tray, setTray] = useState<TrayStateView | null>(null);
  const [trayError, setTrayError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopped, setStopped] = useState(false);

  const load = useCallback((): void => {
    daemonStatus().then(
      (s) => {
        setStatus(s);
        setError(null);
      },
      (err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
    );
  }, []);

  useEffect(() => {
    if (stopped) return;
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [stopped, load]);

  useEffect(() => {
    trayState().then(setTray, (err: unknown) =>
      setTrayError(err instanceof Error ? err.message : String(err)),
    );
  }, []);

  const handleKeepInTray = (enabled: boolean): void => {
    setKeepInTray(enabled).then(
      (next) => {
        if (next) setTray(next);
        setTrayError(null);
      },
      (err: unknown) =>
        setTrayError(err instanceof Error ? err.message : String(err)),
    );
  };

  const handleStop = (): void => {
    setStopping(true);
    daemonShutdown().then(
      () => {
        setStopping(false);
        setConfirming(false);
        setStopped(true);
      },
      (err: unknown) => {
        setStopping(false);
        setError(err instanceof Error ? err.message : String(err));
      },
    );
  };

  const since = status ? formatRunningSince(status.started_at) : null;

  return (
    <>
      {stopped ? (
            <Text data-testid="daemon-section-stopped" as="div" tone="muted" size="ui" center>
            Daemon stopped. Reopening Houston starts a new one.
            </Text>
      ) : !status ? (
        error ? (
          <Stack align="start" gap={3}>
            <Text data-testid="daemon-section-error" as="div" tone="danger" size="ui">{error}</Text>
            <Button
              type="button"
              variant="legacy-ghost"
              onClick={load}
              data-testid="daemon-section-retry"
            >
              Retry
            </Button>
          </Stack>
        ) : (
            <Text data-testid="daemon-section-loading" as="div" tone="muted" size="ui" center>
            Asking the daemon for its own vitals…
            </Text>
        )
      ) : (
        <>
          <Group plain>
            <Stack gap={4}>
              <ReadoutGrid data-testid="daemon-section-facts">
                <Fact
                  testId="daemon-fact-running-since"
                  label="Running since"
                  value={since!.relative}
                  sub={since!.absolute}
                />
                <Fact
                  testId="daemon-fact-build"
                  label="Build"
                  value={status.build}
                  mono
                />
                <Fact
                  testId="daemon-fact-sessions"
                  label="Live sessions"
                  value={String(status.live_sessions.count)}
                  numeric
                />
                <Fact
                  testId="daemon-fact-routines"
                  label="Routines armed"
                  value={String(status.routines_enabled)}
                  numeric
                />
                <Fact
                  testId="daemon-fact-clients"
                  label="Clients connected"
                  value={String(status.clients_connected)}
                  numeric
                />
              </ReadoutGrid>
              <Text data-testid="daemon-section-reap" weight="small" size="small" as="div" tone="muted">{reapCopy(status)}</Text>
            </Stack>
          </Group>
          {tray && (
            <Group heading="Background">
              <Row
                title="Keep Houston in the tray when the window closes"
                desc={
                  tray.available
                    ? tray.keepInTray
                      ? "Closing the window hides it. Agents keep running, and the tray icon shows what they're doing — open it again from there."
                      : "Closing the window quits Houston. The daemon and its agents keep running; reopen Houston to see them."
                    : (tray.reason ??
                      "No tray on this desktop, so closing the window quits Houston.")
                }
              >
                <Toggle
                  on={tray.keepInTray}
                  disabled={!tray.available}
                  onChange={handleKeepInTray}
                  data-testid="daemon-section-keep-in-tray"
                />
              </Row>
            </Group>
          )}
          {trayError && (
            <Text data-testid="daemon-section-tray-error" size="small" as="div" tone="danger">{trayError}</Text>
          )}
          <Group>
            <Row
              title="Stop daemon"
              desc="Ends every session it owns and disarms every routine, then exits. You'll need to reopen Houston."
            >
              <Button
                type="button"
                variant="legacy-danger-solid"
                contentAlign="start"
                className="inline-flex items-center gap-[var(--space-1-5)]"
                onClick={() => setConfirming(true)}
                data-testid="daemon-section-stop"
              >
                Stop daemon
              </Button>
            </Row>
          </Group>
          {error && (
            <Text data-testid="daemon-section-stop-error" size="small" as="div" tone="danger">{error}</Text>
          )}
        </>
      )}
      {confirming && status && (
        <ConfirmModal
          title="STOP DAEMON"
          message={stopConfirmCopy(status)}
          confirmLabel={stopping ? "Stopping…" : "Stop daemon"}
          onConfirm={handleStop}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}
