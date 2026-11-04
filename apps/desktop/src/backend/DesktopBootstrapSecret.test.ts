import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  KEYCHAIN_PROFILE,
  bootstrapSecretServiceName,
  loadOrCreateDesktopBootstrapSecret,
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
