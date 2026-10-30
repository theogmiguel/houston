// @effect-diagnostics nodeBuiltinImport:off - hashes service names and loads the native keyring.
// Houston's secrets live in the OS keychain (Windows Credential Manager, the Linux Secret
// Service), never in the database or a file. Only the server's layer reaches the real keychain.
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

export class HoustonKeychain extends Context.Service<
  HoustonKeychain,
  {
    readonly get: (
      service: string,
      account: string,
    ) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, KeychainUnavailable>;
    readonly set: (
      service: string,
      account: string,
      value: Redacted.Redacted<string>,
    ) => Effect.Effect<void, KeychainUnavailable>;
    /** An absent entry succeeds. */
    readonly remove: (service: string, account: string) => Effect.Effect<void, KeychainUnavailable>;
  }
>()("houston/houston/secrets/HoustonKeychain") {}

/** The keychain calls a backend makes; the live one is `@napi-rs/keyring`. */
export interface KeychainBackend {
  readonly get: (service: string, account: string) => Promise<string | null | undefined>;
  readonly set: (service: string, account: string, value: string) => Promise<void>;
  readonly remove: (service: string, account: string) => Promise<unknown>;
}

const reasonOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "unknown error";

export const fromBackend = (backend: KeychainBackend): HoustonKeychain["Service"] => {
  const call = <A>(operation: string, run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => new KeychainUnavailable({ operation, reason: reasonOf(cause) }),
    });
  return HoustonKeychain.of({
    get: Effect.fn("HoustonKeychain.get")(function* (service, account) {
      const value = yield* call("read the entry", () => backend.get(service, account));
      return typeof value === "string" ? Option.some(Redacted.make(value)) : Option.none();
    }),
    set: Effect.fn("HoustonKeychain.set")(function* (service, account, value) {
      yield* call("store the entry", () => backend.set(service, account, Redacted.value(value)));
    }),
    remove: Effect.fn("HoustonKeychain.remove")(function* (service, account) {
      yield* call("delete the entry", () => backend.remove(service, account));
    }),
  });
};

const requireForKeyring = NodeModule.createRequire(import.meta.url);

const napiBackend: KeychainBackend = {
  get: (service, account) => {
    const { AsyncEntry } = requireForKeyring(
      "@napi-rs/keyring",
    ) as typeof import("@napi-rs/keyring");
    return new AsyncEntry(service, account).getPassword();
  },
  set: (service, account, value) => {
    const { AsyncEntry } = requireForKeyring(
      "@napi-rs/keyring",
    ) as typeof import("@napi-rs/keyring");
    return new AsyncEntry(service, account).setPassword(value);
  },
  remove: (service, account) => {
    const { AsyncEntry } = requireForKeyring(
      "@napi-rs/keyring",
    ) as typeof import("@napi-rs/keyring");
    return new AsyncEntry(service, account).deleteCredential();
  },
};

/** The OS keychain. Provided by the server's layer only; tests use `layerMemory`. */
export const layerLive = Layer.succeed(HoustonKeychain, fromBackend(napiBackend));

/** An in-memory keychain whose every call is recorded; `failWith` makes each call throw. */
export interface MemoryKeychain {
  readonly entries: Map<string, string>;
  readonly calls: Array<{ readonly op: "get" | "set" | "remove"; readonly service: string }>;
  failWith: string | null;
}

export const makeMemory = (): MemoryKeychain => ({ entries: new Map(), calls: [], failWith: null });

const keyOf = (service: string, account: string) => `${service}\u0000${account}`;

export const memoryBackend = (memory: MemoryKeychain): KeychainBackend => {
  const guard = (op: "get" | "set" | "remove", service: string) => {
    memory.calls.push({ op, service });
    if (memory.failWith !== null) throw new Error(memory.failWith);
  };
  return {
    get: async (service, account) => {
      guard("get", service);
      return memory.entries.get(keyOf(service, account)) ?? null;
    },
    set: async (service, account, value) => {
      guard("set", service);
      memory.entries.set(keyOf(service, account), value);
    },
    remove: async (service, account) => {
      guard("remove", service);
      return memory.entries.delete(keyOf(service, account));
    },
  };
};

export const layerMemory = (memory: MemoryKeychain = makeMemory()) =>
  Layer.succeed(HoustonKeychain, fromBackend(memoryBackend(memory)));

/** The hash covers the base dir, so channels never share an entry; Houston 1 used another prefix. */
export const keychainService = (input: {
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
