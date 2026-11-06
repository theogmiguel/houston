import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@houston-app/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  formatReadinessReset,
  getProviderSummary,
  getProviderVersionAdvisoryPresentation,
  getProviderStatusKey,
} from "./providerStatus";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated", label: "ChatGPT" },
  checkedAt: "2026-08-23T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

describe("getProviderSummary", () => {
  it("does not hide a provider error behind a previous authenticated state", () => {
    expect(
      getProviderSummary(
        {
          ...provider,
          status: "error",
          message: "The provider process failed to start.",
        },
        "locale",
      ),
    ).toEqual({
      headline: "Unavailable",
      detail: "The provider process failed to start.",
    });
  });

  it("keeps authentication failures actionable when their provider status is error", () => {
    expect(
      getProviderSummary(
        {
          ...provider,
          status: "error",
          auth: { status: "unauthenticated" },
          message: "Run codex login.",
        },
        "locale",
      ),
    ).toEqual({
      headline: "Not authenticated",
      detail: "Run codex login.",
    });
  });
});

describe("Antigravity with unchecked sign-in", () => {
  const unchecked: ServerProvider = {
    ...provider,
    instanceId: ProviderInstanceId.make("antigravity"),
    driver: ProviderDriverKind.make("antigravity"),
    status: "warning",
    auth: { status: "unknown" },
    message: "Antigravity is installed. Google account access is not checked yet.",
  };

  it("presents an unchecked Google sign-in neutrally without claiming authentication is required", () => {
    for (const auth of [unchecked.auth, { status: "unknown", type: "oauth-personal" }] as const) {
      const candidate = { ...unchecked, auth };
      expect.soft(getProviderSummary(candidate, "locale")).toEqual({
        headline: "Installed · Sign-in not checked",
        detail: unchecked.message,
      });
      expect(getProviderStatusKey(candidate)).toBe("neutral");
    }
  });

  // regression: #18623 neutral unchecked-sign-in display must not mask real warnings
  it("preserves actionable warnings, failures and disabled states outside unchecked Google sign-in", () => {
    const cases = [
      {
        name: "confirmed sign-out",
        change: { auth: { status: "unauthenticated" } },
        headline: "Not authenticated",
        status: "warning",
      },
      {
        name: "warning despite known authentication",
        change: { auth: { status: "authenticated" } },
        headline: "Needs attention",
        status: "warning",
      },
      {
        name: "probe failure",
        change: { status: "error" },
        headline: "Unavailable",
        status: "error",
      },
      {
        name: "missing CLI",
        change: { installed: false },
        headline: "Not found",
        status: "warning",
      },
      {
        name: "API key authentication",
        change: { auth: { status: "unknown", type: "gemini-api-key" } },
        headline: "Needs attention",
        status: "warning",
      },
      {
        name: "Agent Platform authentication",
        change: { auth: { status: "unknown", type: "agent-platform" } },
        headline: "Needs attention",
        status: "warning",
      },
      {
        name: "another provider",
        change: { driver: provider.driver },
        headline: "Needs attention",
        status: "warning",
      },
      {
        name: "disabled provider",
        change: { enabled: false },
        headline: "Disabled",
        status: "disabled",
      },
    ] as const;
    for (const { name, change, headline, status } of cases) {
      const candidate = { ...unchecked, ...change };
      expect.soft(getProviderSummary(candidate, "locale").headline, name).toBe(headline);
      expect.soft(getProviderStatusKey(candidate), name).toBe(status);
    }
  });
});

it("does not suggest copying a command that installs an incompatible latest version", () => {
  const advisory = {
    status: "behind_latest" as const,
    currentVersion: "1.0.0",
    latestVersion: "2.0.0",
    updateCommand: "npm install -g fixture@latest",
    canUpdate: true,
    checkedAt: provider.checkedAt,
    message: null,
  };
  const compatibility = {
    status: "supported" as const,
    latestVersionStatus: "broken" as const,
    message: null,
    recommendedRange: null,
    recommendedVersion: null,
  };
  expect(getProviderVersionAdvisoryPresentation(advisory, compatibility)).toBeNull();
  expect(
    getProviderVersionAdvisoryPresentation(advisory, { ...compatibility, status: "broken" }, false),
  ).toBeNull();
  expect(
    getProviderVersionAdvisoryPresentation(advisory, {
      ...compatibility,
      latestVersionStatus: "supported",
    }),
  ).not.toBeNull();
});

it("does not offer an update that cannot change a limited-support version", () => {
  // OpenCode 1.18.35 is the newest `opencode-ai`; the recommended 2.x ships as another package.
  const advisory = {
    status: "current" as const,
    currentVersion: "1.18.35",
    latestVersion: "1.18.35",
    updateCommand: "npm install -g opencode-ai@latest",
    canUpdate: true,
    checkedAt: provider.checkedAt,
    message: null,
  };
  const compatibility = {
    status: "graceful" as const,
    latestVersionStatus: "graceful" as const,
    message: null,
    recommendedRange: ">=2.0.18",
    recommendedVersion: null,
  };
  expect(getProviderVersionAdvisoryPresentation(advisory, compatibility)).toEqual({
    title: "Limited support",
    detail: "Use >=2.0.18 for full support.",
    updateCommand: null,
    emphasis: "normal",
    targetVersion: null,
  });
  expect(
    getProviderVersionAdvisoryPresentation(
      { ...advisory, status: "behind_latest", currentVersion: "1.18.34" },
      compatibility,
    )?.updateCommand,
  ).toBe(advisory.updateCommand);
});

it("shows compatibility in the version popover even when the installed version is current", () => {
  const advisory = {
    status: "current" as const,
    currentVersion: "2.0.0",
    latestVersion: "2.0.0",
    updateCommand: "npm install -g fixture@latest",
    canUpdate: true,
    checkedAt: provider.checkedAt,
    message: null,
  };
  const compatibility = {
    status: "broken" as const,
    latestVersionStatus: "broken" as const,
    message: "This version drops turns. Use 1.9.0.",
    recommendedRange: null,
    recommendedVersion: "1.9.0",
  };
  expect(getProviderVersionAdvisoryPresentation(advisory, compatibility)).toEqual({
    title: "Known broken version",
    detail: compatibility.message,
    updateCommand: null,
    emphasis: "strong",
    targetVersion: "1.9.0",
  });
  expect(
    getProviderVersionAdvisoryPresentation(undefined, {
      ...compatibility,
      status: "graceful",
      recommendedVersion: null,
      recommendedRange: ">=2.1.0",
      message: null,
    }),
  ).toEqual({
    title: "Limited support",
    detail: "Use >=2.1.0 for full support.",
    updateCommand: null,
    emphasis: "normal",
    targetVersion: null,
  });
});

describe("provider readiness", () => {
  const now = Date.parse("2026-09-22T12:00:00Z");

  it("reports a refused turn instead of the stale authenticated probe", () => {
    const rejected = {
      ...provider,
      readiness: {
        state: "rejected" as const,
        code: "api_error_403",
        message: "This account is not allowed to use the provider.",
        at: "2026-09-22T11:59:00Z",
      },
    };
    expect(getProviderSummary(rejected, "locale")).toEqual({
      headline: "Credentials rejected",
      detail:
        "This account is not allowed to use the provider. Reauthorize the account (api_error_403) or use another provider.",
      action: "Reauthorize the account (api_error_403) or use another provider.",
    });
    expect(getProviderStatusKey(rejected)).toBe("error");
  });

  it("names the usage window's reset time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T12:00:00.000Z"));
    const limited = {
      ...provider,
      readiness: {
        state: "outOfUsage" as const,
        resetsAt: "2026-09-22T15:30:00.000Z",
        message: "The provider's usage limit was reached.",
        at: "2026-09-22T11:00:00Z",
      },
    };
    const summary = getProviderSummary(limited, "locale");
    expect(summary.headline).toBe("Out of usage");
    expect(summary.detail).toContain("Resets in 3 h 30 min.");
    vi.useRealTimers();
    expect(getProviderStatusKey(limited)).toBe("warning");
  });

  it("distinguishes not installed, unusable and turned off", () => {
    const cases = [
      {
        readiness: {
          state: "notInstalled" as const,
          reason: "missing" as const,
          message: "Missing.",
        },
        headline: "Not installed",
        status: "warning",
      },
      {
        readiness: {
          state: "notInstalled" as const,
          reason: "unusable" as const,
          message: "Cannot start.",
        },
        headline: "Unavailable",
        status: "error",
      },
      {
        readiness: { state: "turnedOff" as const, message: "Off." },
        headline: "Turned off",
        status: "disabled",
      },
      {
        readiness: {
          state: "signedOut" as const,
          source: "turn" as const,
          message: "Sign in again.",
        },
        headline: "Signed out",
        status: "warning",
      },
    ] as const;
    for (const { readiness, headline, status } of cases) {
      const candidate = { ...provider, readiness };
      expect.soft(getProviderSummary(candidate, "locale").headline).toBe(headline);
      expect.soft(getProviderStatusKey(candidate)).toBe(status);
    }
  });

  it("falls back to probe fields when the server reports ready", () => {
    const ready = { ...provider, readiness: { state: "ready" as const } };
    expect(getProviderSummary(ready, "locale")).toEqual({
      headline: "Authenticated · ChatGPT",
      detail: null,
    });
    expect(getProviderStatusKey(ready)).toBe("ready");
  });

  it("formats a reset window that already passed", () => {
    expect(formatReadinessReset("2026-09-22T11:00:00Z", "locale", now)).toBe(
      "Usage is available again.",
    );
    expect(formatReadinessReset("not a date", "locale", now)).toBeNull();
  });

  it("writes a reset more than a day away in the chosen time format", () => {
    const resetsAt = "2026-09-25T14:00:00Z";
    const twelveHour = formatReadinessReset(resetsAt, "12-hour", now);
    const twentyFourHour = formatReadinessReset(resetsAt, "24-hour", now);
    expect(twelveHour).toMatch(/^Resets .*\b(AM|PM)\b.*\.$/i);
    expect(twentyFourHour).toMatch(/^Resets /);
    expect(twentyFourHour).not.toMatch(/\b(AM|PM)\b/i);
  });
});
