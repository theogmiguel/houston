import { DEFAULT_UNIFIED_SETTINGS } from "@houston-app/contracts";
import * as Duration from "effect/Duration";
import { describe, expect, it } from "vite-plus/test";
import {
  backgroundActivitySharedPolicySettings,
  getChangedBrowserSettingLabels,
  getChangedDisplaySettingLabels,
  gitFetchIntervalLabel,
  durationToSeconds,
  hasChangedBackgroundActivitySettings,
} from "./SettingsPanels.logic";
import { resolveServerBackgroundActivitySettings } from "@houston-app/shared/backgroundActivitySettings";

describe("background activity settings restore", () => {
  it("detects legacy interval values even when the structured setting is at its default", () => {
    expect(
      hasChangedBackgroundActivitySettings({
        backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
        backgroundActivityProfile: DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile,
        automaticGitFetchInterval: Duration.seconds(45),
        providerHealthRefreshInterval: DEFAULT_UNIFIED_SETTINGS.providerHealthRefreshInterval,
      }),
    ).toBe(true);
    expect(
      hasChangedBackgroundActivitySettings({
        backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
        backgroundActivityProfile: DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile,
        automaticGitFetchInterval: DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
        providerHealthRefreshInterval: Duration.minutes(7),
      }),
    ).toBe(true);
    expect(hasChangedBackgroundActivitySettings(DEFAULT_UNIFIED_SETTINGS)).toBe(false);
  });

  it("preserves advanced overrides when the shared policy changes", () => {
    const automaticGitFetchInterval = Duration.seconds(42);
    expect(
      backgroundActivitySharedPolicySettings(
        {
          ...DEFAULT_UNIFIED_SETTINGS,
          backgroundActivity: {
            schemaVersion: 1,
            profile: "custom",
            baseProfile: "balanced",
            overrides: {
              automaticGitFetchInterval,
              pauseWhenOnBattery: true,
            },
          },
        },
        "performance",
      ),
    ).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "performance",
      overrides: {
        automaticGitFetchInterval,
        pauseWhenOnBattery: true,
      },
    });
  });

  it("materializes legacy advanced overrides before changing the shared policy", () => {
    const automaticGitFetchInterval = Duration.seconds(42);
    expect(
      backgroundActivitySharedPolicySettings(
        {
          ...DEFAULT_UNIFIED_SETTINGS,
          automaticGitFetchInterval,
        },
        "battery-saver",
      ),
    ).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "battery-saver",
      overrides: {
        automaticGitFetchInterval,
      },
    });
  });
});

describe("getChangedBrowserSettingLabels", () => {
  it("counts a retained custom search URL so restore clears it", () => {
    expect(
      getChangedBrowserSettingLabels({
        ...DEFAULT_UNIFIED_SETTINGS,
        browserCustomSearchUrl: "https://search.example/?q=%s",
      }),
    ).toEqual(["Search engine"]);
  });
});

describe("display settings restore", () => {
  it("lists nothing at the defaults", () => {
    expect(getChangedDisplaySettingLabels(DEFAULT_UNIFIED_SETTINGS)).toEqual([]);
  });

  it("lists font smoothing and thread details once they differ from the defaults", () => {
    expect(
      getChangedDisplaySettingLabels({
        ...DEFAULT_UNIFIED_SETTINGS,
        fontSmoothing: !DEFAULT_UNIFIED_SETTINGS.fontSmoothing,
        threadDetailsItems: { servers: false },
      }),
    ).toEqual(["Font smoothing", "Thread details"]);
  });
});

describe("gitFetchIntervalLabel", () => {
  it.each([
    [0, "Off"],
    [15, "Every 15 seconds"],
    [45, "Every 45 seconds"],
    [60, "Every minute"],
    [300, "Every 5 minutes"],
    [900, "Every 15 minutes"],
    [3600, "Every hour"],
    [7200, "Every 2 hours"],
  ])("labels %i seconds as %s", (seconds, label) => {
    expect(gitFetchIntervalLabel(seconds)).toBe(label);
  });

  it.each([
    ["performance", "Every 15 seconds"],
    ["balanced", "Every 30 seconds"],
    ["battery-saver", "Off"],
  ] as const)("labels the interval the %s profile sets as %s", (profile, label) => {
    const resolved = resolveServerBackgroundActivitySettings({
      ...DEFAULT_UNIFIED_SETTINGS,
      backgroundActivity: { schemaVersion: 1, profile, overrides: {} },
    });
    expect(gitFetchIntervalLabel(durationToSeconds(resolved.automaticGitFetchInterval))).toBe(
      label,
    );
  });
});
