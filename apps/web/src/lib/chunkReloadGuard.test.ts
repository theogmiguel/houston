import { describe, expect, it, vi } from "vite-plus/test";

import { CHUNK_RELOAD_INTERVAL_MS, reloadForChunkLoadError } from "./chunkReloadGuard";

function createStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

const attempt = (storage: Storage, reload: () => void, time: number) =>
  reloadForChunkLoadError(
    () => storage,
    reload,
    () => time,
  );

describe("reloadForChunkLoadError", () => {
  it("reloads on the first failure and lets a second one within the interval surface", () => {
    const storage = createStorageStub();
    const reload = vi.fn();
    let time = 1_000_000;

    expect(attempt(storage, reload, time)).toBe(true);
    time += 500;
    expect(attempt(storage, reload, time)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("surfaces a chunk that fails after the reloaded app has started", () => {
    // A lazy surface imports its chunk after first render, so the failure comes after startup.
    const storage = createStorageStub();
    const reload = vi.fn();
    let time = 1_000_000;

    attempt(storage, reload, time);
    time += 5_000;
    expect(attempt(storage, reload, time)).toBe(false);
    time += 20_000;
    expect(attempt(storage, reload, time)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads again once the interval has passed, for a later deploy", () => {
    const storage = createStorageStub();
    const reload = vi.fn();
    let time = 1_000_000;

    attempt(storage, reload, time);
    time += CHUNK_RELOAD_INTERVAL_MS;
    expect(attempt(storage, reload, time)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("reloads when the stored time is in the future or not a time", () => {
    const storage = createStorageStub();
    const reload = vi.fn();
    storage.setItem("houston:chunk-load-reloaded", "1");
    expect(attempt(storage, reload, 1_000_000)).toBe(true);
    expect(attempt(storage, reload, 10)).toBe(true);
    storage.setItem("houston:chunk-load-reloaded", "x");
    expect(attempt(storage, reload, 20)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(3);
  });

  it("never reloads when storage is blocked, so a persistent failure cannot loop", () => {
    const reload = vi.fn();
    const blocked = () => {
      throw new DOMException("blocked", "SecurityError");
    };

    expect(reloadForChunkLoadError(blocked, reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
