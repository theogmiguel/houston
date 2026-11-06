// Houston's tokens live in the server's secret store: one 0600 file per secret in the channel's
// 0700 secrets directory, never in the database. The directory belongs to one channel, so a name
// needs no channel part. Callers bound a token's size before `set` and refuse it by name.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";

export class SecretStoreUnavailable extends Schema.TaggedError<SecretStoreUnavailable>()(
  "SecretStoreUnavailable",
  { operation: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `the secret store could not ${this.operation}: ${this.reason}`;
  }
}

export class HoustonSecrets extends Context.Service<
  HoustonSecrets,
  {
    readonly get: (
      name: string,
    ) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, SecretStoreUnavailable>;
    readonly set: (
      name: string,
      value: Redacted.Redacted<string>,
    ) => Effect.Effect<void, SecretStoreUnavailable>;
    /** An absent entry succeeds. */
    readonly remove: (name: string) => Effect.Effect<void, SecretStoreUnavailable>;
  }
>()("@houston-app/cli/houston/secrets/HoustonSecrets") {}

/** The file name a secret gets: plain characters only, so no name can leave the directory. */
const NAME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const NAME_SHAPE_TEXT = "[A-Za-z0-9][A-Za-z0-9_-]* (letters, digits, '-' and '_')";

const checkName = (operation: string, name: string) =>
  NAME_SHAPE.test(name)
    ? Effect.void
    : Effect.fail(
        new SecretStoreUnavailable({
          operation,
          reason: `the secret name ${JSON.stringify(name)} must match ${NAME_SHAPE_TEXT}`,
        }),
      );

const detail = (cause: unknown) =>
  cause instanceof Error ? ` (${cause.message})` : typeof cause === "string" ? ` (${cause})` : "";

const unavailable = (operation: string) => (error: ServerSecretStore.SecretStoreError) =>
  new SecretStoreUnavailable({
    operation,
    reason: `${error.message}${"cause" in error ? detail(error.cause) : ""}`,
  });

export const fromStore = (
  store: ServerSecretStore.ServerSecretStore["Service"],
): HoustonSecrets["Service"] =>
  HoustonSecrets.of({
    get: Effect.fn("HoustonSecrets.get")(function* (name) {
      yield* checkName("read the entry", name);
      const bytes = yield* store.get(name).pipe(Effect.mapError(unavailable("read the entry")));
      return Option.map(bytes, (value) => Redacted.make(new TextDecoder().decode(value)));
    }),
    set: Effect.fn("HoustonSecrets.set")(function* (name, value) {
      yield* checkName("store the entry", name);
      yield* store
        .set(name, new TextEncoder().encode(Redacted.value(value)))
        .pipe(Effect.mapError(unavailable("store the entry")));
    }),
    remove: Effect.fn("HoustonSecrets.remove")(function* (name) {
      yield* checkName("delete the entry", name);
      yield* store.remove(name).pipe(Effect.mapError(unavailable("delete the entry")));
    }),
  });

export const layer = Layer.effect(
  HoustonSecrets,
  Effect.map(ServerSecretStore.ServerSecretStore, fromStore),
);

// The same seam over the same store, for observability, built before the database the keychain
// import needs. No token the import copies is read before the runtime runs the import.
export const layerWithoutImport = Layer.effect(
  HoustonSecrets,
  Effect.map(ServerSecretStore.ServerSecretStore, fromStore),
);

const unavailableWith = (operation: string, reason: string) =>
  Effect.fail(new SecretStoreUnavailable({ operation, reason }));

/** An in-memory store recording every call; `failWith` fails them all, `rejectSetWith` the writes. */
export interface MemorySecrets {
  readonly entries: Map<string, string>;
  readonly calls: Array<{ readonly op: "get" | "set" | "remove"; readonly name: string }>;
  failWith: string | null;
  rejectSetWith: string | null;
}

export const makeMemory = (): MemorySecrets => ({
  entries: new Map(),
  calls: [],
  failWith: null,
  rejectSetWith: null,
});

/** Every call yields first, as the file store's IO does, so callers interleave the same way. */
export const layerMemory = (memory: MemorySecrets = makeMemory()) =>
  Layer.succeed(
    HoustonSecrets,
    HoustonSecrets.of({
      get: Effect.fn(function* (name) {
        memory.calls.push({ op: "get", name });
        yield* Effect.yieldNow;
        yield* checkName("read the entry", name);
        if (memory.failWith !== null)
          return yield* unavailableWith("read the entry", memory.failWith);
        const value = memory.entries.get(name);
        return value === undefined ? Option.none() : Option.some(Redacted.make(value));
      }),
      set: Effect.fn(function* (name, value) {
        memory.calls.push({ op: "set", name });
        yield* Effect.yieldNow;
        yield* checkName("store the entry", name);
        const failure = memory.failWith ?? memory.rejectSetWith;
        if (failure !== null) return yield* unavailableWith("store the entry", failure);
        memory.entries.set(name, Redacted.value(value));
      }),
      remove: Effect.fn(function* (name) {
        memory.calls.push({ op: "remove", name });
        yield* Effect.yieldNow;
        yield* checkName("delete the entry", name);
        if (memory.failWith !== null)
          return yield* unavailableWith("delete the entry", memory.failWith);
        memory.entries.delete(name);
      }),
    }),
  );
