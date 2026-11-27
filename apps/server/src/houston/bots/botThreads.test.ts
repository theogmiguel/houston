import { assert, describe, it } from "@effect/vitest";
import { ThreadId, type OrchestrationV2AppThread } from "@houston-app/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { runHoustonMigrations } from "../migrations.ts";
import {
  BOT_THREAD_WALK_LIMIT,
  HoustonBotThreadLookupError,
  makeBotThreads,
  mcpBotCallerOf,
  type BotThreadRead,
} from "./botThreads.ts";
import { insertBotRun } from "./botRuns.ts";
import { policyFor } from "./kinds.ts";

const BOT = { askedMode: "auto", unattendedFullAccess: true, maxMinutes: 15 } as const;

type Lineage = OrchestrationV2AppThread["lineage"];
const thread = (
  id: string,
  lineage: Partial<Lineage> = {},
  extra: Partial<BotThreadRead> = {},
): BotThreadRead => ({
  id: ThreadId.make(id),
  lineage: {
    parentThreadId: null,
    relationshipToParent: null,
    rootThreadId: ThreadId.make(id),
    ...lineage,
  },
  ...extra,
});
const child = (id: string, parent: string, relationship: "subagent" | "fork" = "subagent") =>
  thread(id, { parentThreadId: ThreadId.make(parent), relationshipToParent: relationship });

const run = (threadId: string, kind: "asked" | "unattended", policyJson?: string) =>
  insertBotRun({
    id: `run-${threadId}`,
    botId: "bot",
    botName: "Digest writer",
    kind,
    origin: kind === "asked" ? "owner" : "test",
    projectId: "project",
    threadId,
    revisionN: 1,
    revisionSha256: "sha",
    template: "v1",
    policy: policyFor({ kind, bot: BOT }),
    startedAt: "2026-11-25T09:00:00.000Z",
    ...(policyJson === undefined ? {} : { policyJson }),
  });

/** Bot threads over a fresh database and the given threads. */
const withThreads = <A, E>(
  threads: ReadonlyArray<BotThreadRead>,
  body: (botThreads: ReturnType<typeof makeBotThreads>) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    yield* runHoustonMigrations();
    const sql = yield* SqlClient.SqlClient;
    const byId = new Map(threads.map((entry) => [entry.id as string, entry]));
    return yield* body(
      makeBotThreads({
        sql,
        readThread: (threadId) => Effect.succeed(byId.get(threadId)),
      }),
    );
  }).pipe(Effect.provide(Layer.fresh(SqlitePersistence.layerMemory)));

describe("a thread recorded as a bot run", () => {
  it.effect("gets its stored policy, with the unattended mode fixed", () =>
    withThreads([thread("bot-thread")], (botThreads) =>
      Effect.gen(function* () {
        yield* run("bot-thread", "unattended");
        const found = yield* botThreads.policyOf(thread("bot-thread"));
        assert.strictEqual(found?.runtimeMode, "full-access");
        assert.deepInclude(found?.provider, {
          botName: "Digest writer",
          kind: "unattended",
          child: false,
          neverAsk: true,
        });
        assert.include(found?.provider.rules.houstonTools ?? [], "houston_bot_result");
      }),
    ),
  );

  it.effect("an asked bot run keeps the thread's own mode", () =>
    withThreads([thread("asked-thread")], (botThreads) =>
      Effect.gen(function* () {
        yield* run("asked-thread", "asked");
        const found = yield* botThreads.policyOf(thread("asked-thread"));
        assert.isUndefined(found?.runtimeMode);
        assert.deepInclude(found?.provider, { kind: "asked", neverAsk: false, child: false });
      }),
    ),
  );

  it.effect("a row whose kind this build does not know resolves to the unattended policy", () =>
    withThreads([thread("future")], (botThreads) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* run("future", "asked");
        yield* sql`UPDATE houston_bot_runs SET kind = 'watched' WHERE thread_id = 'future'`;
        const found = yield* botThreads.policyOf(thread("future"));
        assert.strictEqual(found?.provider.kind, "unattended");
        assert.strictEqual(found?.runtimeMode, "auto");
      }),
    ),
  );

  it.effect("a stored policy this build cannot read resolves to the unattended policy", () =>
    withThreads([thread("garbled")], (botThreads) =>
      Effect.gen(function* () {
        yield* run("garbled", "asked", "{not json");
        const found = yield* botThreads.policyOf(thread("garbled"));
        assert.strictEqual(found?.provider.kind, "unattended");
      }),
    ),
  );

  it.effect("a marked thread with no bot run row resolves to the unattended policy", () =>
    withThreads([], (botThreads) =>
      Effect.gen(function* () {
        const marked = thread(
          "marked",
          {},
          {
            houstonBot: { botId: "bot", botRunId: "missing", kind: "asked" },
          },
        );
        const found = yield* botThreads.policyOf(marked);
        assert.strictEqual(found?.provider.kind, "unattended");
        assert.isTrue(found?.provider.neverAsk);
      }),
    ),
  );
});

describe("the walk from a delegated child to its bot thread", () => {
  const tree = [
    thread("root"),
    child("child", "root"),
    child("grandchild", "child"),
    child("fork", "root", "fork"),
    thread("side", {
      parentThreadId: ThreadId.make("root"),
      relationshipToParent: "fork",
      sideChat: true,
    }),
    child("fork-child", "fork"),
  ];

  it.effect(
    "a child and a grandchild get the bot's rules as a child, without the result tool",
    () =>
      withThreads(tree, (botThreads) =>
        Effect.gen(function* () {
          yield* run("root", "unattended");
          for (const id of ["child", "grandchild"]) {
            const found = yield* botThreads.policyOf(tree.find((entry) => entry.id === id)!);
            assert.deepInclude(found?.provider, { kind: "unattended", child: true }, id);
            assert.notInclude(found?.provider.rules.houstonTools ?? [], "houston_bot_result", id);
            assert.strictEqual(found?.runtimeMode, "full-access", id);
          }
        }),
      ),
  );

  it.effect("an asked bot run's child is refused the result tool by name", () =>
    withThreads(tree, (botThreads) =>
      Effect.gen(function* () {
        yield* run("root", "asked");
        const found = yield* botThreads.policyOf(child("child", "root"));
        assert.include(found?.provider.refusedTools ?? [], "mcp__houston__houston_bot_result");
        assert.isTrue(found?.provider.child);
      }),
    ),
  );

  it.effect("a fork, a side chat and a fork's own child carry no bot policy", () =>
    withThreads(tree, (botThreads) =>
      Effect.gen(function* () {
        yield* run("root", "unattended");
        for (const id of ["fork", "side", "fork-child"]) {
          const found = yield* botThreads.policyOf(tree.find((entry) => entry.id === id)!);
          assert.isUndefined(found, id);
        }
      }),
    ),
  );

  it.effect(
    `a chain of ${BOT_THREAD_WALK_LIMIT} links is walked; one more fails the turn by name`,
    () => {
      const chain = [thread("t0")];
      for (let depth = 1; depth <= BOT_THREAD_WALK_LIMIT + 1; depth += 1) {
        chain.push(child(`t${depth}`, `t${depth - 1}`));
      }
      return withThreads(chain, (botThreads) =>
        Effect.gen(function* () {
          yield* run("t0", "unattended");
          const deepest = yield* botThreads.policyOf(chain[BOT_THREAD_WALK_LIMIT]!);
          assert.isTrue(deepest?.provider.child);
          const error = yield* Effect.flip(botThreads.policyOf(chain[BOT_THREAD_WALK_LIMIT + 1]!));
          assert.instanceOf(error, HoustonBotThreadLookupError);
          assert.include(error.message, String(BOT_THREAD_WALK_LIMIT));
        }),
      );
    },
  );
});

describe("threads that are not a bot's", () => {
  it.effect("ordinary, side, task and delegated threads with no bot run get no policy", () =>
    withThreads([thread("parent"), child("delegate", "parent")], (botThreads) =>
      Effect.gen(function* () {
        assert.isUndefined(yield* botThreads.policyOf(thread("ordinary")));
        assert.isUndefined(yield* botThreads.policyOf(child("delegate", "parent")));
        // A child whose parent is gone is an ordinary thread.
        assert.isUndefined(yield* botThreads.policyOf(child("orphan", "gone")));
      }),
    ),
  );

  it.effect("a lookup that fails fails by name and never yields a policy", () =>
    Effect.gen(function* () {
      yield* runHoustonMigrations();
      const sql = yield* SqlClient.SqlClient;
      const broken = makeBotThreads({
        sql,
        readThread: (threadId) =>
          Effect.fail(
            new ProjectionStore.ProjectionStoreReadError({ threadId, cause: new Error("disk") }),
          ),
      });
      const parentError = yield* Effect.flip(broken.policyOf(child("delegate", "parent")));
      assert.strictEqual(
        parentError.message,
        "Houston could not read whether this thread is a bot's.",
      );
      yield* sql`DROP TABLE houston_bot_runs`;
      const rowError = yield* Effect.flip(broken.policyOf(thread("ordinary")));
      assert.instanceOf(rowError, HoustonBotThreadLookupError);
    }).pipe(Effect.provide(Layer.fresh(SqlitePersistence.layerMemory))),
  );
});

describe("the Houston credential of a bot thread", () => {
  const tree = [thread("root"), child("child", "root")];

  it.effect("carries its bot run and only the Houston tools its stored rules allow", () =>
    withThreads(tree, (botThreads) =>
      Effect.gen(function* () {
        yield* run("root", "unattended");
        const root = mcpBotCallerOf((yield* botThreads.policyOf(tree[0]!))!);
        assert.deepEqual(root, {
          kind: "unattended",
          child: false,
          botRunId: "run-root",
          botName: "Digest writer",
          tools: { allow: policyFor({ kind: "unattended", bot: BOT }).rules.houstonTools! },
        });
        const below = mcpBotCallerOf((yield* botThreads.policyOf(tree[1]!))!);
        assert.deepInclude(below, { kind: "unattended", child: true, botRunId: "run-root" });
        assert.notInclude("allow" in below.tools ? below.tools.allow : [], "houston_bot_result");
      }),
    ),
  );

  it.effect("an asked bot run and its child are refused scheduling, the child the result too", () =>
    withThreads(tree, (botThreads) =>
      Effect.gen(function* () {
        yield* run("root", "asked");
        const scheduling = ["schedule_task", "delete_scheduled_task", "run_scheduled_task_now"];
        assert.deepEqual(mcpBotCallerOf((yield* botThreads.policyOf(tree[0]!))!).tools, {
          deny: scheduling,
        });
        assert.deepEqual(mcpBotCallerOf((yield* botThreads.policyOf(tree[1]!))!).tools, {
          deny: [...scheduling, "houston_bot_result"],
        });
      }),
    ),
  );
});
