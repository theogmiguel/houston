// The follower of bot runs: the state table read from a thread, who started each turn, and the
// start, stop, switch and restart paths over the real orchestrator and launcher.
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
} from "@houston-app/contracts";
import type { HoustonBotAskInput } from "@houston-app/contracts/houston/bots";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { USER_STOP_REASON } from "../../orchestration-v2/RunExecutionService.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import { editOf, LAPTOP, setSwitch } from "./bots.testkit.ts";
import {
  type BotContext,
  CLAUDE_ACCOUNT,
  dispatched,
  makeBotHarness,
  runBots,
} from "./runs.testkit.ts";
import {
  deriveBotRunState,
  isClientCommandId,
  latestRunOf,
  startedByOf,
  type BotRunRead,
  type RunRead,
} from "./runState.ts";

const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 10, 26, 9, minute));

const run = (ordinal: number, status: OrchestrationV2Run["status"], extra: Partial<RunRead> = {}) =>
  ({
    id: RunId.make(`run-${ordinal}`),
    ordinal,
    status,
    startedAt: status === "queued" ? null : at(ordinal),
    completedAt:
      status === "running" || status === "queued" || status === "starting" ? null : at(ordinal + 1),
    ...extra,
  }) as RunRead;

const read = (overrides: Partial<BotRunRead> = {}): BotRunRead => ({
  kind: "asked",
  stop: null,
  thread: {
    deleted: false,
    archived: false,
    pendingRuntimeRequest: false,
    pendingBackground: false,
    lastError: null,
  },
  runs: [run(1, "completed")],
  continuationPending: false,
  interrupt: null,
  ...overrides,
});

const thread = (overrides: Partial<BotRunRead["thread"]>) => ({ ...read().thread, ...overrides });

describe("the state of a bot run, read from its thread", () => {
  it("a deleted or archived thread stopped it, whatever its runs say", () => {
    assert.deepEqual(deriveBotRunState(read({ thread: thread({ deleted: true }) })), {
      state: "stopped",
      reason: "the thread was deleted",
    });
    assert.deepEqual(
      deriveBotRunState(read({ thread: thread({ archived: true }), runs: [run(1, "running")] })),
      { state: "stopped", reason: "the thread was archived" },
    );
  });

  it("a question waits for the owner in an asked bot run only", () => {
    const waiting = read({
      runs: [run(1, "running")],
      thread: thread({ pendingRuntimeRequest: true }),
    });
    assert.deepEqual(deriveBotRunState(waiting), { state: "waiting", reason: null });
    assert.deepEqual(deriveBotRunState({ ...waiting, kind: "unattended" }), {
      state: "running",
      reason: null,
    });
  });

  it("is running while a run prepares, starts or runs, or is queued and not held", () => {
    for (const status of ["preparing", "starting", "running", "waiting"] as const) {
      assert.strictEqual(deriveBotRunState(read({ runs: [run(1, status)] })).state, "running");
    }
    assert.strictEqual(
      deriveBotRunState(read({ runs: [run(1, "completed"), run(2, "queued")] })).state,
      "running",
    );
  });

  it("background only: running while the shell lists pending work, in both kinds", () => {
    for (const kind of ["asked", "unattended"]) {
      assert.deepEqual(
        deriveBotRunState(read({ kind, thread: thread({ pendingBackground: true }) })),
        { state: "running", reason: null },
      );
    }
  });

  it("a server restart with a pending continuation stays running, never 'you stopped it'", () => {
    const interrupted = read({
      runs: [run(1, "interrupted")],
      continuationPending: true,
      interrupt: { message: USER_STOP_REASON, byClient: false },
    });
    assert.deepEqual(deriveBotRunState(interrupted), { state: "running", reason: null });
  });

  it("a held message after a stop is not running: stopped, and a message is waiting", () => {
    assert.deepEqual(
      deriveBotRunState(
        read({
          runs: [run(1, "interrupted"), run(2, "queued", { queueHeld: true })],
          interrupt: { message: USER_STOP_REASON, byClient: true },
        }),
      ),
      { state: "stopped", reason: "you stopped it; a message is waiting" },
    );
  });

  it("a removed queued message is ignored: the bot run stays finished", () => {
    assert.deepEqual(
      deriveBotRunState(
        read({ runs: [run(1, "completed"), run(2, "cancelled", { startedAt: null })] }),
      ),
      { state: "finished", reason: "no result handed back" },
    );
  });

  it("rolled back runs and runs that never started leave nothing to read", () => {
    assert.deepEqual(deriveBotRunState(read({ runs: [run(1, "rolled_back")] })), {
      state: "stopped",
      reason: "the owner went back to before it",
    });
    assert.deepEqual(
      deriveBotRunState(read({ runs: [run(1, "cancelled", { startedAt: null })] })),
      { state: "stopped", reason: "stopped before it started" },
    );
    assert.deepEqual(deriveBotRunState(read({ runs: [] })), {
      state: "stopped",
      reason: "stopped before it started",
    });
  });

  it("a worktree preparation that failed never started, and stays visible as failed", () => {
    assert.deepEqual(
      deriveBotRunState(
        read({
          runs: [run(1, "failed", { startedAt: null })],
          thread: thread({ lastError: "Could not create the worktree: base main is missing" }),
        }),
      ),
      { state: "failed", reason: "Could not create the worktree: base main is missing" },
    );
  });

  it("a failed run's error is shown with credentials masked", () => {
    const failed = deriveBotRunState(
      read({
        runs: [run(1, "failed")],
        thread: thread({ lastError: "request failed: Authorization: Bearer abcdefghijklmnop" }),
      }),
    );
    assert.strictEqual(failed.state, "failed");
    assert.notInclude(failed.reason ?? "", "abcdefghijklmnop");
  });

  it("the latest run is the newest that ran, by completion, not by ordinal", () => {
    const runs = [run(1, "completed"), run(2, "interrupted", { completedAt: at(0) })];
    assert.strictEqual(latestRunOf(runs)?.id, "run-1");
    assert.strictEqual(deriveBotRunState(read({ runs })).state, "finished");
  });

  describe("why it stopped", () => {
    const stopped = (overrides: Partial<BotRunRead>) =>
      deriveBotRunState(read({ runs: [run(1, "completed"), run(2, "interrupted")], ...overrides }));

    it("Houston's own reason, when it was recorded for that thread run", () => {
      assert.deepEqual(
        stopped({ stop: { runId: "run-2", reason: "Labs ▸ Bots was turned off" } }),
        {
          state: "stopped",
          reason: "Labs ▸ Bots was turned off",
        },
      );
    });

    it("a reason recorded for an older thread run does not explain a later one", () => {
      assert.deepEqual(
        stopped({
          stop: { runId: "run-1", reason: "ran for 20 of 20 minutes" },
          interrupt: { message: "the agent stopped it", byClient: false },
        }),
        { state: "stopped", reason: "interrupted: the agent stopped it" },
      );
    });

    it("a client's stop is 'you stopped it'", () => {
      assert.deepEqual(stopped({ interrupt: { message: USER_STOP_REASON, byClient: true } }), {
        state: "stopped",
        reason: "you stopped it",
      });
    });

    it("an agent's stop without a reason, or with the user's words, is only 'interrupted'", () => {
      assert.deepEqual(stopped({ interrupt: { message: USER_STOP_REASON, byClient: false } }), {
        state: "stopped",
        reason: "interrupted",
      });
    });

    it("a stop with another message names it; no item adds nothing", () => {
      assert.deepEqual(stopped({ interrupt: { message: "Superseded", byClient: true } }), {
        state: "stopped",
        reason: "interrupted: Superseded",
      });
      assert.deepEqual(stopped({ interrupt: null }), { state: "stopped", reason: "interrupted" });
    });
  });

  it("a stored kind this build does not know is followed like the unattended kind", () => {
    const question = read({
      runs: [run(1, "running")],
      thread: thread({ pendingRuntimeRequest: true }),
    });
    assert.strictEqual(deriveBotRunState({ ...question, kind: "nightly" }).state, "running");
  });
});

describe("who started a turn", () => {
  const message = (id: string, extra: { readonly scheduledTaskId?: string } = {}) => ({
    id: MessageId.make(id),
    createdBy: "user" as const,
    ...extra,
  });

  it("the owner: the opening of an asked bot run, an owner action, and any message they typed", () => {
    const owner = { botRunId: "b1", origin: "owner", child: false };
    assert.strictEqual(startedByOf({ ...owner, message: message("bot-run:b1") }), "owner");
    assert.strictEqual(startedByOf({ ...owner, message: message("bot-owner:r9") }), "owner");
    assert.strictEqual(startedByOf({ ...owner, message: message("composer-1") }), "owner");
  });

  it("an answer to a parked question is the owner's, whatever its source", () => {
    assert.strictEqual(
      startedByOf({
        botRunId: "b1",
        origin: "routine",
        child: false,
        message: { id: MessageId.make("answer-1"), createdBy: "user" },
      }),
      "owner",
    );
  });

  it("Houston: a routine's opening, agent messages, scheduled prompts and every child turn", () => {
    const routine = { botRunId: "b1", origin: "routine", child: false };
    assert.strictEqual(
      startedByOf({
        ...routine,
        message: { id: MessageId.make("bot-run:b1"), createdBy: "agent" },
      }),
      "houston",
    );
    assert.strictEqual(
      startedByOf({ ...routine, message: { id: MessageId.make("wake-1"), createdBy: "agent" } }),
      "houston",
    );
    assert.strictEqual(
      startedByOf({ ...routine, message: message("scheduled-1", { scheduledTaskId: "task" }) }),
      "houston",
    );
    assert.strictEqual(
      startedByOf({ botRunId: "b1", origin: "owner", child: true, message: message("composer-1") }),
      "houston",
    );
    assert.strictEqual(startedByOf({ ...routine, message: undefined }), "houston");
  });

  it("a client's command id is a bare uuid; agents' and Houston's carry a prefix", () => {
    assert.isTrue(isClientCommandId("3f2b8c1e-9a4d-4f6b-8e21-5c7d9a0b1e2f"));
    assert.isFalse(isClientCommandId("command:mcp:ns:stop:1"));
    assert.isFalse(isClientCommandId("houston-bot-run:b1:stop:run-2"));
    assert.isFalse(isClientCommandId(null));
  });
});

const rowOf = (botRunId: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{
      readonly state: string;
      readonly reason: string | null;
      readonly revision_n: number;
      readonly stop_reason: string | null;
      readonly launch_json: string | null;
    }>`SELECT * FROM houston_bot_runs WHERE id = ${botRunId}`.pipe(
      Effect.map((rows) => rows[0]),
      Effect.orDie,
    ),
  );

describe("bot runs over real threads", () => {
  const harnessed = <A, E, R>(
    name: string,
    body: (context: BotContext) => Effect.Effect<A, E, R>,
    options: Parameters<typeof runBots>[2] = {},
  ) =>
    Effect.flatMap(makeBotHarness(name), (harness) => runBots(harness, body, options)).pipe(
      Effect.scoped,
    );

  const turnsOf = (botRunId: string) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{ readonly started_by: string; readonly local_date: string }>`
        SELECT started_by, local_date FROM houston_bot_turns WHERE bot_run_id = ${botRunId}
      `.pipe(Effect.orDie),
    );

  const ask = (
    context: BotContext,
    botId: string,
    requestId: string,
    ownerText = "What changed?",
  ) => context.runs.ask({ requestId, botId, ownerText });

  it.effect(
    "asking starts one marked thread with the pinned revision; the same click never starts two",
    () =>
      harnessed("ask", (context) =>
        Effect.gen(function* () {
          const bot = yield* context.makeBot();
          const first = yield* ask(context, bot.id, "click-1");
          const again = yield* ask(context, bot.id, "click-1");
          assert.deepEqual(again, first);
          yield* context.until(
            "the bot run to finish",
            Effect.map(rowOf(first.botRunId), (row) => row?.state === "finished"),
          );
          const shell = yield* context.orchestrator.getThreadShell(ThreadId.make(first.threadId));
          assert.deepEqual(shell?.houstonBot, {
            botId: bot.id,
            botRunId: first.botRunId,
            kind: "asked",
          });
          const { messages } = yield* context.orchestrator.getThreadRecords(
            ThreadId.make(first.threadId),
            ["messages"],
            { messageRoles: ["user"] },
          );
          assert.strictEqual(messages.length, 1);
          assert.strictEqual(messages[0]?.id, `bot-run:${first.botRunId}`);
          assert.isTrue(
            messages[0]?.text.startsWith(
              `<houston-bot run="${first.botRunId}" bot="${bot.slug}" revision="1">`,
            ),
          );
          assert.isTrue(messages[0]?.text.endsWith("</houston-bot>\nWhat changed?"));
          const started = context.harness.doubles.log.started.filter(
            (turn) => turn.input.threadId === first.threadId,
          );
          assert.strictEqual(started.length, 1);
          const finished = yield* rowOf(first.botRunId);
          assert.deepEqual(
            {
              state: finished?.state,
              reason: finished?.reason,
              revision_n: finished?.revision_n,
              launch_json: finished?.launch_json,
            },
            {
              state: "finished",
              reason: "no result handed back",
              revision_n: 1,
              launch_json: null,
            },
          );
          assert.deepEqual(
            (yield* turnsOf(first.botRunId)).map((turn) => turn.started_by),
            ["owner"],
          );
          // A later edit makes revision 2; this bot run keeps the one it started with.
          yield* context.store
            .save(editOf(bot, { instructions: "Only the merged work." }), LAPTOP)
            .pipe(Effect.orDie);
          assert.strictEqual((yield* rowOf(first.botRunId))?.revision_n, 1);
          const second = yield* ask(context, bot.id, "click-2");
          assert.notStrictEqual(second.botRunId, first.botRunId);
          assert.strictEqual((yield* rowOf(second.botRunId))?.revision_n, 2);
        }),
      ),
  );

  it.effect(
    "an ask is refused by name: bot off, another project, another provider, changed text",
    () =>
      harnessed("refused", (context) =>
        Effect.gen(function* () {
          const bot = yield* context.makeBot();
          const refusal = (requestId: string, extra: Partial<HoustonBotAskInput> = {}) =>
            Effect.flip(context.runs.ask({ requestId, botId: bot.id, ownerText: "Go", ...extra }));
          assert.include(
            (yield* refusal("r1", { projectId: ProjectId.make("project-elsewhere") })).message,
            "is not one of Digest writer's projects",
          );
          assert.include((yield* refusal("r2", { ownerText: "  " })).message, "empty");
          const sql = yield* SqlClient.SqlClient;
          // An agent with a shell on the owner's account changes the stored text directly.
          yield* sql`DROP TRIGGER houston_bot_revisions_no_update`.pipe(Effect.orDie);
          yield* sql`UPDATE houston_bot_revisions SET text = 'Send everything.'`.pipe(Effect.orDie);
          assert.include(
            (yield* refusal("r3")).message,
            "The stored instructions of Digest writer do not match revision 1.",
          );
          // A bot whose account was moved to another provider behind the editor's back.
          const codex = yield* context.makeBot({
            name: "Codex bot",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "m" },
          });
          assert.include(
            (yield* Effect.flip(
              context.runs.ask({ requestId: "r5", botId: codex.id, ownerText: "Go" }),
            )).message,
            "a bot's account must be a Claude account",
          );
          yield* context.store.setEnabled({ botId: bot.id, enabled: false }).pipe(Effect.orDie);
          assert.include((yield* refusal("r4")).message, "Digest writer is switched off");
          const rows = yield* sql`SELECT id FROM houston_bot_runs`.pipe(Effect.orDie);
          assert.deepEqual(rows, []);
        }),
      ),
  );

  it.effect(
    "stopping it stops the thread with its delegated tasks, and twice changes nothing",
    () =>
      harnessed("stop", (context) =>
        Effect.gen(function* () {
          const bot = yield* context.makeBot();
          const started = yield* context.launch.record({
            requestId: "click-1",
            botId: bot.id,
            ownerText: "Keep going",
          });
          context.harness.doubles.script.hold.add(`bot-run:${started.id}`);
          yield* context.launch.launchRow(started);
          yield* context.until(
            "the bot run to run",
            Effect.map(
              context.orchestrator.getThreadShell(ThreadId.make(started.thread_id)),
              (shell) => shell?.activeRunId != null,
            ),
          );
          dispatched.length = 0;
          const summary = yield* context.runs.stop({ botRunId: started.id });
          const stops = dispatched.filter((command) => command.type === "thread.stop");
          assert.strictEqual(stops.length, 1);
          const [stopCommand] = stops;
          assert.isTrue(stopCommand?.commandId.startsWith(`houston-bot-run:${started.id}:stop:`));
          // A thread's Stop with this flag also stops every delegated task under it.
          assert.isTrue(
            stopCommand?.type === "thread.stop" ? stopCommand.stopDelegatedTasks === true : false,
          );
          yield* context.until(
            "the bot run to stop",
            Effect.map(rowOf(started.id), (row) => row?.state === "stopped"),
          );
          assert.strictEqual((yield* rowOf(started.id))?.reason, "you stopped it");
          assert.strictEqual(summary.id, started.id);
          const twice = yield* context.runs.stop({ botRunId: started.id });
          assert.strictEqual(twice.state, "stopped");
          assert.strictEqual(
            dispatched.filter((command) => command.type === "thread.stop").length,
            1,
          );
        }),
      ),
  );

  it.effect("Labs ▸ Bots off stops an unattended bot run, and leaves the owner's asked one", () =>
    harnessed("off", (context) =>
      Effect.gen(function* () {
        const bot = yield* context.makeBot();
        const sql = yield* SqlClient.SqlClient;
        const started = [];
        for (const requestId of ["unattended", "asked"]) {
          const row = yield* context.launch.record({ requestId, botId: bot.id, ownerText: "Go" });
          context.harness.doubles.script.hold.add(`bot-run:${row.id}`);
          if (requestId === "unattended") {
            yield* sql`UPDATE houston_bot_runs SET kind = 'unattended', origin = 'test' WHERE id = ${row.id}`.pipe(
              Effect.orDie,
            );
          }
          yield* context.launch.launchRow(row);
          started.push(row);
        }
        const [unattended, asked] = started;
        yield* context.until(
          "both bot runs to run",
          Effect.map(
            Effect.forEach(started, (row) =>
              context.orchestrator.getThreadShell(ThreadId.make(row.thread_id)),
            ),
            (shells) => shells.every((shell) => shell?.activeRunId != null),
          ),
        );
        yield* setSwitch(false);
        yield* context.until(
          "the unattended bot run to stop",
          Effect.map(rowOf(unattended!.id), (row) => row?.state === "stopped"),
        );
        assert.strictEqual((yield* rowOf(unattended!.id))?.reason, "Labs ▸ Bots was turned off");
        assert.strictEqual((yield* rowOf(asked!.id))?.state, "running");
        assert.isNull((yield* rowOf(asked!.id))?.stop_reason ?? null);
      }),
    ),
  );

  it.effect("lists a bot's runs newest first, a page at a time, unknown literals as other", () =>
    harnessed("list", (context) =>
      Effect.gen(function* () {
        const bot = yield* context.makeBot();
        const sql = yield* SqlClient.SqlClient;
        const ids: Array<string> = [];
        for (const [index, requestId] of ["older", "newer"].entries()) {
          const row = yield* context.launch.record({ requestId, botId: bot.id, ownerText: "Go" });
          yield* sql`
            UPDATE houston_bot_runs SET started_at = ${`2026-11-26T09:0${index}:00.000Z`}
            WHERE id = ${row.id}
          `.pipe(Effect.orDie);
          ids.push(row.id);
        }
        // Written by a newer server, read by this one.
        yield* sql`
          UPDATE houston_bot_runs SET kind = 'later-kind', state = 'later-state' WHERE id = ${ids[1]!}
        `.pipe(Effect.orDie);
        const page = yield* context.runs.list({ botId: bot.id });
        assert.deepEqual(
          page.runs.map((summary) => [summary.id, summary.kind, summary.state]),
          [
            [ids[1], "other", "other"],
            [ids[0], "asked", "running"],
          ],
        );
        assert.isFalse(page.hasMore);
        const before = yield* context.runs.list({
          botId: bot.id,
          before: page.runs[0]!.startedAt,
        });
        assert.deepEqual(
          before.runs.map((summary) => summary.id),
          [ids[0]],
        );
      }),
    ),
  );

  it.effect("an ordinary thread is followed by nothing: no bot run, no turn", () =>
    harnessed("ordinary", (context) =>
      Effect.gen(function* () {
        const launcher = yield* ThreadLaunch.ThreadLaunchService;
        yield* launcher.launch({
          commandId: CommandId.make("ordinary-launch"),
          threadId: ThreadId.make("ordinary-thread"),
          projectId: context.projectId,
          title: "Ordinary",
          modelSelection: { instanceId: CLAUDE_ACCOUNT, model: "test-model" },
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: { text: "Hello", attachments: [] },
          createdBy: "user",
          creationSource: "web",
        });
        yield* context.settle;
        const sql = yield* SqlClient.SqlClient;
        assert.deepEqual(yield* sql`SELECT * FROM houston_bot_turns`.pipe(Effect.orDie), []);
        assert.deepEqual(yield* sql`SELECT * FROM houston_bot_runs`.pipe(Effect.orDie), []);
      }),
    ),
  );
});

describe("bot runs across a restart", () => {
  it.effect(
    "a launch the server did not finish is repeated with the same ids, within its limit",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeBotHarness("restart");
        const databaseFile = `${harness.root}/state.sqlite`;
        const recorded = yield* runBots(
          harness,
          (context) =>
            Effect.gen(function* () {
              const bot = yield* context.makeBot();
              const fresh = yield* context.launch.record({
                requestId: "fresh",
                botId: bot.id,
                ownerText: "Go",
              });
              const old = yield* context.launch.record({
                requestId: "old",
                botId: bot.id,
                ownerText: "Go",
              });
              const sql = yield* SqlClient.SqlClient;
              yield* sql`
              UPDATE houston_bot_runs SET started_at = '1969-12-31T23:49:00.000Z' WHERE id = ${old.id}
            `.pipe(Effect.orDie);
              return { fresh, old, projectId: context.projectId };
            }),
          { databaseFile },
        );
        yield* runBots(
          harness,
          (context) =>
            Effect.gen(function* () {
              yield* context.until(
                "the repeated launch to finish",
                Effect.map(rowOf(recorded.fresh.id), (row) => row?.state === "finished"),
              );
              const shell = yield* context.orchestrator.getThreadShell(
                ThreadId.make(recorded.fresh.thread_id),
              );
              assert.strictEqual(shell?.houstonBot?.botRunId, recorded.fresh.id);
              assert.deepEqual(
                {
                  state: (yield* rowOf(recorded.old.id))?.state,
                  reason: (yield* rowOf(recorded.old.id))?.reason,
                },
                { state: "failed", reason: "Houston stopped before it started" },
              );
            }),
          { databaseFile, restarted: true, projectId: recorded.projectId },
        );
      }).pipe(Effect.scoped),
  );
});
