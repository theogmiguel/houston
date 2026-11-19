import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import type { DesktopKeychain } from "../backend/DesktopBootstrapSecret.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import {
  CONNECTION_CATALOG_KEYCHAIN_ACCOUNT,
  DesktopConnectionCatalogStoreLimitError,
  DesktopConnectionCatalogStoreUnavailableError,
  MAX_CONNECTION_CATALOG_BYTES,
  connectionCatalogServiceName,
  loadConnectionCatalog,
  saveConnectionCatalog,
} from "./DesktopConnectionCatalogStore.ts";

const BASE_DIR = "/home/theo/.houston/v2";
const XOR_KEY = 0x5a;

type SafeStorage = ElectronSafeStorage.ElectronSafeStorage["Service"];

function memorySafeStorage(
  input: {
    readonly available?: boolean;
    readonly backend?: string;
  } = {},
): SafeStorage {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const xor = (bytes: Uint8Array): Uint8Array => {
    const next = new Uint8Array(bytes);
    for (let index = 0; index < next.length; index += 1) {
      next[index] = next[index]! ^ XOR_KEY;
    }
    return next;
  };
  return ElectronSafeStorage.ElectronSafeStorage.of({
    isEncryptionAvailable: Effect.succeed(input.available ?? true),
    encryptString: (value) =>
      input.available === false
        ? Effect.fail(
            new ElectronSafeStorage.ElectronSafeStorageEncryptError({
              cause: new Error("encryption is unavailable"),
            }),
          )
        : Effect.succeed(xor(encoder.encode(value))),
    decryptString: (value) => Effect.succeed(decoder.decode(xor(value))),
    selectedStorageBackend: Effect.succeed(Option.fromNullishOr(input.backend)),
  });
}

function memoryKeychain(initial: string | null = null, failure?: Error) {
  const entries: Array<{ service: string; account: string }> = [];
  let value = initial;
  let deletions = 0;
  const keychain: DesktopKeychain = {
    entry: (service, account) => {
      entries.push({ service, account });
      return {
        getPassword: async () => {
          if (failure) throw failure;
          return value;
        },
        setPassword: async (next) => {
          if (failure) throw failure;
          value = next;
        },
        deletePassword: async () => {
          if (failure) throw failure;
          deletions += 1;
          value = null;
          return true;
        },
      };
    },
  };
  return { keychain, entries, read: () => value, deletions: () => deletions };
}

function legacyKeychain(keychain: DesktopKeychain | null) {
  return {
    service: connectionCatalogServiceName(BASE_DIR),
    account: CONNECTION_CATALOG_KEYCHAIN_ACCOUNT,
    load: async () => ({ keychain }),
  };
}

const withTempDir = <A, E, R>(
  run: (tempDir: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | PlatformError.PlatformError, R | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const tempDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "houston-connection-catalog-test-",
    });
    return yield* run(tempDir);
  }).pipe(Effect.scoped);

const catalogPathIn = (path: Path.Path, tempDir: string): string =>
  path.join(tempDir, "connection-catalog.bin");

describe("connectionCatalogServiceName", () => {
  it("scopes the service the way the installed host does", () => {
    assert.strictEqual(
      connectionCatalogServiceName(BASE_DIR),
      "houston-v2-catalog-7c97a36e65193682",
    );
    assert.notStrictEqual(
      connectionCatalogServiceName(BASE_DIR),
      connectionCatalogServiceName("/home/theo/.houston-dev/v2"),
    );
  });

  it("trims the base directory before hashing", () => {
    assert.strictEqual(
      connectionCatalogServiceName(`  ${BASE_DIR}  `),
      connectionCatalogServiceName(BASE_DIR),
    );
  });
});

describe("encrypted connection catalog file", () => {
  it.effect("round-trips a catalog larger than the Windows keychain limit", () =>
    withTempDir((tempDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const safeStorage = memorySafeStorage();
        const catalogPath = catalogPathIn(path, tempDir);
        const catalog = JSON.stringify({ targets: [{ token: "t".repeat(6000) }] });
        assert.isAbove(catalog.length, 2560);

        yield* saveConnectionCatalog({
          fileSystem,
          safeStorage,
          catalogPath,
          directory: tempDir,
          catalog,
          tempSuffix: "round-trip",
        });
        assert.isTrue(yield* fileSystem.exists(catalogPath));

        const loaded = yield* loadConnectionCatalog({
          fileSystem,
          safeStorage,
          catalogPath,
          directory: tempDir,
          legacy: legacyKeychain(null),
        });
        assert.strictEqual(Option.getOrNull(loaded), catalog);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the plaintext catalog out of the file on disk", () =>
    withTempDir((tempDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const catalogPath = catalogPathIn(path, tempDir);
        const token = "s".repeat(6000);
        const catalog = JSON.stringify({ targets: [{ token }] });

        yield* saveConnectionCatalog({
          fileSystem,
          safeStorage: memorySafeStorage(),
          catalogPath,
          directory: tempDir,
          catalog,
          tempSuffix: "plaintext",
        });

        const raw = yield* fileSystem.readFileString(catalogPath);
        assert.notInclude(raw, token);
        assert.notInclude(raw, catalog);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses to read or save when encryption is unavailable", () =>
    withTempDir((tempDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const safeStorage = memorySafeStorage({ available: false });
        const catalogPath = catalogPathIn(path, tempDir);

        const saveError = yield* saveConnectionCatalog({
          fileSystem,
          safeStorage,
          catalogPath,
          directory: tempDir,
          catalog: '{"targets":[]}',
          tempSuffix: "unavailable",
        }).pipe(Effect.flip);
        assert.instanceOf(saveError, DesktopConnectionCatalogStoreUnavailableError);
        assert.include(saveError.message, "not available");
        assert.isFalse(yield* fileSystem.exists(catalogPath));

        const readError = yield* loadConnectionCatalog({
          fileSystem,
          safeStorage,
          catalogPath,
          directory: tempDir,
          legacy: legacyKeychain(memoryKeychain('{"targets":[]}').keychain),
        }).pipe(Effect.flip);
        assert.instanceOf(readError, DesktopConnectionCatalogStoreUnavailableError);
        assert.include(readError.message, "not available");
        assert.isFalse(yield* fileSystem.exists(catalogPath));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses the Linux basic_text backend instead of storing plaintext", () =>
    withTempDir((tempDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const safeStorage = memorySafeStorage({ backend: "basic_text" });
        const catalogPath = catalogPathIn(path, tempDir);

        const error = yield* saveConnectionCatalog({
          fileSystem,
          safeStorage,
          catalogPath,
          directory: tempDir,
          catalog: '{"targets":[]}',
          tempSuffix: "basic-text",
        }).pipe(Effect.flip);
        assert.instanceOf(error, DesktopConnectionCatalogStoreUnavailableError);
        assert.include(error.message, "basic_text");
        assert.include(error.message, "does not encrypt");
        assert.isFalse(yield* fileSystem.exists(catalogPath));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("migrates a legacy keychain catalog once and deletes the old entry", () =>
    withTempDir((tempDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const safeStorage = memorySafeStorage();
        const catalogPath = catalogPathIn(path, tempDir);
        const catalog = '{"targets":[{"id":"remote-1"}]}';
        const legacy = memoryKeychain(catalog);

        const loaded = yield* loadConnectionCatalog({
          fileSystem,
          safeStorage,
          catalogPath,
          directory: tempDir,
          legacy: legacyKeychain(legacy.keychain),
        });
        assert.strictEqual(Option.getOrNull(loaded), catalog);
        assert.isTrue(yield* fileSystem.exists(catalogPath));
        assert.isNull(legacy.read());
        assert.strictEqual(legacy.deletions(), 1);

        const nextLegacy = memoryKeychain('{"targets":[{"id":"stale"}]}');
        const reread = yield* loadConnectionCatalog({
          fileSystem,
          safeStorage,
          catalogPath,
          directory: tempDir,
          legacy: legacyKeychain(nextLegacy.keychain),
        });
        assert.strictEqual(Option.getOrNull(reread), catalog);
        assert.strictEqual(nextLegacy.deletions(), 0);
        assert.strictEqual(nextLegacy.entries.length, 0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("treats a failing legacy keychain read as no catalog", () =>
    withTempDir((tempDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const safeStorage = memorySafeStorage();
        const catalogPath = catalogPathIn(path, tempDir);
        const legacy = memoryKeychain(null, new Error("secret service unavailable"));

        const loaded = yield* loadConnectionCatalog({
          fileSystem,
          safeStorage,
          catalogPath,
          directory: tempDir,
          legacy: legacyKeychain(legacy.keychain),
        });
        assert.isTrue(Option.isNone(loaded));
        assert.isFalse(yield* fileSystem.exists(catalogPath));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("treats a keychain that cannot load as no catalog", () =>
    withTempDir((tempDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const catalogPath = catalogPathIn(path, tempDir);

        const loaded = yield* loadConnectionCatalog({
          fileSystem,
          safeStorage: memorySafeStorage(),
          catalogPath,
          directory: tempDir,
          legacy: {
            service: connectionCatalogServiceName(BASE_DIR),
            account: CONNECTION_CATALOG_KEYCHAIN_ACCOUNT,
            load: async () => {
              throw new Error("keychain module failed to load");
            },
          },
        });
        assert.isTrue(Option.isNone(loaded));
        assert.isFalse(yield* fileSystem.exists(catalogPath));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses an over-limit catalog naming the limit and file", () =>
    withTempDir((tempDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const catalogPath = catalogPathIn(path, tempDir);
        const catalog = "x".repeat(MAX_CONNECTION_CATALOG_BYTES + 1);

        const error = yield* saveConnectionCatalog({
          fileSystem,
          safeStorage: memorySafeStorage(),
          catalogPath,
          directory: tempDir,
          catalog,
          tempSuffix: "too-large",
        }).pipe(Effect.flip);
        assert.instanceOf(error, DesktopConnectionCatalogStoreLimitError);
        assert.include(error.message, String(MAX_CONNECTION_CATALOG_BYTES));
        assert.include(error.message, String(MAX_CONNECTION_CATALOG_BYTES + 1));
        assert.include(error.message, catalogPath);
        assert.isFalse(yield* fileSystem.exists(catalogPath));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("counts UTF-8 bytes rather than characters", () =>
    withTempDir((tempDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const catalogPath = catalogPathIn(path, tempDir);
        const catalog = "é".repeat(MAX_CONNECTION_CATALOG_BYTES / 2 + 1);

        const error = yield* saveConnectionCatalog({
          fileSystem,
          safeStorage: memorySafeStorage(),
          catalogPath,
          directory: tempDir,
          catalog,
          tempSuffix: "utf8",
        }).pipe(Effect.flip);
        assert.instanceOf(error, DesktopConnectionCatalogStoreLimitError);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
