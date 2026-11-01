// Slack intake over one database with the real project and task services, the memory keychain,
// a recording `HoustonTaskRuns` fake and the loopback Slack fake (slack.fake.ts).
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ProjectId } from "@t3tools/contracts";
import type { HoustonSlackInfo } from "@t3tools/contracts/houston/slack";
import type { HoustonTaskError } from "@t3tools/contracts/houston/tasks";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
  type TaskRow,
} from "../tasks/TaskStore.ts";
import * as HoustonTaskV1Import from "../tasks/V1Import.ts";
import {
  CONFIGURED_INSTANCES,
  createProject,
  layerInstances,
  layerProjectMetadata,
  layerWorkspacePaths,
} from "../tasks/tasks.testkit.ts";
import { slackBriefOf } from "./Brief.ts";
import { layerSlack } from "./layer.ts";
import { HoustonSlackRunMessages } from "./RunMessages.ts";
import { HoustonSlackService } from "./Service.ts";
import * as HoustonSlackStore from "./Store.ts";
import { SlackSocketTransport, layerSocketTransport } from "./Connection.ts";
import { HoustonSlackOutbox } from "./Outbox.ts";
import { HoustonSlackReplies } from "./Replies.ts";
import {
  FAKE_TEAM,
  interactiveEnvelope,
  makeSlackFake,
  mentionEnvelope,
  mentionEvent,
  type SlackFake,
  type SlackFakeCall,
} from "./slack.fake.ts";
import * as SlackWebApi from "./WebApi.ts";

export const APP_TOKEN = "xapp-1-A0TEST-1700000000-5f2c9d0e7a11b3";
export const BOT_TOKEN = "xoxb-1700000000-test-bot-token-9c41e7";
export const OWNER = "UOWNER";

/** Every `HoustonTaskRuns` call Slack made; `failWith` and `handbackFail` refuse the next ones. */
export interface FakeRuns {
  readonly starts: Array<string>;
  failWith: string | null;
  readonly handbacks: Array<{ readonly id: string; readonly summary: string }>;
  handbackFail: HoustonTaskError | null;
  /** New attempts, each with the Slack part of the brief it would be sent. */
  readonly attempts: Array<{
    readonly runId: number;
    readonly action: string;
    readonly description: string | null;
  }>;
  /** The pull request a hand-back records on its run. */
  prUrl: string | null;
}

export const makeFakeRuns = (): FakeRuns => ({
  starts: [],
  failWith: null,
  handbacks: [],
  handbackFail: null,
  attempts: [],
  prUrl: null,
});

/** Every answer the intake delivered to a run's thread; one per question, as the command is. */
export interface FakeMessages {
  readonly delivered: Array<{
    readonly threadId: string;
    readonly questionId: number;
    readonly text: string;
  }>;
  failWith: string | null;
}

export const makeFakeMessages = (): FakeMessages => ({ delivered: [], failWith: null });

export const layerFakeMessages = (fake: FakeMessages) =>
  Layer.succeed(
    HoustonSlackRunMessages,
    HoustonSlackRunMessages.of({
      deliver: (input) =>
        Effect.suspend(() => {
          if (fake.failWith !== null) return Effect.fail(fake.failWith);
          if (!fake.delivered.some((entry) => entry.questionId === input.questionId)) {
            fake.delivered.push(input);
          }
          return Effect.void;
        }),
    }),
  );

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
                  task_id, attempt, kind, state, provider, initial_revision, started_at, thread_id,
                  branch
                ) VALUES (
                  ${row.id}, 1, 'implementation', 'running', 'claudeAgent', ${row.revision},
                  ${now}, ${`task-${row.id}`}, ${`houston/task-${row.id}`}
                ) RETURNING *
              `.pipe(
                Effect.orDie,
                Effect.map((rows) => ({ result: rows[0] as RunRow, touched: [row.id] })),
              ),
            );
            return { run: toRun(run) };
          }),
        claim: unused,
        agentHandback: unused,
        execute: unused,
        taskOfRun: unused,
        runControl: (input) =>
          Effect.gen(function* () {
            const [previous] = yield* sql<RunRow>`
              SELECT * FROM houston_task_runs WHERE id = ${input.runId}
            `.pipe(Effect.orDie);
            if (previous === undefined) {
              return yield* refuse(
                "not_found",
                "houston.tasks.runControl",
                `no run ${input.runId}`,
              );
            }
            const task = (yield* store.taskById(previous.task_id)) as TaskRow;
            const brief = yield* slackBriefOf(task).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
            );
            fake.attempts.push({
              runId: input.runId,
              action: input.action,
              description: Option.isSome(brief) ? brief.value.description : null,
            });
            const now = yield* nowIso;
            const attempt = previous.attempt + 1;
            const run = yield* store.write(
              Effect.gen(function* () {
                yield* sql`
                  UPDATE houston_tasks SET status = 'in_progress', revision = revision + 1
                  WHERE id = ${task.id}
                `.pipe(Effect.orDie);
                const rows = yield* sql<RunRow>`
                  INSERT INTO houston_task_runs (
                    task_id, attempt, kind, state, provider, initial_revision, started_at,
                    thread_id, branch
                  ) VALUES (
                    ${task.id}, ${attempt}, 'implementation', 'running', 'claudeAgent',
                    ${task.revision + 1}, ${now}, ${`task-${task.id}-${attempt}`},
                    ${previous.branch}
                  ) RETURNING *
                `.pipe(Effect.orDie);
                return { result: rows[0] as RunRow, touched: [task.id] };
              }),
            );
            return toRun(run);
          }),
        handback: (input) =>
          Effect.gen(function* () {
            const row = yield* store.resolve("houston.tasks.handback", input.id);
            fake.handbacks.push({ id: input.id, summary: input.summary });
            if (fake.handbackFail !== null) return yield* fake.handbackFail;
            const now = yield* nowIso;
            const run = yield* store.write(
              Effect.gen(function* () {
                const rows = yield* sql<RunRow>`
                  UPDATE houston_task_runs SET state = 'handed_back', ended_at = ${now},
                    summary = ${input.summary}, pr_url = ${fake.prUrl}
                  WHERE id = (
                    SELECT id FROM houston_task_runs
                    WHERE task_id = ${row.id} AND kind = 'implementation'
                    ORDER BY id DESC LIMIT 1
                  ) RETURNING *
                `.pipe(Effect.orDie);
                yield* sql`
                  UPDATE houston_tasks SET status = 'in_review', revision = revision + 1
                  WHERE id = ${row.id}
                `.pipe(Effect.orDie);
                return { result: rows[0] as RunRow, touched: [row.id] };
              }),
            );
            return toRun(run);
          }),
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
  readonly messages?: FakeMessages;
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
    Layer.mergeAll(
      SlackWebApi.layerTest(options.slackOrigin),
      layerTransport(options),
      layerFakeMessages(options.messages ?? makeFakeMessages()),
    ),
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

// The conversation after filing: envelopes, ticks and a request already at work.

let envelopeCount = 0;

/** Sends `envelope` on the newest socket. */
export const sendEnvelope = (fake: SlackFake, envelope: Record<string, unknown>) =>
  Effect.sync(() => fake.sockets.at(-1)?.send(envelope));

export const sendEvent = (fake: SlackFake, event: Record<string, unknown>) =>
  sendEnvelope(fake, mentionEnvelope(`k${(envelopeCount += 1)}`, event));

export const sendInteraction = (fake: SlackFake, payload: Record<string, unknown>) =>
  sendEnvelope(fake, interactiveEnvelope(`k${(envelopeCount += 1)}`, payload));

/** A message in the thread of `threadTs` in `C1`. */
export const replyEvent = (
  ts: string,
  threadTs: string,
  user: string,
  text: string,
): Record<string, unknown> => ({
  type: "message",
  channel: "C1",
  user,
  team: FAKE_TEAM,
  ts,
  thread_ts: threadTs,
  text,
});

export const reactionEvent = (user: string, name: string, ts: string): Record<string, unknown> => ({
  type: "reaction_added",
  user,
  reaction: name,
  item: { type: "message", channel: "C1", ts },
  event_ts: ts,
});

/** A click on `button` of a posted message, by `user`. */
export const clickEvent = (
  user: string,
  button: { readonly action_id: string; readonly value: string },
): Record<string, unknown> => ({
  type: "block_actions",
  user: { id: user },
  team: { id: FAKE_TEAM },
  channel: { id: "C1" },
  trigger_id: `trigger-${(envelopeCount += 1)}`,
  actions: [{ ...button, action_ts: `${envelopeCount}` }],
});

export interface PostedButton {
  readonly action_id: string;
  readonly value: string;
  readonly style?: string;
  readonly text: { readonly text: string };
}

/** The buttons of a `chat.postMessage` or `chat.update` call. */
export const buttonsOf = (call: SlackFakeCall | undefined): ReadonlyArray<PostedButton> =>
  (
    JSON.parse(call?.body.blocks ?? "[]") as ReadonlyArray<{
      readonly elements?: ReadonlyArray<PostedButton>;
    }>
  ).flatMap((block) => block.elements ?? []);

/** Text and blocks of a call, for `include` checks. */
export const postedText = (call: SlackFakeCall | undefined) =>
  `${call?.body.text ?? ""}\n${call?.body.blocks ?? ""}`;

/** Every post in the thread of `ts`. */
export const threadPosts = (fake: SlackFake, ts: string) =>
  fake.callsOf("chat.postMessage").filter((call) => call.body.thread_ts === ts);

/** Every direct message to the owner. */
export const ownerDms = (fake: SlackFake) =>
  fake.callsOf("chat.postMessage").filter((call) => call.body.channel === `D${OWNER}`);

export const flushOutbox = Effect.flatMap(HoustonSlackOutbox, (outbox) =>
  Effect.gen(function* () {
    for (let round = 0; round < 6; round += 1) yield* outbox.tick;
  }),
);

export const tickReplies = Effect.flatMap(HoustonSlackReplies, (replies) => replies.tick);

export interface StoredRequest {
  readonly id: number;
  readonly ts: string;
  readonly state: string;
  readonly task_id: number | null;
  readonly status_reaction: string | null;
}

export const storedRequest = (ts: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<StoredRequest>`SELECT * FROM houston_slack_requests WHERE ts = ${ts}`;
    return rows[0];
  });

/** The newest implementation run of `taskId`. */
export const latestRun = (taskId: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<RunRow>`
      SELECT * FROM houston_task_runs WHERE task_id = ${taskId} AND kind = 'implementation'
      ORDER BY id DESC LIMIT 1
    `;
    return rows[0] as RunRow;
  });

/** Configures `C1` for a new project with the owner and connects. */
export const connectedProject = (name: string, owner: string | null = OWNER) =>
  Effect.gen(function* () {
    const projectId = yield* createProject(name);
    yield* connectSlack(projectId, { owner });
    yield* untilConnected;
    return projectId;
  });

/** U2's mention at `ts`, filed, made ready and accepted by the owner's ✅. */
export const startedRequest = (fake: SlackFake, ts: string, text: string) =>
  Effect.gen(function* () {
    const tasks = yield* HoustonTaskService.HoustonTaskService;
    yield* sendEvent(fake, mentionEvent(ts, text));
    yield* until(`${ts} filed`, storedRequest(ts).pipe(Effect.map((row) => row?.task_id != null)));
    const filed = (yield* storedRequest(ts)) as StoredRequest;
    const taskId = filed.task_id as number;
    const detail = yield* tasks.get({ id: String(taskId) });
    yield* tasks.save({
      id: detail.task.key,
      expectedRevision: detail.task.revision,
      patch: { acceptance: ["it works"] },
    });
    yield* sendEvent(fake, reactionEvent(OWNER, "white_check_mark", ts));
    yield* until(
      `${ts} started`,
      storedRequest(ts).pipe(Effect.map((row) => row?.state === "started")),
    );
    const run = yield* latestRun(taskId);
    return {
      requestId: filed.id,
      taskId,
      key: detail.task.key,
      threadId: run.thread_id as string,
      runId: run.id,
    };
  });

/** Sets the task's status as the user does in Houston. */
export const setTaskStatus = (taskId: number, status: "done" | "canceled") =>
  Effect.gen(function* () {
    const tasks = yield* HoustonTaskService.HoustonTaskService;
    const detail = yield* tasks.get({ id: String(taskId) });
    yield* tasks.save({
      id: detail.task.key,
      expectedRevision: detail.task.revision,
      patch: { status },
    });
  });
