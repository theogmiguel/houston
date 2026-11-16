// @effect-diagnostics nodeBuiltinImport:off - hashes service names and loads the native keyring.
// Read-only access to the OS keychain where earlier builds kept Houston's tokens; only
// `SecretStoreImport` reads it, and nothing writes or deletes. Only the server provides the live layer.
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export class KeychainUnavailable extends Schema.TaggedError<KeychainUnavailable>()(
  "KeychainUnavailable",
  { operation: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `the OS keychain could not ${this.operation}: ${this.reason}`;
  }
}

export class LegacyKeychain extends Context.Service<
  LegacyKeychain,
  {
    readonly get: (
      service: string,
      account: string,
    ) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, KeychainUnavailable>;
  }
>()("@houston-app/cli/houston/secrets/LegacyKeychain") {}

/** The keychain call a backend makes; the live one is `@napi-rs/keyring`. */
export interface KeychainBackend {
  readonly get: (service: string, account: string) => Promise<string | null | undefined>;
}

const reasonOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "unknown error";

export const fromBackend = (backend: KeychainBackend): LegacyKeychain["Service"] =>
  LegacyKeychain.of({
    get: Effect.fn("LegacyKeychain.get")(function* (service, account) {
      const value = yield* Effect.tryPromise({
        try: () => backend.get(service, account),
        catch: (cause) =>
          new KeychainUnavailable({ operation: "read the entry", reason: reasonOf(cause) }),
      });
      return typeof value === "string" ? Option.some(Redacted.make(value)) : Option.none();
    }),
  });

const requireForKeyring = NodeModule.createRequire(import.meta.url);

const napiBackend: KeychainBackend = {
  get: (service, account) => {
    const { AsyncEntry } = requireForKeyring(
      "@napi-rs/keyring",
    ) as typeof import("@napi-rs/keyring");
    return new AsyncEntry(service, account).getPassword();
  },
};

/** The OS keychain. Provided by the server's layer only; tests use `layerMemory`. */
export const layerLive = Layer.succeed(LegacyKeychain, fromBackend(napiBackend));

/** An in-memory keychain whose every read is recorded; `failWith` makes each read throw. */
export interface MemoryKeychain {
  readonly entries: Map<string, string>;
  readonly calls: Array<{ readonly op: "get"; readonly service: string }>;
  failWith: string | null;
}

export const makeMemory = (): MemoryKeychain => ({ entries: new Map(), calls: [], failWith: null });

const keyOf = (service: string, account: string) => `${service}\u0000${account}`;

export const memoryBackend = (memory: MemoryKeychain): KeychainBackend => ({
  get: async (service, account) => {
    memory.calls.push({ op: "get", service });
    if (memory.failWith !== null) throw new Error(memory.failWith);
    return memory.entries.get(keyOf(service, account)) ?? null;
  },
});

export const layerMemory = (memory: MemoryKeychain = makeMemory()) =>
  Layer.succeed(LegacyKeychain, fromBackend(memoryBackend(memory)));

/** The service name earlier builds stored a token under; the hash covers the base dir. */
export const legacyKeychainService = (input: {
  readonly baseDir: string;
  readonly purpose: string;
  readonly projectId: string;
  readonly provider: string;
}): string => {
  const hash = NodeCrypto.createHash("sha256")
    .update(`${input.baseDir}\u0000${input.projectId}\u0000${input.provider}`)
    .digest("hex");
  return `houston-v2-${input.purpose}-${input.provider}-${hash.slice(0, 16)}`;
};
