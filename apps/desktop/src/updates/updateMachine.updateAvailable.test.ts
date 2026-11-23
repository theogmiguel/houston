import { describe, expect, it } from "vite-plus/test";

import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./updateMachine.ts";

const runtimeInfo = {
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
} as const;

const stateWith = (overrides: Partial<ReturnType<typeof createInitialDesktopUpdateState>>) => ({
  ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
  enabled: true,
  ...overrides,
});

const notes = [{ version: "1.1.0", items: ["fix: queued update"], totalItems: 1 }];

describe("updateMachine update available", () => {
  it("keeps a downloaded build when a newer version is offered", () => {
    const state = stateWith({
      status: "downloaded",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
      releaseNotes: notes,
      downloadPercent: 100,
    });

    const offered = reduceDesktopUpdateStateOnUpdateAvailable(
      state,
      "1.2.0",
      "2026-03-04T00:00:00.000Z",
      [{ version: "1.2.0", items: ["feat: newer"], totalItems: 1 }],
    );

    expect(offered.status).toBe("downloaded");
    expect(offered.downloadedVersion).toBe("1.1.0");
    expect(offered.availableVersion).toBe("1.2.0");
    expect(offered.releaseNotes).toEqual(notes);
    expect(offered.downloadPercent).toBe(100);
    expect(offered.canRetry).toBe(true);
  });

  it("still updates release notes when the same downloaded version is offered again", () => {
    const state = stateWith({
      status: "downloaded",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
      releaseNotes: notes,
      downloadPercent: 100,
    });
    const newerNotes = [{ version: "1.1.0", items: ["fix: second"], totalItems: 1 }];

    const offered = reduceDesktopUpdateStateOnUpdateAvailable(
      state,
      "1.1.0",
      "2026-03-04T00:00:00.000Z",
      newerNotes,
    );

    expect(offered.status).toBe("downloaded");
    expect(offered.releaseNotes).toEqual(newerNotes);
  });

  it("offers a version for download when nothing is downloaded", () => {
    const offered = reduceDesktopUpdateStateOnUpdateAvailable(
      stateWith({ status: "checking" }),
      "1.2.0",
      "2026-03-04T00:00:00.000Z",
      notes,
    );

    expect(offered.status).toBe("available");
    expect(offered.availableVersion).toBe("1.2.0");
    expect(offered.downloadedVersion).toBeNull();
  });
});
