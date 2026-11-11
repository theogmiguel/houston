import { describe, expect, it } from "vite-plus/test";

import {
  createImportedEnvironments,
  GRID_IMPORTED_STORAGE_KEY,
  MAX_IMPORTED_ENVIRONMENTS,
} from "./gridSyncRuntime";

function memoryStorage(initial?: string) {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(GRID_IMPORTED_STORAGE_KEY, initial);
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

describe("createImportedEnvironments", () => {
  it("remembers an environment once added", () => {
    const storage = memoryStorage();
    createImportedEnvironments(storage).add("env-a");
    expect(createImportedEnvironments(storage).has("env-a")).toBe(true);
    expect(createImportedEnvironments(storage).has("env-b")).toBe(false);
  });

  it("treats a corrupt value as empty", () => {
    expect(createImportedEnvironments(memoryStorage("{nope")).has("env-a")).toBe(false);
    expect(createImportedEnvironments(memoryStorage('{"a":1}')).has("env-a")).toBe(false);
  });

  it("keeps only the most recent environments", () => {
    const storage = memoryStorage();
    const imported = createImportedEnvironments(storage);
    for (let index = 0; index < MAX_IMPORTED_ENVIRONMENTS + 5; index += 1)
      imported.add(`env-${index}`);
    expect(imported.has("env-0")).toBe(false);
    expect(imported.has(`env-${MAX_IMPORTED_ENVIRONMENTS + 4}`)).toBe(true);
  });
});
