import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  isMissingKeychainEntry,
  keychainErrorMessage,
  keychainServiceName,
  loadDesktopKeychain,
  type DesktopKeychain,
} from "../backend/DesktopBootstrapSecret.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const CATALOG_SERVICE_PREFIX = "houston-v2-catalog";
const CATALOG_ACCOUNT = "connection-catalog";
// Keychain backends vary; a catalog with hundreds of environments still fits well below this.
export const MAX_CONNECTION_CATALOG_BYTES = 4 * 1024 * 1024;

export const CONNECTION_CATALOG_KEYCHAIN_ACCOUNT = CATALOG_ACCOUNT;

const CatalogOperation = Schema.Literals(["read", "write"]);

export class DesktopConnectionCatalogStoreLimitError extends Schema.TaggedError<DesktopConnectionCatalogStoreLimitError>()(
  "DesktopConnectionCatalogStoreLimitError",
  {
    service: Schema.String,
    size: Schema.Int,
    limit: Schema.Int,
  },
) {
  override get message(): string {
    return `Refusing to save the connection catalog: ${this.size} bytes exceeds the ${this.limit} byte keychain limit (service "${this.service}").`;
  }
}

export class DesktopConnectionCatalogStoreKeychainError extends Schema.TaggedError<DesktopConnectionCatalogStoreKeychainError>()(
  "DesktopConnectionCatalogStoreKeychainError",
  {
    operation: CatalogOperation,
    service: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `The system keychain ${this.operation} for the connection catalog (service "${this.service}") failed: ${keychainErrorMessage(this.cause)}`;
  }
}

export class DesktopConnectionCatalogStoreUnavailableError extends Schema.TaggedError<DesktopConnectionCatalogStoreUnavailableError>()(
  "DesktopConnectionCatalogStoreUnavailableError",
  {
    service: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `The system keychain is unavailable (${this.reason}); the connection catalog at service "${this.service}" cannot be read or saved, and Houston does not keep a plaintext copy.`;
  }
}

/** `houston-v2-catalog-<first 16 hex of sha256(baseDir.trim())>`. */
export function connectionCatalogServiceName(baseDir: string): string {
  return keychainServiceName(CATALOG_SERVICE_PREFIX, baseDir);
}

/** UTF-8 byte length, matching the Rust host's `String::len`. */
export function connectionCatalogSize(catalog: string): number {
  return Buffer.byteLength(catalog, "utf8");
}

export async function readConnectionCatalog(
  keychain: DesktopKeychain,
  baseDir: string,
): Promise<string | null> {
  const service = connectionCatalogServiceName(baseDir);
  const entry = keychain.entry(service, CATALOG_ACCOUNT);
  try {
    return (await entry.getPassword()) ?? null;
  } catch (cause) {
    if (isMissingKeychainEntry(cause)) return null;
    throw new DesktopConnectionCatalogStoreKeychainError({ operation: "read", service, cause });
  }
}

export async function writeConnectionCatalog(
  keychain: DesktopKeychain,
  baseDir: string,
  catalog: string,
): Promise<void> {
  const service = connectionCatalogServiceName(baseDir);
  const size = connectionCatalogSize(catalog);
  if (size > MAX_CONNECTION_CATALOG_BYTES) {
    throw new DesktopConnectionCatalogStoreLimitError({
      service,
      size,
      limit: MAX_CONNECTION_CATALOG_BYTES,
    });
  }
  try {
    await keychain.entry(service, CATALOG_ACCOUNT).setPassword(catalog);
  } catch (cause) {
    throw new DesktopConnectionCatalogStoreKeychainError({ operation: "write", service, cause });
  }
}

export class DesktopConnectionCatalogStore extends Context.Service<
  DesktopConnectionCatalogStore,
  {
    readonly get: Effect.Effect<
      Option.Option<string>,
      DesktopConnectionCatalogStoreKeychainError | DesktopConnectionCatalogStoreUnavailableError
    >;
    readonly set: (
      catalog: string,
    ) => Effect.Effect<
      boolean,
      | DesktopConnectionCatalogStoreKeychainError
      | DesktopConnectionCatalogStoreLimitError
      | DesktopConnectionCatalogStoreUnavailableError
    >;
  }
>()("@houston-app/desktop/app/DesktopConnectionCatalogStore") {}

const isLimitError = Schema.is(DesktopConnectionCatalogStoreLimitError);
const isKeychainError = Schema.is(DesktopConnectionCatalogStoreKeychainError);

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const service = connectionCatalogServiceName(environment.baseDir);

  const keychain = Effect.gen(function* () {
    const loaded = yield* Effect.promise(loadDesktopKeychain);
    if (loaded.keychain === null) {
      return yield* new DesktopConnectionCatalogStoreUnavailableError({
        service,
        reason: loaded.unavailableReason ?? "no keychain provider is available",
      });
    }
    return loaded.keychain;
  }).pipe(Effect.withSpan("desktop.connectionCatalogStore.keychain"));

  return DesktopConnectionCatalogStore.of({
    get: Effect.gen(function* () {
      const store = yield* keychain;
      const value = yield* Effect.tryPromise({
        try: () => readConnectionCatalog(store, environment.baseDir),
        catch: (cause) =>
          isKeychainError(cause)
            ? cause
            : new DesktopConnectionCatalogStoreKeychainError({
                operation: "read",
                service,
                cause,
              }),
      });
      return Option.fromNullishOr(value);
    }).pipe(Effect.withSpan("desktop.connectionCatalogStore.get")),
    set: Effect.fn("desktop.connectionCatalogStore.set")(function* (catalog) {
      const store = yield* keychain;
      yield* Effect.tryPromise({
        try: () => writeConnectionCatalog(store, environment.baseDir, catalog),
        catch: (cause) =>
          isLimitError(cause)
            ? cause
            : new DesktopConnectionCatalogStoreKeychainError({
                operation: "write",
                service,
                cause,
              }),
      });
      return true;
    }),
  });
});

export const layer = Layer.effect(DesktopConnectionCatalogStore, make);
