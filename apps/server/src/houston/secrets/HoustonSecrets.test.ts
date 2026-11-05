// @effect-diagnostics nodeBuiltinImport:off - inspects the secret files on disk and scans the server's sources.
// The secret store seam: where a secret lands on disk, the unavailable path, and who may reach
// the legacy OS keychain.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@houston-app/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import {
  HoustonSecrets,
  layer,
  layerMemory,
  makeMemory,
  SecretStoreUnavailable,
} from "./HoustonSecrets.ts";

const layerFileStore = layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "houston-secrets-test-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const POSIX = HostProcess.Platform.defaultValue() !== "win32";

describe("secrets land in the server's secret store", () => {
  it.layer(layerFileStore)("over the file store", (it) => {
    it.effect("one file per secret, readable only by its owner", () =>
      Effect.gen(function* () {
        const secrets = yield* HoustonSecrets;
        const config = yield* ServerConfig.ServerConfig;
        const name = "houston-slack-connection-bot-token";
        yield* secrets.set(name, Redacted.make("xoxb-1-secret"));
        const file = NodePath.join(config.secretsDir, `${name}.bin`);
        assert.strictEqual(NodeFS.readFileSync(file, "utf8"), "xoxb-1-secret");
        if (POSIX) {
          assert.strictEqual(NodeFS.statSync(file).mode & 0o777, 0o600);
          assert.strictEqual(NodeFS.statSync(config.secretsDir).mode & 0o777, 0o700);
        }
        assert.strictEqual(
          Redacted.value(Option.getOrThrow(yield* secrets.get(name))),
          "xoxb-1-secret",
        );
        yield* secrets.set(name, Redacted.make("xoxb-2-newer"));
        assert.strictEqual(
          Redacted.value(Option.getOrThrow(yield* secrets.get(name))),
          "xoxb-2-newer",
        );
        yield* secrets.remove(name);
        yield* secrets.remove(name);
        assert.isTrue(Option.isNone(yield* secrets.get(name)));
        assert.isFalse(NodeFS.existsSync(file));
      }),
    );

    it.effect("a name that is not a plain file name is refused with the value and the shape", () =>
      Effect.gen(function* () {
        const secrets = yield* HoustonSecrets;
        for (const bad of ["", "../escape", "a/b", ".hidden", "with space", "x\u0000y"]) {
          for (const attempt of [
            secrets.get(bad),
            secrets.set(bad, Redacted.make("tok")),
            secrets.remove(bad),
          ]) {
            const error = yield* Effect.flip(attempt);
            assert.strictEqual(error._tag, "SecretStoreUnavailable");
            assert.include(error.message, JSON.stringify(bad));
            assert.include(error.message, "[A-Za-z0-9]");
            assert.notInclude(error.message, "tok");
          }
        }
      }),
    );
  });
});

describe("a store failure becomes secret store unavailable without the value", () => {
  it.effect("a store failure becomes secret store unavailable without the value", () => {
    const failing = ServerSecretStore.ServerSecretStore.of({
      get: (name) =>
        Effect.fail(
          new ServerSecretStore.SecretStoreReadError({
            resource: `secret ${name}`,
            cause: new Error("EACCES: permission denied"),
          }),
        ),
      set: (name) =>
        Effect.fail(
          new ServerSecretStore.SecretStorePersistError({
            resource: `secret ${name}`,
            cause: new Error("ENOSPC: no space left on device"),
          }),
        ),
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
      remove: (name) =>
        Effect.fail(
          new ServerSecretStore.SecretStoreRemoveError({
            resource: `secret ${name}`,
            cause: new Error("EBUSY"),
          }),
        ),
    });
    return Effect.gen(function* () {
      const secrets = yield* HoustonSecrets;
      const attempts = [
        [secrets.get("houston-x"), "read", "EACCES"],
        [secrets.set("houston-x", Redacted.make("tok-secret")), "store", "ENOSPC"],
        [secrets.remove("houston-x"), "delete", "EBUSY"],
      ] as const;
      for (const [attempt, operation, cause] of attempts) {
        const error = yield* Effect.flip(attempt);
        assert.instanceOf(error, SecretStoreUnavailable);
        assert.include(error.message, operation);
        assert.include(error.message, "houston-x");
        assert.include(error.message, cause);
        assert.notInclude(error.message, "tok-secret");
      }
    }).pipe(
      Effect.provide(
        layer.pipe(Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, failing))),
      ),
    );
  });
});

describe("the memory layer is the server tests' stand-in", () => {
  it.effect("records calls, fails on request and returns what it stored", () => {
    const memory = makeMemory();
    return Effect.gen(function* () {
      const secrets = yield* HoustonSecrets;
      yield* secrets.set("houston-a", Redacted.make("one"));
      assert.deepEqual([...memory.entries], [["houston-a", "one"]]);
      memory.failWith = "the secrets directory is read-only";
      const error = yield* Effect.flip(secrets.get("houston-a"));
      assert.include(error.message, "the secrets directory is read-only");
      memory.failWith = null;
      yield* secrets.remove("houston-a");
      assert.deepEqual(
        memory.calls.map((call) => call.op),
        ["set", "get", "remove"],
      );
    }).pipe(Effect.provide(layerMemory(memory)));
  });
});

const SERVER_SRC = NodePath.resolve(import.meta.dirname, "../..");

const sources = (dir: string): Array<string> =>
  NodeFS.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|tsx|mts)$/.test(entry.name) ? [path] : [];
  });

describe("Houston's secrets never reach the OS keychain", () => {
  it("only the import reads the legacy keychain, and only server.ts provides it", () => {
    const relative = (file: string) => NodePath.relative(SERVER_SRC, file).replaceAll("\\", "/");
    const files = sources(SERVER_SRC).filter(
      (file) => !file.endsWith(".test.ts") && !file.endsWith(".testkit.ts"),
    );
    const text = (file: string) => NodeFS.readFileSync(file, "utf8");
    assert.deepEqual(
      files
        .filter((file) => /\bLegacyKeychain\b/.test(text(file)))
        .map(relative)
        .toSorted(),
      ["houston/secrets/LegacyKeychain.ts", "houston/secrets/SecretStoreImport.ts", "server.ts"],
    );
    assert.deepEqual(
      files.filter((file) => text(file).includes("HoustonKeychain")).map(relative),
      [],
    );
    assert.deepEqual(
      files
        .filter((file) => /houston\/(slack|taskSources)\/(?!V1Import)/.test(relative(file)))
        .filter((file) => /keychain|keyring/i.test(text(file)))
        .map(relative),
      [],
    );
  });
});
