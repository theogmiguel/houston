import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

function createStorage(overrides: Partial<Storage> = {}): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("local storage errors", () => {
  it("retries when access to browser storage becomes available", async () => {
    const storage = createStorage();
    storage.setItem("read-key", JSON.stringify("saved value"));
    let blocked = true;
    vi.stubGlobal("window", {
      get localStorage() {
        if (blocked) throw new Error("storage unavailable");
        return storage;
      },
    });
    const { getLocalStorageItem, LocalStorageOperationError } = await import("./useLocalStorage");

    expect(() => getLocalStorageItem("read-key", Schema.String)).toThrow(
      LocalStorageOperationError,
    );
    blocked = false;
    expect(getLocalStorageItem("read-key", Schema.String)).toBe("saved value");
  });
});

describe("storage events", () => {
  it("notifies a subscribed key when the whole storage area is cleared", async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: (event: unknown) => void) =>
        listeners.set(type, listener),
      removeEventListener: () => {},
    });
    const { subscribeLocalStorageKey } = await import("./useLocalStorage");
    const onChange = vi.fn();
    subscribeLocalStorageKey("houston:voice-audio-grant:v1", onChange);

    listeners.get("storage")?.({ key: "unrelated" });
    expect(onChange).not.toHaveBeenCalled();
    listeners.get("storage")?.({ key: null });
    expect(onChange).toHaveBeenCalledOnce();
  });
});
