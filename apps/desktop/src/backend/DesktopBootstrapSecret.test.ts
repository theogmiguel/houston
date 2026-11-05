import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  KEYCHAIN_PROFILE,
  bootstrapSecretServiceName,
  loadOrCreateDesktopBootstrapSecret,
  makeBootstrapSecretResolver,
  type BootstrapSecretKeychain,
} from "./DesktopBootstrapSecret.ts";

const BASE_DIR = "/home/theo/.houston/v2";
const FALLBACK = "f".repeat(64);

function keychainWith(password: string | null | undefined) {
  const calls: Array<{ service: string; account: string }> = [];
  const stored: Array<string> = [];
  const keychain: BootstrapSecretKeychain = {
    entry: (service, account) => {
      calls.push({ service, account });
      return {
        getPassword: async () => password,
        setPassword: async (value) => {
          stored.push(value);
        },
      };
    },
  };
  return { keychain, calls, stored };
}

describe("bootstrapSecretServiceName", () => {
  it("scopes the keychain service to the base directory", () => {
    const release = bootstrapSecretServiceName("/home/theo/.houston/v2");
    const dev = bootstrapSecretServiceName("/home/theo/.houston-dev/v2");
    assert.match(release, /^houston-v2-[0-9a-f]{16}$/);
    assert.notStrictEqual(release, dev);
    assert.strictEqual(release, bootstrapSecretServiceName("/home/theo/.houston/v2"));
  });
});

describe("loadOrCreateDesktopBootstrapSecret", () => {
  it("reuses an existing keychain secret", async () => {
    const existing = "a".repeat(64);
    const fake = keychainWith(existing);
    const value = await loadOrCreateDesktopBootstrapSecret({
      baseDir: BASE_DIR,
      keychain: fake.keychain,
      fallbackSecret: FALLBACK,
    });
    assert.strictEqual(value.secret, existing);
    assert.isTrue(Option.isNone(value.warning));
    assert.deepStrictEqual(fake.calls, [
      { service: bootstrapSecretServiceName(BASE_DIR), account: KEYCHAIN_PROFILE },
    ]);
    assert.deepStrictEqual(fake.stored, []);
  });

  it("creates and stores a secret when the entry is missing", async () => {
    const fake = keychainWith(null);
    const value = await loadOrCreateDesktopBootstrapSecret({
      baseDir: BASE_DIR,
      keychain: fake.keychain,
      fallbackSecret: FALLBACK,
    });
    assert.strictEqual(value.secret.length, 64);
    assert.isTrue(Option.isNone(value.warning));
    assert.deepStrictEqual(fake.stored, [value.secret]);
  });

  it("replaces a malformed existing secret", async () => {
    const fake = keychainWith("short");
    const value = await loadOrCreateDesktopBootstrapSecret({
      baseDir: BASE_DIR,
      keychain: fake.keychain,
      fallbackSecret: FALLBACK,
    });
    assert.strictEqual(value.secret.length, 64);
    assert.deepStrictEqual(fake.stored, [value.secret]);
  });

  it("falls back to an in-memory secret and warns when the keychain fails", async () => {
    const keychain: BootstrapSecretKeychain = {
      entry: () => ({
        getPassword: async () => {
          throw new Error("secret service unavailable");
        },
        setPassword: async () => {},
      }),
    };
    const value = await loadOrCreateDesktopBootstrapSecret({
      baseDir: BASE_DIR,
      keychain,
      fallbackSecret: FALLBACK,
    });
    assert.strictEqual(value.secret, FALLBACK);
    assert.isTrue(Option.isSome(value.warning));
    if (Option.isSome(value.warning)) {
      assert.include(value.warning.value, "secret service unavailable");
      assert.include(value.warning.value, "temporary desktop secret");
    }
  });

  it("falls back when no keychain provider is available", async () => {
    const value = await loadOrCreateDesktopBootstrapSecret({
      baseDir: BASE_DIR,
      keychain: null,
      fallbackSecret: FALLBACK,
      unavailableReason: "no Secret Service",
    });
    assert.strictEqual(value.secret, FALLBACK);
    assert.isTrue(Option.isSome(value.warning));
  });
});

describe("makeBootstrapSecretResolver", () => {
  it.effect("reads the keychain once per launch after a successful read", () =>
    Effect.gen(function* () {
      let reads = 0;
      const value = { secret: "a".repeat(64), warning: Option.none<string>() };
      const resolve = yield* makeBootstrapSecretResolver({
        load: async () => {
          reads += 1;
          return value;
        },
      });

      for (let call = 0; call < 3; call += 1) {
        assert.strictEqual(yield* resolve, value);
      }
      assert.strictEqual(reads, 1);
    }),
  );

  it.effect("retries a failed read and caches the keychain once it answers", () =>
    Effect.gen(function* () {
      let reads = 0;
      const fallback = { secret: "f".repeat(64), warning: Option.some("keychain locked") };
      const recovered = { secret: "b".repeat(64), warning: Option.none<string>() };
      const resolve = yield* makeBootstrapSecretResolver({
        load: async () => {
          reads += 1;
          return reads === 1 ? fallback : recovered;
        },
      });

      assert.deepStrictEqual(yield* resolve, fallback);
      assert.strictEqual(yield* resolve, recovered);
      assert.strictEqual(yield* resolve, recovered);
      assert.strictEqual(reads, 2, "the unlocked keychain is picked up once");
    }),
  );

  it.effect("does not cache a fallback that warns on every read", () =>
    Effect.gen(function* () {
      let reads = 0;
      const fallback = { secret: "f".repeat(64), warning: Option.some("no Secret Service") };
      const resolve = yield* makeBootstrapSecretResolver({
        load: async () => {
          reads += 1;
          return fallback;
        },
      });

      assert.deepStrictEqual(yield* resolve, fallback);
      assert.deepStrictEqual(yield* resolve, fallback);
      assert.strictEqual(reads, 2);
    }),
  );
});
