// The one-time copy of Houston's tokens from the OS keychain into the server's secret store,
// over the memory keychain, the memory secret store and an in-memory database.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { slackSecretName } from "../slack/rules.ts";
import { trackerSecretName } from "../taskSources/rules.ts";
import { layerMemory, makeMemory, type MemorySecrets } from "./HoustonSecrets.ts";
import {
  layerMemory as layerMemoryKeychain,
  legacyKeychainService,
  makeMemory as makeMemoryKeychain,
  type MemoryKeychain,
} from "./LegacyKeychain.ts";
import { DATADOG_KEY_SECRET } from "../observability/DatadogKey.ts";
import { importKeychainSecrets } from "./SecretStoreImport.ts";

const APP = "xapp-1-A0-keychain";
const BOT = "xoxb-1-keychain";
const NOTION = "ntn_keychain_token";

interface World {
  readonly keychain: MemoryKeychain;
  readonly secrets: MemorySecrets;
}

const worldOf = (): World => ({ keychain: makeMemoryKeychain(), secrets: makeMemory() });

const layerFor = (world: World) =>
  Layer.mergeAll(layerMemory(world.secrets), layerMemoryKeychain(world.keychain)).pipe(
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "houston-import-test-" })),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const imported = (copied: number, present = 0, absent = 0, refused = 0) => ({
  kind: "imported" as const,
  copied,
  present,
  absent,
  refused,
});

const pending = (unread: number, copied = 0, present = 0) => ({
  kind: "pending" as const,
  copied,
  present,
  absent: 0,
  refused: 0,
  unread,
});

const keychainKey = (service: string, account: string) => `${service}\u0000${account}`;

const withWorld = <A, E, R>(body: (world: World) => Effect.Effect<A, E, R>) => {
  const world = worldOf();
  return body(world).pipe(Effect.provide(layerFor(world)));
};

/** Seeds what Houston's startup knows about a keychain-era install: a connected Slack and two
 * projects with a Notion credential on record. */
const seedConnections = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  yield* sql`
    INSERT INTO houston_slack_settings (id, enabled, language, credential_set_at, updated_at)
    VALUES (1, 1, 'en', 'then', 'then')
  `;
  yield* sql`
    INSERT INTO houston_task_source_credentials (project_id, provider)
    VALUES ('project-a', 'notion'), ('project-b', 'notion')
  `;
  const slack = legacyKeychainService({
    baseDir: config.baseDir,
    purpose: "slack",
    projectId: "server",
    provider: "connection",
  });
  const tracker = (projectId: string) =>
    legacyKeychainService({
      baseDir: config.baseDir,
      purpose: "tracker",
      projectId,
      provider: "notion",
    });
  return {
    slack,
    tracker,
    seedKeychain: (keychain: MemoryKeychain) => {
      keychain.entries.set(keychainKey(slack, "app-token"), APP);
      keychain.entries.set(keychainKey(slack, "bot-token"), BOT);
      keychain.entries.set(keychainKey(tracker("project-a"), "integration-token"), `${NOTION}-a`);
      keychain.entries.set(keychainKey(tracker("project-b"), "integration-token"), `${NOTION}-b`);
    },
  };
});

const recorded = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly counts_json: string }>`
    SELECT counts_json FROM houston_secret_store_import WHERE id = 1
  `;
});

describe("the keychain import copies each token once into the secret store", () => {
  it.effect("copies Slack's and every tracker's token and leaves the keychain untouched", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const seeded = yield* seedConnections;
        seeded.seedKeychain(world.keychain);
        const before = new Map(world.keychain.entries);
        const result = yield* importKeychainSecrets;
        assert.deepEqual(result, imported(4));
        assert.deepEqual(
          [...world.secrets.entries].toSorted(),
          [
            [slackSecretName("app-token"), APP],
            [slackSecretName("bot-token"), BOT],
            [trackerSecretName("project-a", "notion"), `${NOTION}-a`],
            [trackerSecretName("project-b", "notion"), `${NOTION}-b`],
          ].toSorted(),
        );
        assert.deepEqual(world.keychain.entries, before, "the keychain keeps its entries");
        assert.isTrue(
          world.keychain.calls.every((call) => call.op === "get"),
          "the import only reads the keychain",
        );
        assert.deepEqual(JSON.parse((yield* recorded)[0]?.counts_json ?? "null"), {
          copied: 4,
          present: 0,
          absent: 0,
          refused: 0,
        });
      }),
    ),
  );

  // Observability reads the Datadog key before the runtime runs this import (server.ts), which
  // is safe only while the import never copies that key.
  it.effect("never reads or writes the Datadog API key", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const seeded = yield* seedConnections;
        seeded.seedKeychain(world.keychain);
        world.secrets.entries.set(DATADOG_KEY_SECRET, "0123456789abcdef0123456789abcdef");
        assert.deepEqual(yield* importKeychainSecrets, imported(4));
        assert.isFalse(world.secrets.calls.some((call) => call.name === DATADOG_KEY_SECRET));
        assert.isFalse(
          world.keychain.calls.some((call) =>
            JSON.stringify(call).toLowerCase().includes("datadog"),
          ),
        );
        assert.strictEqual(
          world.secrets.entries.get(DATADOG_KEY_SECRET),
          "0123456789abcdef0123456789abcdef",
        );
      }),
    ),
  );

  it.effect("runs once: a second start reads neither the keychain nor the store", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const seeded = yield* seedConnections;
        seeded.seedKeychain(world.keychain);
        yield* importKeychainSecrets;
        world.keychain.calls.length = 0;
        world.secrets.calls.length = 0;
        // A token the user re-entered since stays as it is.
        world.secrets.entries.set(slackSecretName("bot-token"), "xoxb-newer");
        assert.deepEqual(yield* importKeychainSecrets, { kind: "done" });
        assert.deepEqual(world.keychain.calls, []);
        assert.deepEqual(world.secrets.calls, []);
        assert.strictEqual(world.secrets.entries.get(slackSecretName("bot-token")), "xoxb-newer");
      }),
    ),
  );

  it.effect("keeps a token the store already holds and never reads its keychain entry", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const seeded = yield* seedConnections;
        seeded.seedKeychain(world.keychain);
        world.secrets.entries.set(trackerSecretName("project-a", "notion"), "ntn_already_here");
        const result = yield* importKeychainSecrets;
        assert.deepEqual(result, imported(3, 1));
        assert.strictEqual(
          world.secrets.entries.get(trackerSecretName("project-a", "notion")),
          "ntn_already_here",
        );
        assert.isFalse(
          world.keychain.calls.some(
            (call) => call.service === seeded.tracker("project-a") && call.op === "get",
          ),
        );
      }),
    ),
  );

  it.effect("an install that never used the keychain records the import without touching it", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        assert.deepEqual(yield* importKeychainSecrets, imported(0));
        assert.deepEqual(world.keychain.calls, []);
        assert.lengthOf(yield* recorded, 1);
        assert.deepEqual(yield* importKeychainSecrets, { kind: "done" });
      }),
    ),
  );

  it.effect("an entry the keychain no longer holds counts as absent and the import completes", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const seeded = yield* seedConnections;
        seeded.seedKeychain(world.keychain);
        world.keychain.entries.delete(keychainKey(seeded.slack, "app-token"));
        world.keychain.entries.delete(keychainKey(seeded.slack, "bot-token"));
        const result = yield* importKeychainSecrets;
        assert.deepEqual(result, imported(2, 0, 2));
        assert.isFalse(world.secrets.entries.has(slackSecretName("app-token")));
        assert.lengthOf(yield* recorded, 1);
      }),
    ),
  );
});

describe("an unavailable keychain is a named warning, not an error", () => {
  it.effect("the import goes on, warns without a token and retries at the next start", () => {
    const logs: Array<string> = [];
    const logger = Logger.make((options) => {
      logs.push(`${String(options.message)} ${Cause.pretty(options.cause)}`);
    });
    return withWorld((world) =>
      Effect.gen(function* () {
        const seeded = yield* seedConnections;
        seeded.seedKeychain(world.keychain);
        world.keychain.failWith = "org.freedesktop.secrets was not provided by any .service files";
        const first = yield* importKeychainSecrets;
        assert.deepEqual(first, pending(4));
        assert.strictEqual(world.secrets.entries.size, 0);
        assert.lengthOf(yield* recorded, 0, "an unread entry keeps the import open");
        const warnings = logs.filter((line) => line.includes("Secret store import"));
        assert.isAtLeast(warnings.length, 1);
        const text = warnings.join("\n");
        assert.include(text, "org.freedesktop.secrets was not provided");
        assert.include(text, "Slack app-token");
        assert.include(text, "project-a");
        for (const token of [APP, BOT, NOTION]) assert.notInclude(text, token);

        world.keychain.failWith = null;
        const second = yield* importKeychainSecrets;
        assert.deepEqual(second, imported(4));
        assert.lengthOf(yield* recorded, 1);
      }),
    ).pipe(Effect.provide(Logger.layer([logger])));
  });

  it.effect("tokens copied before the keychain went away are kept and not read again", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const seeded = yield* seedConnections;
        seeded.seedKeychain(world.keychain);
        world.secrets.entries.set(slackSecretName("app-token"), APP);
        world.keychain.failWith = "locked";
        const result = yield* importKeychainSecrets;
        assert.deepEqual(result, pending(3, 0, 1));
        assert.strictEqual(world.secrets.entries.get(slackSecretName("app-token")), APP);
      }),
    ),
  );
});

describe("a token the secret store cannot take keeps the import open", () => {
  it.effect("a refused write is a named warning and the next start tries again", () => {
    const logs: Array<string> = [];
    const logger = Logger.make((options) => logs.push(String(options.message)));
    return withWorld((world) =>
      Effect.gen(function* () {
        const seeded = yield* seedConnections;
        seeded.seedKeychain(world.keychain);
        world.secrets.rejectSetWith = "ENOSPC: no space left on device";
        const first = yield* importKeychainSecrets;
        assert.deepEqual(first, pending(4));
        assert.include(logs.join("\n"), "ENOSPC");
        for (const token of [APP, BOT]) assert.notInclude(logs.join("\n"), token);
        world.secrets.rejectSetWith = null;
        assert.deepEqual(yield* importKeychainSecrets, imported(4));
      }),
    ).pipe(Effect.provide(Logger.layer([logger])));
  });

  it.effect("a legacy token over the size bound is refused by name and not copied", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const seeded = yield* seedConnections;
        seeded.seedKeychain(world.keychain);
        world.keychain.entries.set(keychainKey(seeded.slack, "bot-token"), "x".repeat(2_049));
        const result = yield* importKeychainSecrets;
        assert.deepEqual(result, imported(3, 0, 0, 1));
        assert.isFalse(world.secrets.entries.has(slackSecretName("bot-token")));
        assert.isTrue(world.secrets.entries.has(slackSecretName("app-token")));
      }),
    ),
  );
});
