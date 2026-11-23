import { useAtomValue } from "@effect/atom-react";
import { PROVIDER_DISPLAY_NAMES } from "@houston-app/contracts";

import { APP_VERSION } from "~/branding";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { isDesktopHost } from "~/env";
import { useEnvironments } from "~/state/environments";
import { useReleasePublished } from "~/state/releasePublication";
import { environmentIdsKey } from "~/state/environmentAtomList";
import { environmentUpdateStatesAtom } from "~/state/server";
import { environmentSessionStatesAtom } from "~/state/session";
import type { ReportLocalUpdateError } from "../desktopUpdate.logic";
import { getProviderUpdateRunOutcome } from "../ProviderUpdateLaunchNotification.logic";
import { useProviderUpdates } from "../ProviderUpdatesAction";
import { canUpdateServer, useServerUpdate } from "../ServerUpdateAction";
import {
  type ChannelSwitchRelease,
  closeFinishedUpdateRun,
  collectChannelSwitchTargets,
  collectRestartingMachines,
  collectServerUpdateTargets,
  collectUpdateEverythingResult,
  describeUpdateEverything,
  runUpdateEverything,
  type SkippedMachine,
  type UpdateRunMachine,
} from "./updateEverything.logic";
import {
  clearSavedUpdateEverythingResult,
  getUpdateEverythingRun,
  saveUpdateEverythingResult,
  setUpdateEverythingRun,
  settleUpdateRunMachine,
  showUpdateEverythingResult,
  waitForServerUpdateStarted,
  waitForUpdateRestart,
} from "./updateEverythingRun";

const UPDATE_RESTART_DELAY_MS = 5_000;

/** Servers this desktop app runs; they update with it. */
export function isHostedByThisApp(
  environment: ReturnType<typeof useEnvironments>["environments"][number],
) {
  return (
    isDesktopHost &&
    (environment.entry.target._tag === "PrimaryConnectionTarget" ||
      isDesktopLocalConnectionTarget(environment.entry.target))
  );
}

/** `channelSwitch` makes the run move the fleet to that release's track instead of updating it. */
export function useUpdateEverything(
  localUpdateVersion: string | null,
  channelSwitch?: ChannelSwitchRelease,
) {
  const targetVersion = localUpdateVersion ?? APP_VERSION;
  const { environments } = useEnvironments();
  const environmentIds = environmentIdsKey(environments.map(({ environmentId }) => environmentId));
  const sessionStates = useAtomValue(environmentSessionStatesAtom(environmentIds));
  const updateStates = useAtomValue(environmentUpdateStatesAtom(environmentIds));
  const machines = environments.map((environment, index) => ({
    environmentId: environment.environmentId,
    label: environment.label,
    serverConfig: environment.serverConfig,
    connected: environment.connection.phase === "connected",
    hostedByThisApp: isHostedByThisApp(environment),
    canMaintain: canUpdateServer(sessionStates[index]!),
    updateState: updateStates[index]!,
  }));
  // A track switch's target came from GitHub already.
  const {
    targets: behindServers,
    skipped: unreachable,
    waitForPublished,
  } = channelSwitch
    ? { ...collectChannelSwitchTargets(machines, channelSwitch), waitForPublished: [] }
    : collectServerUpdateTargets(machines, targetVersion, localUpdateVersion !== null);
  const published = useReleasePublished(waitForPublished.length > 0 ? targetVersion : null);
  const servers = published
    ? behindServers
    : behindServers.filter((server) => !waitForPublished.includes(server));
  const skipped: ReadonlyArray<SkippedMachine> = [
    ...unreachable,
    ...behindServers
      .filter((server) => !servers.includes(server))
      .map((server) => ({
        environmentId: server.environmentId,
        label: server.serverLabel,
        reason: `houston@${targetVersion} has no published server release yet`,
      })),
  ];
  // Track-only hosts save a setting and restart nothing, so they are neither listed nor counted.
  const moving = servers.filter((server) => server.trackOnly !== true);
  const restarts = collectRestartingMachines(machines, moving, localUpdateVersion !== null);
  const providerUpdates = useProviderUpdates();
  // A track switch moves app and servers only; provider updates stay a separate choice.
  const providers = channelSwitch ? { machines: [], updateAll: async () => [] } : providerUpdates;
  const updateServer = useServerUpdate();

  const view = describeUpdateEverything({
    localVersion: localUpdateVersion,
    localMachines: machines.filter((machine) => machine.hostedByThisApp),
    servers: moving,
    skipped,
    providerMachines: providers.machines.map((machine) => ({
      environmentId: machine.environmentId,
      label: machine.label,
      providers: machine.candidates.map(
        (candidate) => PROVIDER_DISPLAY_NAMES[candidate.driver] ?? candidate.driver,
      ),
    })),
  });

  return {
    hasUpdates: servers.length > 0 || providers.machines.length > 0,
    ...view,
    restarts,
    run: async ({
      downloadLocal,
      installLocal,
      localVersion: requestedLocalVersion,
    }: {
      downloadLocal?: (reportError: ReportLocalUpdateError) => Promise<boolean>;
      installLocal?: (reportError: ReportLocalUpdateError) => Promise<boolean>;
      localVersion?: string | null;
    }) => {
      const localFailures: Array<string> = [];
      const reportLocalError: ReportLocalUpdateError = (title, description) => {
        localFailures.push(`${title}: ${description}`);
      };
      const startedAt = Date.now();
      const machinesById = new Map<UpdateRunMachine["environmentId"], UpdateRunMachine>();
      for (const machine of providers.machines) {
        machinesById.set(machine.environmentId, {
          environmentId: machine.environmentId,
          label: machine.label,
          updatesProviders: true,
          server: null,
          handedOffVersion: null,
          startedAt,
          result: null,
          failure: null,
          providerFailure: null,
        });
      }
      for (const server of servers) {
        const existing = machinesById.get(server.environmentId);
        machinesById.set(server.environmentId, {
          environmentId: server.environmentId,
          label: server.serverLabel,
          updatesProviders: existing?.updatesProviders ?? false,
          server,
          handedOffVersion: null,
          startedAt,
          result: null,
          failure: null,
          providerFailure: null,
        });
      }
      const localVersion =
        installLocal === undefined
          ? null
          : requestedLocalVersion !== undefined
            ? requestedLocalVersion
            : localUpdateVersion;
      setUpdateEverythingRun(() => ({
        ...(channelSwitch ? { trackSwitch: true } : {}),
        localVersion,
        phase: "providers",
        restartAt: null,
        machines: Array.from(machinesById.values()),
      }));
      const providerFailures = new Map<UpdateRunMachine["environmentId"], string>();
      let releaseTriggers: () => void = () => {};
      const triggersStarted = new Promise<void>((resolve) => {
        releaseTriggers = resolve;
      });

      const updateServers = async () => {
        const runs = servers.map(async (server) => {
          const serverOutcome = await updateServer(server, { quiet: true });
          settleUpdateRunMachine(
            server.environmentId,
            serverOutcome.status === "failed"
              ? serverOutcome.message
              : (providerFailures.get(server.environmentId) ?? null),
            {
              serverUpdated: serverOutcome.status !== "failed",
              providerFailure: providerFailures.get(server.environmentId) ?? null,
            },
          );
          return { label: server.serverLabel, outcome: serverOutcome };
        });
        // This app's restart only needs every remote trigger sent, not its handoff finished.
        await Promise.all(
          servers.map((server, index) =>
            waitForServerUpdateStarted(server.environmentId, runs[index]!),
          ),
        );
        releaseTriggers();
        return runs;
      };

      const remotePath = runUpdateEverything({
        updateProviders: async () => {
          const runs = await providers.updateAll({ quiet: true });
          const outcomes = runs.map((run) => {
            const runOutcome = getProviderUpdateRunOutcome(run);
            if (runOutcome.status !== "updated") {
              providerFailures.set(
                run.environmentId,
                runOutcome.status === "failed" ? runOutcome.line : "Provider update interrupted",
              );
            }
            return runOutcome;
          });
          for (const machine of machinesById.values()) {
            if (machine.server === null) {
              settleUpdateRunMachine(
                machine.environmentId,
                providerFailures.get(machine.environmentId) ?? null,
              );
            }
          }
          const serversStartedAt = Date.now();
          setUpdateEverythingRun((run) =>
            run && run.phase === "providers"
              ? {
                  ...run,
                  phase: "servers",
                  machines: run.machines.map((machine) =>
                    machine.server === null ? machine : { ...machine, startedAt: serversStartedAt },
                  ),
                }
              : run,
          );
          return outcomes;
        },
        updateServers,
      })
        .then(async (outcome) => {
          const finishedServers = await Promise.all(outcome.servers);
          showUpdateEverythingResult(
            collectUpdateEverythingResult({
              localVersion: null,
              localFailures,
              servers: finishedServers,
              providers: outcome.providers,
            }),
          );
          setUpdateEverythingRun((run) => {
            if (!run || run.phase === "countdown" || run.phase === "installing") return run;
            return closeFinishedUpdateRun({
              ...run,
              phase: "servers",
              restartAt: null,
              localVersion: null,
            });
          });
        })
        .catch((error: unknown) => {
          releaseTriggers();
          setUpdateEverythingRun((run) =>
            run && run.phase !== "countdown" && run.phase !== "installing"
              ? { ...run, phase: "servers" }
              : run,
          );
          throw error;
        });

      const localPath = async () => {
        if (installLocal === undefined || localVersion === null) return;
        const ready = downloadLocal === undefined ? true : await downloadLocal(reportLocalError);
        if (!ready) {
          setUpdateEverythingRun((run) => run && { ...run, localVersion: null });
          return;
        }
        // Remote triggers go out first; their handoffs keep running on the remote machines.
        await triggersStarted;
        if (!(await waitForUpdateRestart(UPDATE_RESTART_DELAY_MS))) {
          setUpdateEverythingRun((run) => run && { ...run, localVersion: null, restartAt: null });
          return;
        }
        setUpdateEverythingRun((run) => run && { ...run, phase: "installing", restartAt: null });
        saveUpdateEverythingResult({
          localVersion,
          updatedServers: 0,
          updatedProviders: 0,
          failures: [
            ...localFailures,
            ...(getUpdateEverythingRun()?.machines.flatMap((machine) =>
              machine.failure === null ? [] : [`${machine.label}: ${machine.failure}`],
            ) ?? []),
          ],
          restarting: [],
        });
        if (await installLocal(reportLocalError)) return;
        clearSavedUpdateEverythingResult();
        setUpdateEverythingRun((run) => run && { ...run, localVersion: null });
      };

      await Promise.all([localPath(), remotePath]);
    },
  };
}
