import { expect, it, vi } from "vite-plus/test";

// Each factory records that its package was evaluated, then hands back the real module.
const evaluated = vi.hoisted(() => new Set<string>());
vi.mock("electron-updater", async (importOriginal) => {
  evaluated.add("electron-updater");
  return importOriginal();
});

// The first import transforms most of the main-process module graph.
const COLD_IMPORT_TIMEOUT_MS = 60_000;

it(
  "loading the main-process modules evaluates no updater package",
  async () => {
    await import("./electron/ElectronUpdater.ts");
    await import("./updates/DesktopUpdates.ts");

    expect([...evaluated]).toEqual([]);
  },
  COLD_IMPORT_TIMEOUT_MS,
);
