// @effect-diagnostics nodeBuiltinImport:off - the user's home holds their own skills.
// Starts one review: refuses a second review of the project and a provider that cannot run
// read-only, writes the run directory, then starts the read-only review thread.
import * as NodeOS from "node:os";

import {
  CommandId,
  MessageId,
  type ModelSelection,
  type ProjectId,
  type ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import {
  HOUSTON_HARNESS_LIMITS,
  HoustonHarnessError,
  type HoustonHarnessRunNowResult,
  type HoustonHarnessTrigger,
} from "@t3tools/contracts/houston/harnessReview";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import { HARNESS_REVIEW_THREAD_PREFIX, hasReadOnlyRun } from "../sideThreads.ts";
import { buildDigest, type DigestThreadInput } from "./digest.ts";
import { buildInventory } from "./inventory.ts";
import { runDirectory, writeIgnoreFile } from "./runDirectory.ts";
import {
  findingDecision,
  OWN_RUN_DIR,
  reviewPrompt,
  reviewWindow,
  RUN_DIR_PARENT,
  RUN_DIRS_KEPT,
} from "./rules.ts";
import { HoustonHarnessStore } from "./Store.ts";

export const reviewThreadId = (reviewId: number) =>
  ThreadId.make(`${HARNESS_REVIEW_THREAD_PREFIX}${reviewId}`);
export const reviewMessageId = (reviewId: number) =>
  MessageId.make(`message:harness-review:${reviewId}`);
export const correctionMessageId = (reviewId: number, correction: number) =>
  MessageId.make(`message:harness-review:${reviewId}:correction-${correction}`);

const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause);

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export interface StartInput {
  readonly projectId: ProjectId;
  readonly modelSelection: ModelSelection;
  readonly trigger: HoustonHarnessTrigger;
  readonly scheduledTaskId: ScheduledTaskId | null;
}

export class HoustonHarnessRunner extends Context.Service<
  HoustonHarnessRunner,
  {
    /** `unsupported` names the instance and `read_only_run` when it cannot run read-only. */
    readonly ensureReadOnly: (
      operation: string,
      modelSelection: ModelSelection,
    ) => Effect.Effect<void, HoustonHarnessError>;
    readonly start: (
      input: StartInput,
    ) => Effect.Effect<HoustonHarnessRunNowResult, HoustonHarnessError>;
  }
>()("houston/houston/harnessReview/Runner/HoustonHarnessRunner") {}

const make = Effect.gen(function* () {
  const store = yield* HoustonHarnessStore;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;

  const ensureReadOnly: HoustonHarnessRunner["Service"]["ensureReadOnly"] = Effect.fn(
    "HoustonHarnessRunner.ensureReadOnly",
  )(function* (operation, modelSelection) {
    const instance = modelSelection.instanceId;
    const adapter = yield* adapters.get(instance).pipe(Effect.option);
    const capabilities = Option.isNone(adapter)
      ? undefined
      : yield* adapter.value.getCapabilities().pipe(Effect.orElseSucceed(() => undefined));
    if (capabilities !== undefined && hasReadOnlyRun(capabilities)) return;
    const driver = Option.isSome(adapter) ? adapter.value.driver : instance;
    return yield* new HoustonHarnessError({
      kind: "unsupported",
      operation,
      message: `A harness review on ${instance} needs a read-only run; ${driver} declares none (capability read_only_run)`,
    });
  });

  /** The project's threads with the records the digest reads, and their task keys. */
  const digestThreads = Effect.fn("HoustonHarnessRunner.digestThreads")(function* (
    projectId: ProjectId,
  ) {
    const snapshots = yield* Effect.forEach(["active", "archive"] as const, (location) =>
      projections.getShellSnapshot({ location, projectId }),
    );
    const ids = [
      ...new Set(
        snapshots.flatMap((snapshot) =>
          [...snapshot.threads, ...snapshot.archivedThreads].map((shell) => shell.id),
        ),
      ),
    ];
    const keys = new Map<string, string>();
    if (ids.length > 0) {
      const rows = yield* sql<{ thread_id: string; number: number }>`
        SELECT r.thread_id, t.number FROM houston_task_runs r
        JOIN houston_tasks t ON t.id = r.task_id
        WHERE r.thread_id IN ${sql.in(ids)}
      `;
      for (const row of rows) keys.set(row.thread_id, `HOU-${row.number}`);
    }
    return yield* Effect.forEach(ids, (threadId) =>
      projections.getThreadRecords(threadId, ["runs", "turnItems"]).pipe(
        Effect.map((records): DigestThreadInput => ({
          thread: records.thread,
          runs: records.runs,
          turnItems: records.turnItems,
          taskKey: keys.get(threadId) ?? null,
        })),
      ),
    );
  });

  /** decisions.json schema 2: each finding of the project with its decision and linked tasks. */
  const decisionsFile = Effect.fn("HoustonHarnessRunner.decisionsFile")(function* (
    projectId: ProjectId,
  ) {
    const rows = yield* store.findingRows(projectId);
    const decisions = new Map((yield* store.decisions(projectId)).map((row) => [row.key, row]));
    const newest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) if (!newest.has(row.key)) newest.set(row.key, row);
    return {
      schema: 2,
      minimum_sessions_after_landing: HOUSTON_HARNESS_LIMITS.minimumSessionsAfterLanding,
      findings: [...newest.values()].map((row) => {
        const decision = decisions.get(row.key);
        const read = findingDecision(
          decision === undefined ? null : { state: decision.state, decidedAt: decision.decided_at },
          row.review_ended_at,
        );
        return {
          key: row.key,
          title: row.title,
          state: read.state,
          decided_at: read.decidedAt,
          review_id: row.review_id,
          tasks: [] as ReadonlyArray<never>,
        };
      }),
    };
  });

  const start: HoustonHarnessRunner["Service"]["start"] = Effect.fn("HoustonHarnessRunner.start")(
    function* (input) {
      const operation = input.trigger === "scheduled" ? "scheduledRun" : "runNow";
      const project = yield* projects.get(input.projectId).pipe(
        Effect.orDie,
        Effect.flatMap((row) =>
          Option.isSome(row) && row.value.deletedAt === null
            ? Effect.succeed(row.value)
            : Effect.fail(
                new HoustonHarnessError({
                  kind: "not_found",
                  operation,
                  message: `project ${input.projectId} does not exist`,
                }),
              ),
        ),
      );
      yield* ensureReadOnly(operation, input.modelSelection);
      const now = yield* DateTime.now;
      const nowMs = DateTime.toEpochMillis(now);
      const earlier = yield* store.windows(input.projectId);
      const review = yield* store.openReview({
        projectId: input.projectId,
        trigger: input.trigger,
        scheduledTaskId: input.scheduledTaskId,
        providerInstanceId: input.modelSelection.instanceId,
        startedAt: DateTime.formatIso(now),
      });
      const failed = Effect.fn("HoustonHarnessRunner.failed")(function* (
        step: string,
        at: string,
        cause: unknown,
      ) {
        const message = `${step} failed at ${at}: ${errorText(cause)}`;
        const endedAt = DateTime.formatIso(yield* DateTime.now);
        yield* store.fail(review.id, { endedAt, error: message });
        return yield* new HoustonHarnessError({ kind: "invalid", operation, message });
      });
      const step = <A, E, R>(name: string, at: string, effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.catchCause((cause) => failed(name, at, cause)));

      const harnessDir = path.join(project.workspaceRoot, ...RUN_DIR_PARENT.split("/"));
      const runDir = path.join(project.workspaceRoot, ...review.runDir.split("/"));
      yield* step(
        "creating the run directory",
        runDir,
        runDirectory(project.workspaceRoot, review.runDir, { create: true }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        ),
      );
      const ignore = path.join(harnessDir, ".gitignore");
      yield* step(
        "writing the ignore file",
        ignore,
        writeIgnoreFile(ignore).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
      );
      const window = reviewWindow(nowMs, earlier);
      const inventory = yield* step(
        "the inventory",
        project.workspaceRoot,
        buildInventory({
          root: project.workspaceRoot,
          home: NodeOS.homedir(),
          generatedAt: DateTime.formatIso(now),
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        ),
      );
      const digest = yield* step(
        "the digest",
        runDir,
        digestThreads(input.projectId).pipe(
          Effect.map((threads) =>
            buildDigest({
              projectId: input.projectId,
              window,
              previousEnd: window.previousEnd,
              threads,
            }),
          ),
        ),
      );
      const decisions = yield* step("decisions.json", runDir, decisionsFile(input.projectId));
      const files: ReadonlyArray<readonly [string, string]> = [
        ["inventory.json", `${toJson(inventory)}\n`],
        ["digest.jsonl", digest.jsonl],
        ["digest-meta.json", `${toJson(digest.meta)}\n`],
        ["decisions.json", `${toJson(decisions)}\n`],
      ];
      for (const [name, content] of files) {
        const file = path.join(runDir, name);
        yield* step(`writing ${name}`, file, fs.writeFileString(file, content));
      }
      // Run directories beyond the newest RUN_DIRS_KEPT go; a missing or linked one is skipped.
      for (const old of yield* store.runDirsBeyond(input.projectId, RUN_DIRS_KEPT)) {
        if (!OWN_RUN_DIR.test(old)) continue;
        yield* runDirectory(project.workspaceRoot, old, { create: false }).pipe(
          Effect.flatMap((dir) => fs.remove(dir, { recursive: true })),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.ignoreCause,
        );
      }

      const threadId = reviewThreadId(review.id);
      yield* store.markRunning(review.id, {
        threadId,
        windowSince: iso(window.sinceMs),
        windowUntil: iso(window.untilMs),
        threads: digest.meta.threadsWritten,
        prompts: digest.meta.prompts,
      });
      yield* step(
        "starting the review thread",
        threadId,
        orchestrator.dispatch({
          type: "houston.harness-review.start",
          commandId: CommandId.make(`harness-review:${review.id}`),
          threadId,
          projectId: input.projectId,
          reviewId: review.id,
          modelSelection: input.modelSelection,
          messageId: reviewMessageId(review.id),
          text: reviewPrompt({ reviewId: review.id, runDir: review.runDir }),
        }),
      );
      return { reviewId: review.id, threadId };
    },
  );

  return HoustonHarnessRunner.of({ ensureReadOnly, start });
});

export const layer = Layer.effect(HoustonHarnessRunner, make);
