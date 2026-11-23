import { type ConfirmDialogOptions, type ContextMenuItem } from "@houston-app/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const showContextMenuFallbackMock =
  vi.fn<
    <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>
  >();
const dismissContextMenuMock = vi.fn<() => void>();

const requestConfirmDialogMock =
  vi.fn<(message: string, options?: ConfirmDialogOptions) => Promise<boolean> | undefined>();

vi.mock("./contextMenuFallback", () => ({
  showContextMenuFallback: showContextMenuFallbackMock,
  dismissContextMenu: dismissContextMenuMock,
}));

vi.mock("./confirmDialog", () => ({
  requestConfirmDialog: requestConfirmDialogMock,
}));

function createLocalStorageStub(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

function testWindow(): Window & typeof globalThis {
  return globalThis.window ?? (globalThis as unknown as Window & typeof globalThis);
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  if (globalThis.window === undefined) {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: globalThis,
    });
  }
  Reflect.deleteProperty(testWindow(), "hostBridge");
  Object.defineProperty(testWindow(), "localStorage", {
    configurable: true,
    value: createLocalStorageStub(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LocalApi", () => {
  it("fails closed in a browser when no themed host is available", async () => {
    requestConfirmDialogMock.mockReturnValue(undefined);
    const { createLocalApi } = await import("./localApi");

    await expect(createLocalApi().dialogs.confirm("Delete this thread?")).resolves.toBe(false);
  });

  it("draws context menus in the page on the desktop host, so their icons and headers show", async () => {
    const hostShowContextMenu = vi.fn(async () => "rename");
    Object.defineProperty(testWindow(), "hostBridge", {
      configurable: true,
      value: { showContextMenu: hostShowContextMenu },
    });
    showContextMenuFallbackMock.mockResolvedValue("archive");
    const { createLocalApi } = await import("./localApi");
    const items: ContextMenuItem[] = [{ id: "archive", label: "Archive", icon: "archive" }];

    const api = createLocalApi();
    await expect(api.contextMenu.show(items, { x: 4, y: 8 })).resolves.toBe("archive");
    await api.contextMenu.close();

    expect(showContextMenuFallbackMock).toHaveBeenCalledWith(items, { x: 4, y: 8 });
    expect(hostShowContextMenu).not.toHaveBeenCalled();
    expect(dismissContextMenuMock).toHaveBeenCalledOnce();
  });
});
