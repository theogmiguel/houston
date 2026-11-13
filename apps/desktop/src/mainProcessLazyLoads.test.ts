import { expect, it, vi } from "vite-plus/test";

// Each factory records that its package was evaluated, then hands back the real module.
const evaluated = vi.hoisted(() => new Set<string>());
vi.mock("electron-updater", async (importOriginal) => {
  evaluated.add("electron-updater");
  return importOriginal();
});
vi.mock("dbus-next", async (importOriginal) => {
  evaluated.add("dbus-next");
  return importOriginal();
});
vi.mock("tldts", async (importOriginal) => {
  evaluated.add("tldts");
  return importOriginal();
});

// The first import transforms most of the main-process module graph.
const COLD_IMPORT_TIMEOUT_MS = 60_000;

it(
  "loading the main-process modules evaluates no updater, D-Bus or public-suffix package",
  async () => {
    await import("./electron/ElectronUpdater.ts");
    await import("./electron/ElectronTheme.ts");
    await import("./tray/TrayHost.ts");
    await import("./preview/Passkeys.ts");
    await import("./updates/DesktopUpdates.ts");

    expect([...evaluated]).toEqual([]);
  },
  COLD_IMPORT_TIMEOUT_MS,
);
