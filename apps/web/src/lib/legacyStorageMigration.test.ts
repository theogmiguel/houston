import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  LEGACY_CONNECTION_DATABASE_NAME,
  LEGACY_STORAGE_KEY_PAIRS,
  LEGACY_STORAGE_KEY_PREFIX_PAIRS,
  migrateLegacyLocalStorage,
} from "./legacyStorageMigration";

function makeStorage(entries: ReadonlyArray<readonly [string, string]>): Storage {
  const values = new Map(entries);
  return {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => {
      values.clear();
    },
  };
}

describe("migrateLegacyLocalStorage", () => {
  it.each(LEGACY_STORAGE_KEY_PAIRS)("moves %s from %s", (current, legacy) => {
    const storage = makeStorage([[legacy, `value-for-${current}`]]);

    migrateLegacyLocalStorage(storage);

    expect(storage.getItem(current)).toBe(`value-for-${current}`);
    expect(storage.getItem(legacy)).toBeNull();
  });

  it.each(LEGACY_STORAGE_KEY_PREFIX_PAIRS)("moves %s* keys from %s*", (current, legacy) => {
    const storage = makeStorage([
      [`${legacy}entry`, "prefixed value"],
      [`${legacy}other`, "another value"],
    ]);

    migrateLegacyLocalStorage(storage);

    expect(storage.getItem(`${current}entry`)).toBe("prefixed value");
    expect(storage.getItem(`${current}other`)).toBe("another value");
    expect(storage.getItem(`${legacy}entry`)).toBeNull();
    expect(storage.getItem(`${legacy}other`)).toBeNull();
  });

  it("keeps the current value and drops a stale legacy copy", () => {
    const [current, legacy] = LEGACY_STORAGE_KEY_PAIRS[0]!;
    const storage = makeStorage([
      [current, "new"],
      [legacy, "old"],
    ]);

    migrateLegacyLocalStorage(storage);

    expect(storage.getItem(current)).toBe("new");
    expect(storage.getItem(legacy)).toBeNull();
  });

  it("is idempotent and leaves unrelated keys alone", () => {
    const [current, legacy] = LEGACY_STORAGE_KEY_PAIRS[0]!;
    const storage = makeStorage([
      [legacy, "old"],
      ["unrelated", "kept"],
    ]);

    migrateLegacyLocalStorage(storage);
    migrateLegacyLocalStorage(storage);

    expect(storage.getItem(current)).toBe("old");
    expect(storage.getItem(legacy)).toBeNull();
    expect(storage.getItem("unrelated")).toBe("kept");
  });
});

type FakeDatabase = {
  version: number;
  stores: Map<string, Map<IDBValidKey, unknown>>;
};

function fakeRequest<T>(result: T): IDBRequest<T> {
  const request = new EventTarget() as IDBRequest<T> & { result: T; error: DOMException | null };
  request.result = result;
  request.error = null;
  queueMicrotask(() => request.dispatchEvent(new Event("success")));
  return request;
}

function createFakeIndexedDb(initial: ReadonlyArray<readonly [string, FakeDatabase]>) {
  const databases = new Map<string, FakeDatabase>(initial);

  const open = (name: string, version?: number) => {
    const request = new EventTarget() as IDBOpenDBRequest & {
      result: IDBDatabase;
      error: DOMException | null;
    };
    request.error = null;
    queueMicrotask(() => {
      let database = databases.get(name);
      let upgrade = false;
      if (database === undefined) {
        database = { version: version ?? 1, stores: new Map() };
        databases.set(name, database);
        upgrade = true;
      } else if (version !== undefined && version > database.version) {
        database.version = version;
        upgrade = true;
      }
      const current = database;
      request.result = Object.assign(new EventTarget(), {
        name,
        version: current.version,
        objectStoreNames: {
          contains: (store: string) => current.stores.has(store),
          [Symbol.iterator]: () => current.stores.keys(),
        },
        createObjectStore: (store: string) => {
          current.stores.set(store, new Map());
        },
        close: () => {},
        transaction: (store: string, mode: string) => {
          const transaction = new EventTarget() as IDBTransaction & {
            error: DOMException | null;
          };
          transaction.error = null;
          const records = current.stores.get(store) ?? new Map();
          current.stores.set(store, records);
          transaction.objectStore = () =>
            ({
              getAllKeys: () => fakeRequest([...records.keys()]),
              getAll: () => fakeRequest([...records.values()]),
              put: (value: unknown, key: IDBValidKey) => {
                records.set(key, value);
                return fakeRequest(key);
              },
            }) as unknown as IDBObjectStore;
          if (mode === "readwrite") {
            queueMicrotask(() => transaction.dispatchEvent(new Event("complete")));
          }
          return transaction;
        },
      }) as unknown as IDBDatabase;
      if (upgrade) request.dispatchEvent(new Event("upgradeneeded"));
      request.dispatchEvent(new Event("success"));
    });
    return request;
  };

  return {
    open,
    databases: async () => [...databases.keys()].map((name) => ({ name, version: 1 })),
    deleteDatabase: (name: string) => {
      databases.delete(name);
      return fakeRequest(undefined);
    },
    snapshot: () => databases,
  };
}

describe("legacy connection database migration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("copies every object store before the connection database opens", async () => {
    const legacy = {
      version: 4,
      stores: new Map<string, Map<IDBValidKey, unknown>>([
        ["catalog", new Map<IDBValidKey, unknown>([["document", { connections: 2 }]])],
        ["thread", new Map<IDBValidKey, unknown>([["thread-1", { title: "one" }]])],
      ]),
    };
    const fake = createFakeIndexedDb([[LEGACY_CONNECTION_DATABASE_NAME, legacy]]);
    vi.stubGlobal("indexedDB", fake);
    vi.resetModules();
    const { ensureLegacyConnectionDatabaseMigrated } = await import("./legacyStorageMigration");

    await ensureLegacyConnectionDatabaseMigrated();

    const snapshot = fake.snapshot();
    expect(snapshot.has(LEGACY_CONNECTION_DATABASE_NAME)).toBe(false);
    const current = snapshot.get("houston:connection-runtime");
    expect(current?.version).toBe(4);
    expect(current?.stores.get("catalog")?.get("document")).toEqual({ connections: 2 });
    expect(current?.stores.get("thread")?.get("thread-1")).toEqual({ title: "one" });
  });

  it("does nothing when the Houston database already exists", async () => {
    const fake = createFakeIndexedDb([
      [LEGACY_CONNECTION_DATABASE_NAME, { version: 4, stores: new Map() }],
      ["houston:connection-runtime", { version: 4, stores: new Map() }],
    ]);
    vi.stubGlobal("indexedDB", fake);
    vi.resetModules();
    const { ensureLegacyConnectionDatabaseMigrated } = await import("./legacyStorageMigration");

    await ensureLegacyConnectionDatabaseMigrated();

    expect(fake.snapshot().has(LEGACY_CONNECTION_DATABASE_NAME)).toBe(true);
  });
});
