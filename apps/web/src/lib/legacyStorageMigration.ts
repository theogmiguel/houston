/**
 * Moves browser state written under the upstream storage names to Houston's names.
 * Each pair is copied only when the Houston key is absent, then the old key is removed,
 * so running this repeatedly converges and never overwrites newer state.
 */
export const LEGACY_STORAGE_KEY_PAIRS: ReadonlyArray<readonly [current: string, legacy: string]> = [
  ["houston:themes:v1", "t3code:themes:v1"],
  ["houston:theme-follow-system", "t3code:theme-follow-system"],
  ["houston:theme-appearance-mode", "t3code:theme-appearance-mode"],
  ["houston:theme-halves:v1", "t3code:theme-halves:v1"],
  ["houston:theme", "t3code:theme"],
  ["houston:typography-advanced", "t3code:typography-advanced"],
  ["houston:browser-favicons:v1", "t3code:browser-favicons:v1"],
  ["houston:browser-history:v1", "t3code:browser-history:v1"],
  ["houston:client-settings:v1", "t3code:client-settings:v1"],
  ["houston:closed-views:v2", "t3code:closed-views:v2"],
  ["houston:composer-drafts:v1", "t3code:composer-drafts:v1"],
  ["houston:diff-panel-state:v1", "t3code:diff-panel-state:v1"],
  ["houston:last-editor", "t3code:last-editor"],
  ["houston:prompt-stash:v2", "t3code:prompt-stash:v2"],
  ["houston:prompt-stash:v1", "t3code:prompt-stash:v1"],
  ["houston:pull-request-comment-filter:v1", "t3code:pull-request-comment-filter:v1"],
  ["houston:remote-open-hint-seen", "t3code:remote-open-hint-seen"],
  ["houston:right-panel-state:v2", "t3code:right-panel-state:v2"],
  ["houston:sidebar:collapsed-grids", "t3code:sidebar:collapsed-grids"],
  ["houston:sidebar:settled-expanded", "t3code:sidebar:settled-expanded"],
  ["houston:sidebar:snoozed-expanded", "t3code:sidebar:snoozed-expanded"],
  ["houston:sidebar:working-expanded", "t3code:sidebar:working-expanded"],
  ["houston:snap-shot-setup-resume:v1", "t3code:snap-shot-setup-resume:v1"],
  ["houston:terminal-state:v1", "t3code:terminal-state:v1"],
  ["houston:ui-state:v1", "t3code:ui-state:v1"],
  ["houston:renderer-state:v8", "t3code:renderer-state:v8"],
  ["houston:renderer-state:v7", "t3code:renderer-state:v7"],
  ["houston:renderer-state:v6", "t3code:renderer-state:v6"],
  ["houston:renderer-state:v5", "t3code:renderer-state:v5"],
  ["houston:renderer-state:v4", "t3code:renderer-state:v4"],
  ["houston:renderer-state:v3", "t3code:renderer-state:v3"],
  ["houston:version-mismatch-dismissals:v1", "t3code:version-mismatch-dismissals:v1"],
  ["houston:analytics-device-id", "t3code:analytics-device-id"],
  ["houston:boot-failed-at", "t3code:boot-failed-at"],
  ["houston:chunk-load-reloaded", "t3code:chunk-load-reloaded"],
  ["houston:last-enabled-project-grouping-mode", "t3code:last-enabled-project-grouping-mode"],
  ["houston:last-invoked-script-by-project", "t3code:last-invoked-script-by-project"],
  ["houston:update-everything-result:v1", "t3code:update-everything-result:v1"],
  ["houston:usage-page-preferences:v1", "t3code:usage-page-preferences:v1"],
  ["houston:prompt-link-opener", "t3code:prompt-link-opener"],
  ["houston:diff-file-tree-width", "t3code:diff-file-tree-width"],
  ["houston:pull-request-panel-width", "t3code:pull-request-panel-width"],
  ["houston:preview-panel-width", "t3code:preview-panel-width"],
  ["houston.diffFileTreeOpen", "t3code.diffFileTreeOpen"],
  ["houston.diffHideTestFiles", "t3code.diffHideTestFiles"],
  ["houston.fileExplorerOpen", "t3code.fileExplorerOpen"],
  ["houston.fileExplorerWidth", "t3code.fileExplorerWidth"],
  ["houston.pullRequestFileTreeOpen", "t3code.pullRequestFileTreeOpen"],
  ["houston.renderBrowserFile", "t3code.renderBrowserFile"],
  ["houston.renderMarkdown", "t3code.renderMarkdown"],
  ["houston.renderMermaid", "t3code.renderMermaid"],
  ["houston.renderTable", "t3code.renderTable"],
  ["houston.pullRequests.listScopes", "houston.pullRequests.listScopes"],
  ["houston.pullRequests.preferences", "houston.pullRequests.preferences"],
  ["houston.pullRequests.recentDetails", "houston.pullRequests.recentDetails"],
  ["houston.backgroundActivity.clientId", "houston.backgroundActivity.clientId"],
  ["houston:chatgpt-sharing-welcome:v1", "houston:chatgpt-sharing-welcome:v1"],
];

export const LEGACY_STORAGE_KEY_PREFIX_PAIRS: ReadonlyArray<
  readonly [current: string, legacy: string]
> = [
  ["houston:default-theme-applied:v2:", "t3code:default-theme-applied:v2:"],
  ["houston:fallback-notice-dismissed:", "t3code:fallback-notice-dismissed:"],
  ["houston:github-routing:", "t3code:github-routing:"],
  ["houston:github-routing-changed", "t3code:github-routing-changed"],
  ["houston:permission-update:v1:", "t3code:permission-update:v1:"],
  ["houston:preview-panel-width:", "t3code:preview-panel-width:"],
  ["houston:resume-compaction-dismissed:", "t3code:resume-compaction-dismissed:"],
  ["houston.pullRequests.detail:", "houston.pullRequests.detail:"],
  ["houston.pullRequests.listScope:", "houston.pullRequests.listScope:"],
];

export const LEGACY_CONNECTION_DATABASE_NAME = "t3code:connection-runtime";
export const CONNECTION_DATABASE_NAME = "houston:connection-runtime";

function copyKey(storage: Storage, current: string, legacy: string): void {
  if (storage.getItem(current) !== null) {
    storage.removeItem(legacy);
    return;
  }
  const value = storage.getItem(legacy);
  if (value === null) {
    return;
  }
  storage.setItem(current, value);
  storage.removeItem(legacy);
}

/** Runs synchronously before the first renderer read of localStorage. */
export function migrateLegacyLocalStorage(storage: Storage): void {
  for (const [current, legacy] of LEGACY_STORAGE_KEY_PAIRS) {
    copyKey(storage, current, legacy);
  }
  for (const [currentPrefix, legacyPrefix] of LEGACY_STORAGE_KEY_PREFIX_PAIRS) {
    const legacyKeys: string[] = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key?.startsWith(legacyPrefix)) {
        legacyKeys.push(key);
      }
    }
    for (const legacyKey of legacyKeys) {
      copyKey(storage, `${currentPrefix}${legacyKey.slice(legacyPrefix.length)}`, legacyKey);
    }
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB error")));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("error", () =>
      reject(transaction.error ?? new Error("IndexedDB transaction error")),
    );
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted")),
    );
  });
}

function openDatabase(
  name: string,
  version: number | undefined,
  createStores: ReadonlyArray<string>,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
    request.addEventListener("upgradeneeded", () => {
      for (const store of createStores) {
        if (!request.result.objectStoreNames.contains(store)) {
          request.result.createObjectStore(store);
        }
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB error")));
  });
}

async function migrateLegacyConnectionDatabase(): Promise<void> {
  if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") {
    return;
  }
  const databases = await indexedDB.databases();
  const names = new Set(databases.map((database) => database.name));
  if (!names.has(LEGACY_CONNECTION_DATABASE_NAME) || names.has(CONNECTION_DATABASE_NAME)) {
    return;
  }
  const legacyDatabase = await openDatabase(LEGACY_CONNECTION_DATABASE_NAME, undefined, []);
  if (legacyDatabase.version < 1) {
    legacyDatabase.close();
    indexedDB.deleteDatabase(LEGACY_CONNECTION_DATABASE_NAME);
    return;
  }
  const storeNames = Array.from(legacyDatabase.objectStoreNames);
  const currentDatabase = await openDatabase(
    CONNECTION_DATABASE_NAME,
    legacyDatabase.version,
    storeNames,
  );
  for (const storeName of storeNames) {
    const legacyStore = legacyDatabase.transaction(storeName, "readonly").objectStore(storeName);
    const [keys, values] = await Promise.all([
      requestResult(legacyStore.getAllKeys()),
      requestResult(legacyStore.getAll()),
    ]);
    const transaction = currentDatabase.transaction(storeName, "readwrite");
    const currentStore = transaction.objectStore(storeName);
    for (let index = 0; index < keys.length; index++) {
      currentStore.put(values[index], keys[index]);
    }
    await transactionDone(transaction);
  }
  legacyDatabase.close();
  currentDatabase.close();
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(LEGACY_CONNECTION_DATABASE_NAME);
    request.addEventListener("success", () => resolve());
    request.addEventListener("error", () => resolve());
    request.addEventListener("blocked", () => resolve());
  });
}

let connectionDatabaseMigration: Promise<void> | null = null;

/** Resolves once the old connection database has been copied, or immediately when there is none. */
export function ensureLegacyConnectionDatabaseMigrated(): Promise<void> {
  connectionDatabaseMigration ??= migrateLegacyConnectionDatabase().catch(() => undefined);
  return connectionDatabaseMigration;
}

if (typeof window !== "undefined") {
  try {
    migrateLegacyLocalStorage(window.localStorage);
  } catch {}
  void ensureLegacyConnectionDatabaseMigrated();
}
