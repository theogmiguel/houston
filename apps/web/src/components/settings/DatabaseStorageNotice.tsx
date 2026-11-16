import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@houston-app/client-runtime/state/runtime";
import type { EnvironmentId } from "@houston-app/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { formatBytes } from "../../lib/formatBytes";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const DismissedEnvironmentIds = Schema.Array(Schema.String);

const failureMessage = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error);

/** Returns a database's freed pages to disk while the server and its agent runs keep going. */
function DatabaseReclaimRow({
  environmentId,
  label,
  reclaimableBytes,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly reclaimableBytes: number;
}) {
  const reclaim = useAtomCommand(serverEnvironment.reclaimDatabaseSpace);
  const allowed = useAtomValue(
    serverEnvironment.reclaimDatabaseSpace.permissionAtom(environmentId),
  );
  const [pending, setPending] = useState(false);
  const run = async () => {
    if (pending) return;
    setPending(true);
    const result = await reclaim({ environmentId, input: {} }).finally(() => setPending(false));
    if (result._tag === "Success") {
      const { reclaimedBytes, remainingBytes, timeLimitSeconds } = result.value;
      toastManager.add(
        remainingBytes > 0
          ? {
              type: "info",
              title: `Returned ${formatBytes(reclaimedBytes)} on ${label}`,
              description: `${formatBytes(remainingBytes)} is left after the ${timeLimitSeconds} s limit for one request. Run it again to continue.`,
            }
          : { type: "success", title: `Returned ${formatBytes(reclaimedBytes)} on ${label}` },
      );
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: `Could not reclaim space on ${label}`,
        description: failureMessage(squashAtomCommandFailure(result)),
      });
    }
  };
  return (
    <SettingsRow
      title={`${formatBytes(reclaimableBytes)} on ${label}`}
      description="Free space inside the database file. Threads and agent runs keep working while it is returned."
      control={
        <Button variant="outline" size="xs" disabled={pending || !allowed} onClick={run}>
          {pending ? "Reclaiming…" : "Reclaim now"}
        </Button>
      }
    />
  );
}

/**
 * Offers a one-click reclaim for databases that shrink on their own, and suggests `houston doctor`
 * on every machine whose older database still holds at least 1 GiB of freed pages.
 */
export function DatabaseStorageNotice({
  environments,
}: {
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly serverConfig?: {
      readonly environment: { readonly capabilities: { readonly databaseReclaim?: boolean } };
    } | null;
  }>;
}) {
  const recommendations = useAtomValue(
    serverEnvironment.databaseCompactionRecommendations(
      JSON.stringify(environments.map((environment) => environment.environmentId)),
    ),
  );
  const [dismissed, setDismissed] = useLocalStorage(
    "database-storage-notice-dismissed",
    [],
    DismissedEnvironmentIds,
  );
  const reclaimable = new Set(
    environments
      .filter(
        (environment) =>
          environment.serverConfig?.environment.capabilities.databaseReclaim === true,
      )
      .map(({ environmentId }) => environmentId),
  );
  const offers = useAtomValue(
    serverEnvironment.databaseReclaimOffers(
      JSON.stringify(environments.map((environment) => environment.environmentId)),
    ),
  ).filter(({ environmentId }) => reclaimable.has(environmentId));
  const { copyToClipboard } = useCopyToClipboard({ target: "command" });
  const visible = recommendations.filter(
    (recommendation) => !dismissed.includes(recommendation.environmentId),
  );
  if (visible.length === 0 && offers.length === 0) return null;
  const labelOf = (environmentId: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === environmentId)?.label ??
    environmentId;
  return (
    <SettingsSection id="storage-database" title="Database">
      {offers.map(({ environmentId, status }) => (
        <DatabaseReclaimRow
          key={environmentId}
          environmentId={environmentId}
          label={labelOf(environmentId)}
          reclaimableBytes={status.reclaimableBytes}
        />
      ))}
      {visible.length === 0 ? null : (
        <SettingsRow
          title="Reclaim freed database space"
          description="These databases still hold space freed by history cleanup. Run the command on each machine to reclaim it. It restarts the background service. Quit the desktop app first if it hosts the environment."
        />
      )}
      {visible.map(({ environmentId, status }) => (
        <SettingsRow
          key={environmentId}
          title={`${(status.reclaimableBytes / 1024 ** 3).toFixed(1)} GiB on ${labelOf(environmentId)}`}
          description={<code className="select-text break-all">{status.compactCommand}</code>}
          control={
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                variant="outline"
                size="xs"
                onClick={() => copyToClipboard(status.compactCommand, undefined)}
              >
                Copy command
              </Button>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setDismissed((current) => [...current, environmentId])}
              >
                Dismiss
              </Button>
            </div>
          }
        />
      ))}
    </SettingsSection>
  );
}
