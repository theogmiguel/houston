import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@houston-app/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { makeBotThreads } from "../src/houston/bots/botThreads.ts";
import { runHoustonMigrations } from "../src/houston/migrations.ts";
import * as SqlitePersistence from "../src/persistence/Sqlite.ts";
import {
  devChannelBaseDir,
  proofLaunchInput,
  recordProofBot,
  type ProofBot,
} from "./dev-bot-thread.ts";

const HOME = "/home/someone";

const bot = (overrides: Partial<ProofBot> = {}): ProofBot => ({
  botId: "11111111-2222-3333-4444-555555555555",
  botRunId: "run-1",
  threadId: "thread-1",
  kind: "unattended",
  name: "Proof bot",
  projectId: "project-sample-api",
  account: "claudeAgent",
  model: "claude-sonnet-4-6",
  fullAccess: false,
  instructions: "Report what happened.",
  at: "2026-11-25T09:00:00.000Z",
  ...overrides,
});

describe("the channel the script works in", () => {
  it("is a named development channel's state, from a source build", () => {
    assert.deepEqual(devChannelBaseDir({ channel: "proof-f2a", home: HOME, build: "dev" }), {
      baseDir: "/home/someone/.houston-proof-f2a/v2",
    });
  });

  it("refuses the installed channel, a malformed name and a release build", () => {
    for (const channel of ["release", "", "../houston", "Proof", "-x"]) {
      assert.property(devChannelBaseDir({ channel, home: HOME, build: "dev" }), "refusal", channel);
    }
    const built = devChannelBaseDir({ channel: "proof-f2a", home: HOME, build: "latest" });
    assert.include("refusal" in built ? built.refusal : "", "latest");
  });
});

describe("the bot run the script records", () => {
  it.effect("is found by the thread's rules lookup, with the kind it was given", () =>
    Effect.gen(function* () {
      yield* runHoustonMigrations();
      const sql = yield* SqlClient.SqlClient;
      yield* recordProofBot(bot());
      yield* recordProofBot(
        bot({
          botId: "99999999-2222-3333-4444-555555555555",
          botRunId: "run-2",
          threadId: "thread-2",
          kind: "asked",
        }),
      );
      const botThreads = makeBotThreads({ sql, readThread: () => Effect.succeed(undefined) });
      const thread = (id: string) => ({
        id: ThreadId.make(id),
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: ThreadId.make(id),
        },
      });
      const unattended = yield* botThreads.policyOf(thread("thread-1"));
      assert.deepInclude(unattended?.provider, {
        kind: "unattended",
        neverAsk: true,
        botName: "Proof bot",
      });
      assert.strictEqual(unattended?.runtimeMode, "auto");
      const asked = yield* botThreads.policyOf(thread("thread-2"));
      assert.deepInclude(asked?.provider, { kind: "asked", neverAsk: false });
      const [stored] = yield* sql<{ readonly enabled: number; readonly sha: string }>`
        SELECT b.enabled AS enabled, r.revision_sha256 AS sha FROM houston_bots b
        JOIN houston_bot_runs r ON r.bot_id = b.id WHERE r.id = 'run-1'
      `;
      // Switched off: nothing but this script starts it.
      assert.strictEqual(stored?.enabled, 0);
      assert.match(stored?.sha ?? "", /^[0-9a-f]{64}$/);
    }).pipe(Effect.provide(Layer.fresh(SqlitePersistence.layerMemory))),
  );
});

describe("the launch the script sends", () => {
  it("puts an unattended bot run in a worktree in its fixed mode, and an asked one in the project", () => {
    const unattended = proofLaunchInput(bot({ fullAccess: true }), {
      prompt: "Send it",
      baseRef: "main",
    });
    assert.deepEqual(unattended.workspaceStrategy, { type: "worktree", baseRef: "main" });
    assert.strictEqual(unattended.runtimeMode, "full-access");
    assert.strictEqual(unattended.commandId, "houston-bot-run:run-1");
    assert.strictEqual(unattended.initialMessage.messageId, "bot-run:run-1");
    assert.strictEqual(unattended.threadId, "thread-1");
    const asked = proofLaunchInput(bot({ kind: "asked" }), { prompt: "Look", baseRef: "main" });
    assert.deepEqual(asked.workspaceStrategy, { type: "root" });
    assert.strictEqual(asked.runtimeMode, "auto");
  });
});
