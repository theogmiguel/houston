// @effect-diagnostics nodeBuiltinImport:off - scans the server's sources and hashes v1's names.
// The keychain seam: service naming, the unavailable path, and who may reach the OS keychain.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import { HoustonKeychain, keychainService, layerMemory, makeMemory } from "./HoustonKeychain.ts";

// The v1 name, as core/houston-core/src/task_trackers.rs derived it.
const v1Service = (stateDir: string, workspace: string) =>
  `houston-tracker-notion-${NodeCrypto.createHash("sha256")
    .update(`${stateDir}\u0000${workspace}`)
    .digest("hex")
    .slice(0, 16)}`;

describe("services are scoped by base dir, project and provider", () => {
  it("services are scoped by base dir, project and provider", () => {
    const base = { baseDir: "/home/u/.houston-dev/v2", purpose: "tracker", projectId: "p1" };
    const one = keychainService({ ...base, provider: "notion" });
    assert.match(one, /^houston-v2-tracker-notion-[0-9a-f]{16}$/);
    assert.strictEqual(one, keychainService({ ...base, provider: "notion" }));
    assert.notStrictEqual(
      one,
      keychainService({ ...base, baseDir: "/home/u/.houston/v2", provider: "notion" }),
    );
    assert.notStrictEqual(one, keychainService({ ...base, projectId: "p2", provider: "notion" }));
    assert.notStrictEqual(one, keychainService({ ...base, provider: "github_issues" }));
    for (const [stateDir, workspace] of [
      [base.baseDir, base.projectId],
      ["/home/u/.houston-dev", "/work/p1"],
    ] as const) {
      assert.notStrictEqual(one, v1Service(stateDir, workspace));
      assert.isFalse(one.startsWith("houston-tracker-"));
    }
  });
});

describe("a backend failure becomes keychain unavailable", () => {
  it.effect("a backend failure becomes keychain unavailable", () => {
    const memory = makeMemory();
    return Effect.gen(function* () {
      const keychain = yield* HoustonKeychain;
      yield* keychain.set("svc", "integration-token", Redacted.make("tok"));
      assert.isTrue(Option.isSome(yield* keychain.get("svc", "integration-token")));
      memory.failWith = "Secret Service is not running";
      for (const attempt of [
        keychain.get("svc", "integration-token"),
        keychain.set("svc", "integration-token", Redacted.make("tok-2")),
        keychain.remove("svc", "integration-token"),
      ]) {
        const error = yield* Effect.flip(attempt);
        assert.strictEqual(error._tag, "KeychainUnavailable");
        assert.include(error.message, "Secret Service is not running");
        assert.notInclude(error.message, "tok");
      }
      memory.failWith = null;
      assert.strictEqual(
        Redacted.value(Option.getOrThrow(yield* keychain.get("svc", "integration-token"))),
        "tok",
      );
      yield* keychain.remove("svc", "integration-token");
      yield* keychain.remove("svc", "integration-token");
      assert.isTrue(Option.isNone(yield* keychain.get("svc", "integration-token")));
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

describe("only the server layer reaches the OS keychain", () => {
  it("only the server layer reaches the OS keychain", () => {
    const relative = (file: string) => NodePath.relative(SERVER_SRC, file).replaceAll("\\", "/");
    // This file names the module and the layer in its own assertions.
    const files = sources(SERVER_SRC).filter(
      (file) => relative(file) !== "houston/secrets/HoustonKeychain.test.ts",
    );
    const importers = files
      .filter((file) => NodeFS.readFileSync(file, "utf8").includes("@napi-rs/keyring"))
      .map(relative);
    assert.deepEqual(importers, ["houston/secrets/HoustonKeychain.ts"]);
    const live = files
      .filter((file) =>
        /\bHoustonKeychain\.layerLive\b|\blayerLive\b.*HoustonKeychain/.test(
          NodeFS.readFileSync(file, "utf8"),
        ),
      )
      .map(relative);
    // The module defines the layer; only the server's assembly may provide it.
    assert.deepEqual(
      live.filter((file) => file !== "houston/secrets/HoustonKeychain.ts"),
      ["server.ts"],
    );
    const testsNamingLive = files
      .filter((file) => file.endsWith(".test.ts"))
      .filter((file) => NodeFS.readFileSync(file, "utf8").includes("HoustonKeychain.layerLive"))
      .map(relative);
    assert.deepEqual(testsNamingLive, []);
  });
});
