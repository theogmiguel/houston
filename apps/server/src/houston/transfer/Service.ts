// @effect-diagnostics nodeBuiltinImport:off - checks that a project's folder exists before git reads it.
// The houston.transfer.* methods: one transfer per project at a time, each stage published to
// subscribers. Export lives in Export.ts; inspect reads the manifest alone and writes nothing.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ProjectId } from "@t3tools/contracts";
import type {
  HoustonTransferError,
  HoustonTransferExportInput,
  HoustonTransferExportSummary,
  HoustonTransferFileSummary,
  HoustonTransferInspectInput,
  HoustonTransferOperation,
  HoustonTransferRunning,
  HoustonTransferStage,
  HoustonTransferStreamEvent,
  HoustonTransferSubscribeInput,
} from "@t3tools/contracts/houston/transfer";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { originUrl } from "./checkout.ts";
import { runExport, type ExportOptions } from "./Export.ts";
import { fromPromise, readManifest } from "./format.ts";
import { TransferProbe } from "./probe.ts";
import { agentConfigPaths, checkReadPassphrase, refusal, remotesMatch } from "./rules.ts";

const INSPECT = "houston.transfer.inspect";

export class HoustonTransferService extends Context.Service<
  HoustonTransferService,
  {
    readonly export: (
      input: HoustonTransferExportInput,
    ) => Effect.Effect<HoustonTransferExportSummary, HoustonTransferError>;
    readonly inspect: (
      input: HoustonTransferInspectInput,
    ) => Effect.Effect<HoustonTransferFileSummary, HoustonTransferError>;
    readonly subscribe: (
      input: HoustonTransferSubscribeInput,
    ) => Stream.Stream<HoustonTransferStreamEvent, HoustonTransferError>;
  }
>()("houston/houston/transfer/Service/HoustonTransferService") {}

type Dependencies =
  | SqlClient.SqlClient
  | ProjectStore.ProjectStoreV2
  | ProjectionStore.ProjectionStoreV2
  | VcsProcess.VcsProcess
  | ServerConfig.ServerConfig
  | ServerSettings.ServerSettingsService
  | FileSystem.FileSystem
  | Path.Path;

const make = Effect.fn("HoustonTransfer.make")(function* (options: ExportOptions) {
  // The methods run in RPC fibers; the probe stays whatever the caller's fiber provides.
  const services = yield* Effect.context<Dependencies>();
  const events = yield* PubSub.unbounded<HoustonTransferStreamEvent>();
  // One transfer per project; the map is also what a new subscriber is told is running.
  const running = new Map<ProjectId, HoustonTransferRunning>();

  const setStage = Effect.fn("HoustonTransfer.setStage")(function* (
    operation: HoustonTransferOperation,
    projectId: ProjectId,
    stage: HoustonTransferStage,
  ) {
    running.set(projectId, { operation, projectId, stage });
    yield* PubSub.publish(events, { type: "stage", operation, projectId, stage });
    const probe = yield* TransferProbe;
    yield* probe.onStage(operation, stage);
  });

  /** Takes the project's slot for the rest of the scope, or refuses naming the running one. */
  const take = Effect.fn("HoustonTransfer.take")(function* (
    operation: HoustonTransferOperation,
    projectId: ProjectId,
    method: string,
    title: string,
  ) {
    const current = running.get(projectId);
    if (current !== undefined) {
      return yield* refusal(
        "busy",
        method,
        `An ${current.operation} of ${title} is running; one transfer of a project runs at a time.`,
        {
          items: [`${current.operation}: ${current.stage}`],
          steps: ["Wait for it to finish, then try again."],
        },
      );
    }
    running.set(projectId, { operation, projectId, stage: "checking" });
    yield* Effect.addFinalizer(() => Effect.sync(() => running.delete(projectId)));
    return (stage: HoustonTransferStage) => setStage(operation, projectId, stage);
  });
  const claim =
    (operation: HoustonTransferOperation, projectId: ProjectId, method: string) =>
    (title: string) =>
      take(operation, projectId, method, title);

  const exportProject: HoustonTransferService["Service"]["export"] = (input) =>
    runExport(input, options, claim("export", input.projectId, "houston.transfer.export")).pipe(
      Effect.scoped,
      Effect.provide(services),
    );

  const inspect: HoustonTransferService["Service"]["inspect"] = Effect.fn(
    "HoustonTransfer.inspect",
  )(function* (input) {
    const passphrase = Redacted.value(input.passphrase);
    const passphraseRefusal = checkReadPassphrase(passphrase, INSPECT);
    if (passphraseRefusal !== null) return yield* passphraseRefusal;
    if (!NodePath.isAbsolute(input.file)) {
      return yield* refusal("invalid", INSPECT, `${input.file} is not an absolute file path.`, {
        items: [input.file],
        steps: ["Choose the transfer file again."],
      });
    }
    const probe = yield* TransferProbe;
    const manifest = yield* fromPromise(() =>
      readManifest(input.file, passphrase, {
        operation: INSPECT,
        onFrame: probe.onFrame,
        ...(options.limits === undefined ? {} : { limits: options.limits }),
      }),
    );

    const projects = yield* ProjectStore.ProjectStoreV2;
    let proposedProjectId: ProjectId | null = null;
    if (manifest.project.remoteUrl !== null) {
      for (const project of yield* projects.list().pipe(Effect.orDie)) {
        if (project.deletedAt !== null || !NodeFS.existsSync(project.workspaceRoot)) continue;
        if (remotesMatch(manifest.project.remoteUrl, yield* originUrl(project.workspaceRoot))) {
          proposedProjectId = project.projectId;
          break;
        }
      }
    }
    const sql = yield* SqlClient.SqlClient;
    const imports = yield* sql<{
      readonly project_id: ProjectId;
      readonly started_at: string;
      readonly ended_at: string | null;
    }>`
        SELECT project_id, started_at, ended_at FROM houston_transfer_imports
        WHERE transfer_id = ${manifest.transferId} AND state = 'done'
        ORDER BY started_at
      `.pipe(Effect.orDie);
    return {
      transferId: manifest.transferId,
      format: manifest.format,
      sourceOs: manifest.sourceOs,
      source: manifest.project,
      createdAt: manifest.createdAt,
      threads: manifest.threads.map((thread) => ({
        threadId: thread.sourceId as never,
        title: thread.title,
        provider: thread.provider,
        checkout: thread.checkout,
      })),
      skipped: manifest.skipped,
      checkouts: manifest.checkouts.map((checkout) => ({
        key: checkout.key,
        branch: checkout.branch,
        head: checkout.head,
        carriesCommits: checkout.bundle !== null,
        untracked: checkout.untracked.length,
        agentConfigPaths: agentConfigPaths(checkout.untracked, manifest.sourceOs),
      })),
      counts: manifest.counts,
      proposedProjectId,
      importedInto: imports.map((row) => ({
        projectId: row.project_id,
        importedAt: row.ended_at ?? row.started_at,
      })),
    } satisfies HoustonTransferFileSummary;
  }, Effect.provide(services));

  const subscribe: HoustonTransferService["Service"]["subscribe"] = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribing before the snapshot keeps every stage published during it.
        const subscription = yield* PubSub.subscribe(events);
        return Stream.concat(
          Stream.succeed({ type: "running" as const, running: [...running.values()] }),
          Stream.fromSubscription(subscription),
        );
      }),
    );

  return HoustonTransferService.of({ export: exportProject, inspect, subscribe });
});

export const layer = (options: ExportOptions = {}) =>
  Layer.effect(HoustonTransferService, make(options));
