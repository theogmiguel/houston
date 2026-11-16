import { assert, describe, it } from "@effect/vitest";

import type { DesktopKeychain } from "../backend/DesktopBootstrapSecret.ts";
import {
  CONNECTION_CATALOG_KEYCHAIN_ACCOUNT,
  DesktopConnectionCatalogStoreKeychainError,
  DesktopConnectionCatalogStoreLimitError,
  MAX_CONNECTION_CATALOG_BYTES,
  connectionCatalogServiceName,
  readConnectionCatalog,
  writeConnectionCatalog,
} from "./DesktopConnectionCatalogStore.ts";

const BASE_DIR = "/home/theo/.houston/v2";

function memoryKeychain(initial: string | null = null, failure?: Error) {
  const entries: Array<{ service: string; account: string }> = [];
  let value = initial;
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
      };
    },
  };
  return { keychain, entries, read: () => value };
}

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

describe("connection catalog keychain entry", () => {
  it("reads and writes the catalog under the shared service and account", async () => {
    const store = memoryKeychain();
    assert.isNull(await readConnectionCatalog(store.keychain, BASE_DIR));
    await writeConnectionCatalog(store.keychain, BASE_DIR, '{"targets":[]}');
    assert.strictEqual(store.read(), '{"targets":[]}');
    assert.strictEqual(await readConnectionCatalog(store.keychain, BASE_DIR), '{"targets":[]}');
    assert.deepStrictEqual(store.entries, [
      {
        service: connectionCatalogServiceName(BASE_DIR),
        account: CONNECTION_CATALOG_KEYCHAIN_ACCOUNT,
      },
      {
        service: connectionCatalogServiceName(BASE_DIR),
        account: CONNECTION_CATALOG_KEYCHAIN_ACCOUNT,
      },
      {
        service: connectionCatalogServiceName(BASE_DIR),
        account: CONNECTION_CATALOG_KEYCHAIN_ACCOUNT,
      },
    ]);
  });

  it("treats a missing entry as an empty catalog", async () => {
    const store = memoryKeychain(null, new Error("No matching entry found in secure storage"));
    assert.isNull(await readConnectionCatalog(store.keychain, BASE_DIR));
  });

  it("refuses an over-cap catalog naming the cap and both sizes", async () => {
    const store = memoryKeychain();
    const catalog = "x".repeat(MAX_CONNECTION_CATALOG_BYTES + 1);
    const error = await writeConnectionCatalog(store.keychain, BASE_DIR, catalog).then(
      () => assert.fail("oversized catalog must be refused"),
      (cause: unknown) => cause,
    );
    assert.instanceOf(error, DesktopConnectionCatalogStoreLimitError);
    assert.include(error.message, String(MAX_CONNECTION_CATALOG_BYTES));
    assert.include(error.message, String(MAX_CONNECTION_CATALOG_BYTES + 1));
    assert.include(error.message, connectionCatalogServiceName(BASE_DIR));
    assert.isNull(store.read());
  });

  it("counts UTF-8 bytes rather than characters", async () => {
    const store = memoryKeychain();
    const catalog = "é".repeat(MAX_CONNECTION_CATALOG_BYTES / 2 + 1);
    const error = await writeConnectionCatalog(store.keychain, BASE_DIR, catalog).then(
      () => assert.fail("oversized catalog must be refused"),
      (cause: unknown) => cause,
    );
    assert.instanceOf(error, DesktopConnectionCatalogStoreLimitError);
  });

  it("reports keychain failures instead of falling back to plaintext", async () => {
    const store = memoryKeychain(null, new Error("secret service unavailable"));
    const error = await readConnectionCatalog(store.keychain, BASE_DIR).then(
      () => assert.fail("keychain failure must surface"),
      (cause: unknown) => cause,
    );
    assert.instanceOf(error, DesktopConnectionCatalogStoreKeychainError);
    assert.include(error.message, "secret service unavailable");
  });
});
