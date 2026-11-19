import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  isMissingKeychainEntry,
  keychainServiceName,
  loadDesktopKeychain,
  type DesktopKeychain,
  type DesktopKeychainEntry,
} from "../backend/DesktopBootstrapSecret.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const CATALOG_SERVICE_PREFIX = "houston-v2-catalog";
const CATALOG_ACCOUNT = "connection-catalog";
// The catalog lives in a file; this bound keeps one corrupt document from exhausting memory.
export const MAX_CONNECTION_CATALOG_BYTES = 4 * 1024 * 1024;

export const CONNECTION_CATALOG_KEYCHAIN_ACCOUNT = CATALOG_ACCOUNT;

const CatalogOperation = Schema.Literals(["read", "write", "encrypt", "decrypt"]);

export class DesktopConnectionCatalogStoreLimitError extends Schema.TaggedError<DesktopConnectionCatalogStoreLimitError>()(
  "DesktopConnectionCatalogStoreLimitError",
  {
    path: Schema.String,
    size: Schema.Int,
    limit: Schema.Int,
  },
) {
  override get message(): string {
    return `Refusing to save the connection catalog: ${this.size} bytes exceeds the ${this.limit} byte file limit at "${this.path}".`;
  }
}

export class DesktopConnectionCatalogStoreFileError extends Schema.TaggedError<DesktopConnectionCatalogStoreFileError>()(
  "DesktopConnectionCatalogStoreFileError",
  {
    operation: CatalogOperation,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `The connection catalog ${this.operation} at "${this.path}" failed: ${describeCause(this.cause)}`;
  }
}

export class DesktopConnectionCatalogStoreUnavailableError extends Schema.TaggedError<DesktopConnectionCatalogStoreUnavailableError>()(
  "DesktopConnectionCatalogStoreUnavailableError",
  {
    path: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Cannot read or save the connection catalog at "${this.path}" because secure storage is unavailable (${this.reason}); Houston does not keep a plaintext copy.`;
  }
}

export interface LegacyConnectionCatalog {
  readonly service: string;
  readonly account: string;
  readonly load: () => Promise<{
    readonly keychain: DesktopKeychain | null;
    readonly unavailableReason?: string;
  }>;
}

export interface LoadConnectionCatalogInput {
  readonly fileSystem: FileSystem.FileSystem;
  readonly safeStorage: ElectronSafeStorage.ElectronSafeStorage["Service"];
  readonly catalogPath: string;
  readonly directory: string;
  readonly legacy: LegacyConnectionCatalog;
}

export interface SaveConnectionCatalogInput {
  readonly fileSystem: FileSystem.FileSystem;
  readonly safeStorage: ElectronSafeStorage.ElectronSafeStorage["Service"];
  readonly catalogPath: string;
  readonly directory: string;
  readonly catalog: string;
  readonly tempSuffix: string;
}

/** `houston-v2-catalog-<first 16 hex of sha256(baseDir.trim())>`. */
export function connectionCatalogServiceName(baseDir: string): string {
  return keychainServiceName(CATALOG_SERVICE_PREFIX, baseDir);
}

/** UTF-8 byte length, matching the Rust host's `String::len`. */
export function connectionCatalogSize(catalog: string): number {
  return Buffer.byteLength(catalog, "utf8");
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

let temporaryFileSequence = 0;

function temporaryCatalogPath(catalogPath: string, suffix: string): string {
  temporaryFileSequence += 1;
  return `${catalogPath}.${process.pid}.${temporaryFileSequence}.${suffix}.tmp`;
}

const requireEncryption = Effect.fn("desktop.connectionCatalogStore.requireEncryption")(function* (
  input: Pick<LoadConnectionCatalogInput, "safeStorage" | "catalogPath">,
) {
  const available = yield* input.safeStorage.isEncryptionAvailable.pipe(
    Effect.mapError(
      (cause) =>
        new DesktopConnectionCatalogStoreUnavailableError({
          path: input.catalogPath,
          reason: `safeStorage could not check encryption availability: ${describeCause(cause)}`,
        }),
    ),
  );
  if (!available) {
    return yield* new DesktopConnectionCatalogStoreUnavailableError({
      path: input.catalogPath,
      reason: "safeStorage reports that encryption is not available",
    });
  }
  const backend = yield* input.safeStorage.selectedStorageBackend;
  if (Option.contains(backend, "basic_text")) {
    return yield* new DesktopConnectionCatalogStoreUnavailableError({
      path: input.catalogPath,
      reason: "safeStorage is using the basic_text backend, which does not encrypt",
    });
  }
});

const readCatalogBytes = (
  fileSystem: FileSystem.FileSystem,
  catalogPath: string,
): Effect.Effect<Option.Option<Uint8Array>, DesktopConnectionCatalogStoreFileError> =>
  fileSystem.readFile(catalogPath).pipe(
    Effect.asSome,
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(Option.none<Uint8Array>())
          : Effect.fail(
              new DesktopConnectionCatalogStoreFileError({
                operation: "read",
                path: catalogPath,
                cause,
              }),
            ),
    }),
  );

const writeCatalogBytes = Effect.fn("desktop.connectionCatalogStore.writeFile")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly catalogPath: string;
    readonly directory: string;
    readonly bytes: Uint8Array;
    readonly tempSuffix: string;
  }) {
    yield* input.fileSystem.makeDirectory(input.directory, { recursive: true });
    const temporaryPath = temporaryCatalogPath(input.catalogPath, input.tempSuffix);
    yield* input.fileSystem.writeFile(temporaryPath, input.bytes, { mode: 0o600 });
    yield* input.fileSystem.rename(temporaryPath, input.catalogPath);
  },
  (effect, input) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreFileError({
            operation: "write",
            path: input.catalogPath,
            cause,
          }),
      ),
    ),
);

const encryptCatalog = (
  input: Pick<SaveConnectionCatalogInput, "safeStorage" | "catalogPath">,
  catalog: string,
) =>
  input.safeStorage.encryptString(catalog).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopConnectionCatalogStoreFileError({
          operation: "encrypt",
          path: input.catalogPath,
          cause,
        }),
    ),
  );

type LegacyCatalogRead =
  | { readonly _tag: "none" }
  | {
      readonly _tag: "found";
      readonly catalog: string;
      readonly entry: DesktopKeychainEntry;
    }
  | { readonly _tag: "warning"; readonly reason: string };

async function readLegacyCatalogPromise(
  legacy: LegacyConnectionCatalog,
): Promise<LegacyCatalogRead> {
  let loaded: Awaited<ReturnType<LegacyConnectionCatalog["load"]>>;
  try {
    loaded = await legacy.load();
  } catch (cause) {
    return { _tag: "warning", reason: describeCause(cause) };
  }
  if (loaded.keychain === null) {
    return {
      _tag: "warning",
      reason: loaded.unavailableReason ?? "no keychain provider is available",
    };
  }
  let entry: DesktopKeychainEntry;
  try {
    entry = loaded.keychain.entry(legacy.service, legacy.account);
  } catch (cause) {
    return { _tag: "warning", reason: describeCause(cause) };
  }
  try {
    const value = await entry.getPassword();
    return typeof value === "string" ? { _tag: "found", catalog: value, entry } : { _tag: "none" };
  } catch (cause) {
    return isMissingKeychainEntry(cause)
      ? { _tag: "none" }
      : { _tag: "warning", reason: describeCause(cause) };
  }
}

const readLegacyCatalog = (legacy: LegacyConnectionCatalog): Effect.Effect<LegacyCatalogRead> =>
  Effect.promise(() => readLegacyCatalogPromise(legacy)).pipe(
    Effect.tap((result) =>
      result._tag === "warning"
        ? Effect.logWarning(
            "Could not read the legacy connection catalog keychain entry; treating it as no catalog.",
            { reason: result.reason },
          )
        : Effect.void,
    ),
  );

const deleteLegacyCatalog = (entry: DesktopKeychainEntry): Effect.Effect<void> => {
  const deletePassword = entry.deletePassword;
  if (deletePassword === undefined) {
    return Effect.logWarning(
      "The legacy connection catalog keychain entry could not be deleted because this keychain does not support deletion; a stale copy remains.",
    );
  }
  return Effect.promise(async () => {
    try {
      await deletePassword.call(entry);
      return null;
    } catch (cause) {
      return describeCause(cause);
    }
  }).pipe(
    Effect.flatMap((failure) =>
      failure === null
        ? Effect.void
        : Effect.logWarning(
            "Could not delete the legacy connection catalog keychain entry; a stale copy remains.",
            { reason: failure },
          ),
    ),
  );
};

export const saveConnectionCatalog = Effect.fn("desktop.connectionCatalogStore.save")(function* (
  input: SaveConnectionCatalogInput,
) {
  yield* requireEncryption(input);
  const size = connectionCatalogSize(input.catalog);
  if (size > MAX_CONNECTION_CATALOG_BYTES) {
    return yield* new DesktopConnectionCatalogStoreLimitError({
      path: input.catalogPath,
      size,
      limit: MAX_CONNECTION_CATALOG_BYTES,
    });
  }
  const encrypted = yield* encryptCatalog(input, input.catalog);
  yield* writeCatalogBytes({
    fileSystem: input.fileSystem,
    catalogPath: input.catalogPath,
    directory: input.directory,
    bytes: encrypted,
    tempSuffix: input.tempSuffix,
  });
});

export const loadConnectionCatalog = Effect.fn("desktop.connectionCatalogStore.load")(function* (
  input: LoadConnectionCatalogInput,
) {
  yield* requireEncryption(input);
  const bytes = yield* readCatalogBytes(input.fileSystem, input.catalogPath);
  if (Option.isSome(bytes)) {
    return Option.some(
      yield* input.safeStorage.decryptString(bytes.value).pipe(
        Effect.mapError(
          (cause) =>
            new DesktopConnectionCatalogStoreFileError({
              operation: "decrypt",
              path: input.catalogPath,
              cause,
            }),
        ),
      ),
    );
  }

  const legacy = yield* readLegacyCatalog(input.legacy);
  if (legacy._tag !== "found") {
    return Option.none<string>();
  }
  const size = connectionCatalogSize(legacy.catalog);
  if (size > MAX_CONNECTION_CATALOG_BYTES) {
    return yield* new DesktopConnectionCatalogStoreLimitError({
      path: input.catalogPath,
      size,
      limit: MAX_CONNECTION_CATALOG_BYTES,
    });
  }
  const encrypted = yield* encryptCatalog(input, legacy.catalog);
  yield* writeCatalogBytes({
    fileSystem: input.fileSystem,
    catalogPath: input.catalogPath,
    directory: input.directory,
    bytes: encrypted,
    tempSuffix: "legacy",
  });
  yield* deleteLegacyCatalog(legacy.entry);
  return Option.some(legacy.catalog);
});

export class DesktopConnectionCatalogStore extends Context.Service<
  DesktopConnectionCatalogStore,
  {
    readonly get: Effect.Effect<
      Option.Option<string>,
      | DesktopConnectionCatalogStoreFileError
      | DesktopConnectionCatalogStoreLimitError
      | DesktopConnectionCatalogStoreUnavailableError
    >;
    readonly set: (
      catalog: string,
    ) => Effect.Effect<
      boolean,
      | DesktopConnectionCatalogStoreFileError
      | DesktopConnectionCatalogStoreLimitError
      | DesktopConnectionCatalogStoreUnavailableError
    >;
  }
>()("@houston-app/desktop/app/DesktopConnectionCatalogStore") {}

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const catalogPath = environment.connectionCatalogPath;
  const directory = environment.path.dirname(catalogPath);
  const legacy: LegacyConnectionCatalog = {
    service: connectionCatalogServiceName(environment.baseDir),
    account: CATALOG_ACCOUNT,
    load: loadDesktopKeychain,
  };

  return DesktopConnectionCatalogStore.of({
    get: loadConnectionCatalog({ fileSystem, safeStorage, catalogPath, directory, legacy }).pipe(
      Effect.withSpan("desktop.connectionCatalogStore.get"),
    ),
    set: Effect.fn("desktop.connectionCatalogStore.set")(function* (catalog) {
      yield* saveConnectionCatalog({
        fileSystem,
        safeStorage,
        catalogPath,
        directory,
        catalog,
        tempSuffix: "catalog",
      });
      return true;
    }),
  });
});

export const layer = Layer.effect(DesktopConnectionCatalogStore, make);
