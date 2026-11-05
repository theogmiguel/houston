import { describe, expect, it, vi } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@houston-app/contracts";
import {
  getProviderStatusBannerKey,
  getProviderStatusMessage,
  shouldShowProviderStatusBanner,
} from "./ProviderStatusBanner";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex-work"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-22T00:00:00Z",
  models: [],
  skills: [],
  slashCommands: [],
  compatibilityAdvisory: {
    status: "unsupported",
    message: "Unsupported version. Use 2.0.0.",
    recommendedVersion: "2.0.0",
    recommendedRange: null,
  },
};

describe("compatibility banners", () => {
  it("shows and dismisses a warning on a healthy provider, then clears it after policy relaxation", () => {
    expect(shouldShowProviderStatusBanner(provider, null)).toBe(true);
    expect(shouldShowProviderStatusBanner(provider, getProviderStatusBannerKey(provider))).toBe(
      false,
    );
    expect(
      shouldShowProviderStatusBanner(
        { ...provider, version: "1.0.1" },
        getProviderStatusBannerKey(provider),
      ),
    ).toBe(true);
    const relaxed: ServerProvider = {
      ...provider,
      compatibilityAdvisory: {
        ...provider.compatibilityAdvisory!,
        status: "supported",
        message: null,
      },
    };
    expect(getProviderStatusBannerKey(relaxed)).toBeNull();
    expect(getProviderStatusBannerKey({ ...provider, status: "disabled" })).toBeNull();
    expect(
      getProviderStatusBannerKey({
        ...provider,
        compatibilityAdvisory: { ...provider.compatibilityAdvisory!, status: "graceful" },
      }),
    ).toBeNull();
  });

  it("shows downgrade guidance instead of a broken OpenCode inventory timeout", () => {
    const message = "This provider version is known to be incompatible. Use 1.14.19.";
    const broken: ServerProvider = {
      ...provider,
      driver: ProviderDriverKind.make("opencode"),
      version: "2.0.3",
      status: "error",
      auth: { status: "unknown" },
      message: "Failed to load OpenCode provider inventory: Timed out waiting for server start.",
      compatibilityAdvisory: {
        status: "broken",
        message,
        recommendedVersion: "1.14.19",
        recommendedRange: ">=1.14.19 <2.0.0",
      },
    };
    expect(shouldShowProviderStatusBanner(broken, null)).toBe(true);
    const timeoutOnly: ServerProvider = {
      ...broken,
      compatibilityAdvisory: {
        ...broken.compatibilityAdvisory!,
        status: "supported",
        message: null,
      },
    };
    expect(shouldShowProviderStatusBanner(broken, getProviderStatusBannerKey(timeoutOnly))).toBe(
      true,
    );
    expect(shouldShowProviderStatusBanner(broken, getProviderStatusBannerKey(broken))).toBe(false);
    expect(
      shouldShowProviderStatusBanner(
        {
          ...broken,
          compatibilityAdvisory: { ...broken.compatibilityAdvisory!, message: "Use 1.14.20." },
        },
        getProviderStatusBannerKey(broken),
      ),
    ).toBe(true);
    expect(getProviderStatusMessage(broken, "locale")).toBe(message);
    expect(
      getProviderStatusMessage(
        {
          ...broken,
          compatibilityAdvisory: {
            ...broken.compatibilityAdvisory!,
            status: "supported",
            message: null,
          },
        },
        "locale",
      ),
    ).toBe(broken.message);
    expect(
      getProviderStatusMessage({ ...broken, auth: { status: "unauthenticated" } }, "locale"),
    ).toBe(broken.message);
  });
});

describe("provider readiness banners", () => {
  const { compatibilityAdvisory: _compatibility, ...providerWithoutCompatibility } = provider;
  it("shows a refused turn while the probe still reads ready", () => {
    const rejected: ServerProvider = {
      ...providerWithoutCompatibility,
      status: "ready",
      readiness: {
        state: "rejected",
        code: "subscription_sharing_user_not_eligible",
        message: "This account cannot share the subscription.",
        at: "2026-09-22T00:00:00Z",
      },
    };
    expect(shouldShowProviderStatusBanner(rejected, null)).toBe(true);
    expect(getProviderStatusMessage(rejected, "locale")).toContain("Reauthorize the account");
    expect(getProviderStatusMessage(rejected, "locale")).toContain(
      "subscription_sharing_user_not_eligible",
    );
    expect(shouldShowProviderStatusBanner(rejected, getProviderStatusBannerKey(rejected))).toBe(
      false,
    );
  });

  it("names the reset time when a provider is out of usage", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T12:00:00.000Z"));
    const resetsAt = "2026-09-22T14:00:00.000Z";
    const limited: ServerProvider = {
      ...providerWithoutCompatibility,
      status: "ready",
      readiness: {
        state: "outOfUsage",
        resetsAt,
        message: "The provider's usage limit was reached.",
        at: "2026-09-22T00:00:00Z",
      },
    };
    expect(getProviderStatusBannerKey(limited)).not.toBeNull();
    expect(getProviderStatusMessage(limited, "locale")).toContain("Resets in 2 h.");
    vi.useRealTimers();
  });

  it("leaves a ready provider with no readiness banner", () => {
    expect(
      getProviderStatusBannerKey({
        ...providerWithoutCompatibility,
        readiness: { state: "ready" },
      }),
    ).toBeNull();
  });
});
