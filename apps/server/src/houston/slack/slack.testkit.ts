// Slack intake over one database with the real project and task services, the memory keychain,
// a recording `HoustonTaskRuns` fake and the loopback Slack fake (slack.fake.ts).
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ProjectId } from "@t3tools/contracts";
import type { HoustonSlackInfo } from "@t3tools/contracts/houston/slack";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import * as ServerConfig from "../../config.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as RuntimeLayer from "../../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../../project/ProjectEnrichmentService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { HostedLaunch } from "../baseDir.ts";
import { layerMemory, makeMemory, type MemoryKeychain } from "../secrets/HoustonKeychain.ts";
import { HoustonTaskRuns } from "../tasks/TaskRuns.ts";
import * as HoustonTaskService from "../tasks/TaskService.ts";
import { refuse } from "../tasks/rules.ts";
import * as HoustonTaskStore from "../tasks/TaskStore.ts";
import {
  HoustonTaskStore as TaskStoreService,
  nowIso,
  toRun,
  type RunRow,
} from "../tasks/TaskStore.ts";
import * as HoustonTaskV1Import from "../tasks/V1Import.ts";
import {
  CONFIGURED_INSTANCES,
  layerInstances,
  layerProjectMetadata,
  layerWorkspacePaths,
} from "../tasks/tasks.testkit.ts";
import { layerSlack } from "./layer.ts";
import { HoustonSlackService } from "./Service.ts";
import * as HoustonSlackStore from "./Store.ts";
import { SlackSocketTransport, layerSocketTransport } from "./Connection.ts";
import { makeSlackFake, type SlackFake } from "./slack.fake.ts";
import * as SlackWebApi from "./WebApi.ts";

export const APP_TOKEN = "xapp-1-A0TEST-1700000000-5f2c9d0e7a11b3";
export const BOT_TOKEN = "xoxb-1700000000-test-bot-token-9c41e7";
export const OWNER = "UOWNER";

/** Every `HoustonTaskRuns.start` the intake made; `failWith` refuses the next ones. */
export interface FakeRuns {
  readonly starts: Array<string>;
  failWith: string | null;
}

export const makeFakeRuns = (): FakeRuns => ({ starts: [], failWith: null });

const unused = () => Effect.die("unused in the Slack tests");

/** Start records a running implementation run, as the real start does once launched. */
export const layerFakeRuns = (fake: FakeRuns) =>
  Layer.effect(
    HoustonTaskRuns,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* TaskStoreService;
      return HoustonTaskRuns.of({
        start: (input) =>
          Effect.gen(function* () {
            const row = yield* store.resolve("houston.tasks.start", input.id);
            fake.starts.push(input.id);
            if (fake.failWith !== null) {
              return yield* refuse("invalid", "houston.tasks.start", fake.failWith);
            }
            const now = yield* nowIso;
            const run = yield* store.write(
              sql<RunRow>`
                INSERT INTO houston_task_runs (
                  task_id, attempt, kind, state, provider, initial_revision, started_at, thread_id
                ) VALUES (
                  ${row.id}, 1, 'implementation', 'running', 'claudeAgent', ${row.revision},
                  ${now}, ${`task-${row.id}`}
                ) RETURNING *
              `.pipe(
                Effect.orDie,
                Effect.map((rows) => ({ result: rows[0] as RunRow, touched: [row.id] })),
              ),
            );
            return { run: toRun(run) };
          }),
        runControl: unused,
        handback: unused,
        planStart: unused,
        planAnswer: unused,
        planApprove: unused,
        reviewStart: unused,
        planSubmit: unused,
        reviewSubmit: unused,
        // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
        agentWriteRefusal: () => Effect.succeed(undefined),
        catchUp: Effect.void,
      });
    }),
  );

export interface SlackTestOptions {
  readonly databaseFile?: string;
  readonly baseDir?: string;
  readonly keychain?: MemoryKeychain;
  /** The loopback fake's origin. */
  readonly slackOrigin: string;
  readonly runs?: FakeRuns;
  /** Wraps the socket transport, to block a write. */
  readonly transport?: (base: SlackSocketTransport["Service"]) => SlackSocketTransport["Service"];
}

const layerTransport = (options: SlackTestOptions) =>
  options.transport === undefined
    ? layerSocketTransport
    : Layer.effect(
        SlackSocketTransport,
        Effect.map(SlackSocketTransport, (base) => options.transport!(base)),
      ).pipe(Layer.provide(layerSocketTransport));

/** Tasks and the Slack intake as the server assembles them, with the test seams. */
export const layerSlackTest = (options: SlackTestOptions) =>
  layerSlack(
    Layer.mergeAll(SlackWebApi.layerTest(options.slackOrigin), layerTransport(options)),
  ).pipe(
    Layer.provideMerge(layerFakeRuns(options.runs ?? makeFakeRuns())),
    Layer.provideMerge(Layer.mergeAll(HoustonTaskService.layer, HoustonTaskV1Import.layer)),
    Layer.provideMerge(RuntimeLayer.layerProjectService),
    Layer.provideMerge(ProjectStore.layer),
    // Below the project service, so a project deletion reaches it, as in server.ts.
    Layer.provideMerge(HoustonSlackStore.layer),
    Layer.provideMerge(layerMemory(options.keychain ?? makeMemory())),
    Layer.provideMerge(HoustonTaskStore.layer),
    Layer.provideMerge(layerInstances(CONFIGURED_INSTANCES)),
    Layer.provideMerge(ProjectEnrichmentService.layer),
    Layer.provideMerge(layerWorkspacePaths),
    Layer.provideMerge(layerProjectMetadata),
    Layer.provideMerge(
      options.databaseFile === undefined
        ? Layer.fresh(SqlitePersistence.layerMemory)
        : Layer.fresh(SqlitePersistence.layerFromPath(options.databaseFile)),
    ),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), options.baseDir ?? { prefix: "houston-slack-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Layer.succeed(HostedLaunch, options.baseDir !== undefined)),
  );

/** Runs `body` against a fresh fake Slack and the Slack layers over it. */
export const runSlack = <A, E>(
  body: (fake: SlackFake) => Effect.Effect<A, E, Layer.Success<ReturnType<typeof layerSlackTest>>>,
  options: Omit<SlackTestOptions, "slackOrigin"> & {
    /** The test clock's time before the layers start their 5-second loops. */
    readonly startAtMs?: number;
  } = {},
) =>
  Effect.gen(function* () {
    if (options.startAtMs !== undefined) yield* TestClock.setTime(options.startAtMs);
    const fake = yield* makeSlackFake;
    return yield* body(fake).pipe(
      Effect.provide(layerSlackTest({ ...options, slackOrigin: fake.origin })),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

/** One real event-loop turn, so loopback sockets and HTTP make progress. */
export const realTurn = Effect.promise(
  // @effect-diagnostics-next-line globalTimers:off - real time, not the test clock: sockets need it.
  () => new Promise<void>((resolve) => setTimeout(resolve, 5)),
);

/** Waits in real time until `check` holds; dies naming `label` after about five seconds. */
export const until = <E, R>(label: string, check: Effect.Effect<boolean, E, R>) =>
  Effect.gen(function* () {
    for (let round = 0; round < 1_000; round += 1) {
      if (yield* check) return;
      yield* realTurn;
    }
    return yield* Effect.die(`timed out waiting for ${label}`);
  });

/** As `until`, moving the test clock one second per round; dies after 300 rounds. */
export const untilAdvancing = <E, R>(label: string, check: Effect.Effect<boolean, E, R>) =>
  Effect.gen(function* () {
    for (let round = 0; round < 300; round += 1) {
      if (yield* check) return;
      yield* TestClock.adjust("1 second");
      for (let turn = 0; turn < 4; turn += 1) yield* realTurn;
    }
    return yield* Effect.die(`timed out waiting for ${label}`);
  });

/** Moves the test clock in one-second steps, letting real I/O run between them. */
export const advance = (seconds: number) =>
  Effect.gen(function* () {
    for (let step = 0; step < seconds; step += 1) {
      yield* TestClock.adjust("1 second");
      yield* realTurn;
    }
  });

/** Maps `channels` to `projectId`, names the owner and connects with both tokens. */
export const connectSlack = (
  projectId: ProjectId,
  options: { readonly channels?: ReadonlyArray<string>; readonly owner?: string | null } = {},
) =>
  Effect.gen(function* () {
    const slack = yield* HoustonSlackService;
    yield* slack.configure({
      ...(options.owner === null ? {} : { ownerUserId: options.owner ?? OWNER }),
      channels: (options.channels ?? ["C1"]).map((channelId) => ({ channelId, projectId })),
    });
    return yield* slack.connect({
      appToken: Redacted.make(APP_TOKEN),
      botToken: Redacted.make(BOT_TOKEN),
    });
  });

/** Waits until the intake reports `connected`. */
export const untilConnected = until(
  "the Slack connection",
  Effect.flatMap(HoustonSlackService, (slack) => slack.get).pipe(
    Effect.map((info: HoustonSlackInfo) => info.connection === "connected"),
  ),
);
