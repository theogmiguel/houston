import { describe, expect, it } from "vite-plus/test";

import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
} from "./updateMachine.ts";

const runtimeInfo = {
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
} as const;

const notes = [{ version: "1.1.0", items: ["fix: queued update"], totalItems: 1 }];

const stateWith = (overrides: Partial<ReturnType<typeof createInitialDesktopUpdateState>>) => ({
  ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
  enabled: true,
  ...overrides,
});

describe("updateMachine check start", () => {
  it("keeps an offered update and its release notes while checking", () => {
    const state = stateWith({
      status: "available",
      availableVersion: "1.1.0",
      releaseNotes: notes,
      omittedReleaseCount: 2,
    });

    const checking = reduceDesktopUpdateStateOnCheckStart(state, "2026-03-04T00:00:00.000Z");

    expect(checking.status).toBe("available");
    expect(checking.availableVersion).toBe("1.1.0");
    expect(checking.downloadedVersion).toBeNull();
    expect(checking.releaseNotes).toEqual(notes);
    expect(checking.omittedReleaseCount).toBe(2);
    expect(checking.checkedAt).toBe("2026-03-04T00:00:00.000Z");
  });

  it("keeps a downloaded update while checking", () => {
    const state = stateWith({
      status: "downloaded",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
      releaseNotes: notes,
      downloadPercent: 100,
    });

    const checking = reduceDesktopUpdateStateOnCheckStart(state, "2026-03-04T00:00:00.000Z");

    expect(checking.status).toBe("downloaded");
    expect(checking.downloadedVersion).toBe("1.1.0");
    expect(checking.releaseNotes).toEqual(notes);
    expect(checking.downloadPercent).toBe(100);
  });

  it("shows checking from an idle, up-to-date or error state", () => {
    for (const status of ["idle", "up-to-date", "error"] as const) {
      const state = stateWith({ status, errorContext: status === "error" ? "check" : null });

      const checking = reduceDesktopUpdateStateOnCheckStart(state, "2026-03-04T00:00:00.000Z");

      expect(checking.status, status).toBe("checking");
      expect(checking.errorContext, status).toBeNull();
    }
  });

  it("still converges to downloaded when a check fails after an offer was downloaded", () => {
    const checking = reduceDesktopUpdateStateOnCheckStart(
      stateWith({
        status: "downloaded",
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
        releaseNotes: notes,
      }),
      "2026-03-04T00:00:00.000Z",
    );

    const failed = reduceDesktopUpdateStateOnCheckFailure(
      checking,
      "network unavailable",
      "2026-03-04T00:00:01.000Z",
    );

    expect(failed.status).toBe("downloaded");
    expect(failed.downloadedVersion).toBe("1.1.0");
    expect(failed.releaseNotes).toEqual(notes);
    expect(failed.message).toBeNull();
  });
});
