import { describe, expect, it } from "vite-plus/test";
import type { DesktopUpdateState } from "@houston-app/contracts";

import {
  canCheckForUpdate,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateReleaseHistoryUrl,
  getDesktopUpdateReleaseUrl,
  getDesktopUpdateRowActionLabel,
  resolveDesktopUpdateButtonAction,
} from "./desktopUpdate.logic";

const baseState: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "1.0.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

describe("desktop update button state", () => {
  it("keeps retry action available after a download error", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      availableVersion: "1.1.0",
      message: "network timeout",
      errorContext: "download",
      canRetry: true,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("Click to retry");
  });

  it("prefers a newly available release over a stale downloaded version", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.2.0",
      downloadedVersion: "1.1.0",
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
  });

  it("keeps the install action while a check runs over a downloaded build", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "checking",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
      downloadPercent: 100,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("install");
  });

  it("keeps the download action while a check runs on an available update", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "checking",
      availableVersion: "1.1.0",
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
  });

  it("installs the downloaded build and names the newer version when one appears", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "downloaded",
      availableVersion: "1.2.0",
      downloadedVersion: "1.1.0",
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("install");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("1.1.0");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("1.2.0");
  });
});

describe("refused desktop update actions", () => {
  it("explains why a download did not start instead of reporting success", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "checking",
      availableVersion: "1.1.0",
    };
    expect(
      getDesktopUpdateActionError({ accepted: false, completed: false, state }, "download"),
    ).toContain("check for updates is still running");
  });

  it("names a missing downloaded build when an install is refused", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.1.0",
    };
    expect(
      getDesktopUpdateActionError({ accepted: false, completed: false, state }, "install"),
    ).toContain("no downloaded build");
  });

  it("uses the host's own message when it refuses an action", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "downloaded",
      downloadedVersion: "1.1.0",
      message: "Houston is quitting.",
      errorContext: "install",
    };
    expect(
      getDesktopUpdateActionError({ accepted: false, completed: false, state }, "install"),
    ).toBe("Houston is quitting.");
  });
});

describe("desktop update UI helpers", () => {
  it.each(["owner/repo/extra", "owner#notes/repo", "owner/repo?tab=notes"])(
    "falls back to the Houston repository for an invalid configured repository: %s",
    (repository) => {
      expect(getDesktopUpdateReleaseHistoryUrl(repository)).toBe(
        "https://github.com/theogmiguel/houston/releases",
      );
      expect(getDesktopUpdateReleaseUrl("1.2.3", repository)).toBe(
        "https://github.com/theogmiguel/houston/releases/tag/v1.2.3",
      );
    },
  );
});

describe("getDesktopUpdateRowActionLabel", () => {
  it("names the row's download action with its version, not the footer's status summary", () => {
    expect(
      getDesktopUpdateRowActionLabel(
        { ...baseState, status: "available", availableVersion: "1.1.0" },
        "download",
      ),
    ).toBe("Download update 1.1.0");
  });

  it("names the row's install action so it differs from the footer's restart summary", () => {
    expect(
      getDesktopUpdateRowActionLabel(
        { ...baseState, status: "downloaded", downloadedVersion: "1.1.0" },
        "install",
      ),
    ).toBe("Restart to update");
  });

  it("returns no action name while the row only reports status", () => {
    expect(getDesktopUpdateRowActionLabel(baseState, "none")).toBeNull();
  });
});

describe("canCheckForUpdate", () => {
  it("returns true once an update has been downloaded so newer releases can be found", () => {
    expect(
      canCheckForUpdate({
        ...baseState,
        status: "downloaded",
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
      }),
    ).toBe(true);
  });
});
