import type {
  ServerProvider,
  ServerProviderVersionAdvisory,
  ServerProviderCompatibilityAdvisory,
} from "@houston-app/contracts";
import type { ProviderReadiness } from "@houston-app/contracts/houston/providerReadiness";
import type { TimestampFormat } from "@houston-app/contracts/settings";

import { formatUpcomingTimestamp } from "../../timestampFormat";

export const PROVIDER_STATUS_STYLES = {
  disabled: {
    dot: "bg-muted-foreground/50",
  },
  error: {
    dot: "bg-destructive",
  },
  neutral: {
    dot: "bg-muted-foreground",
  },
  ready: {
    dot: "bg-success",
  },
  // Amber marks only a thread that needs you. Signed out, offline and out of
  // usage read as secondary ink here.
  warning: {
    dot: "bg-muted-foreground",
  },
} as const;

export type ProviderStatusKey = keyof typeof PROVIDER_STATUS_STYLES;

// Antigravity's local health check verifies installation, not Google sign-in.
// API-key and Agent Platform warnings still need attention.
function isAntigravitySignInUnchecked(provider: ServerProvider): boolean {
  return (
    provider.driver === "antigravity" &&
    provider.installed &&
    provider.status === "warning" &&
    provider.auth.status === "unknown" &&
    (provider.auth.type === undefined ||
      provider.auth.type === "oauth-personal" ||
      provider.auth.type === "oauth-business")
  );
}

const RESET_WINDOW_MINUTE_MS = 60_000;
const RESET_WINDOW_HOUR_MS = 3_600_000;
const RESET_WINDOW_DAY_MS = 86_400_000;

/** How long until a usage window resets, in words a settings row can carry. */
export function formatReadinessReset(
  resetsAt: string,
  timestampFormat: TimestampFormat,
  nowMs: number = Date.now(),
): string | null {
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs)) return null;
  const remainingMs = resetMs - nowMs;
  if (remainingMs <= 0) return "Usage is available again.";
  if (remainingMs < RESET_WINDOW_HOUR_MS) {
    return `Resets in ${Math.max(1, Math.ceil(remainingMs / RESET_WINDOW_MINUTE_MS))} min.`;
  }
  if (remainingMs < RESET_WINDOW_DAY_MS) {
    const hours = Math.floor(remainingMs / RESET_WINDOW_HOUR_MS);
    const minutes = Math.floor((remainingMs % RESET_WINDOW_HOUR_MS) / RESET_WINDOW_MINUTE_MS);
    return minutes === 0 ? `Resets in ${hours} h.` : `Resets in ${hours} h ${minutes} min.`;
  }
  return `Resets ${formatUpcomingTimestamp(resetsAt, timestampFormat, nowMs)}.`;
}

function providerReadinessStateKey(readiness: ProviderReadiness): ProviderStatusKey {
  switch (readiness.state) {
    case "turnedOff":
      return "disabled";
    case "signedOut":
      return "warning";
    case "rejected":
      return "error";
    case "outOfUsage":
      return "warning";
    case "notInstalled":
      return readiness.reason === "missing" ? "warning" : "error";
    case "ready":
      return "ready";
  }
}

/** One action that resolves a provider readiness state, or null when nothing is left to do. */
export function getProviderReadinessAction(
  readiness: ProviderReadiness,
  timestampFormat: TimestampFormat,
): string | null {
  switch (readiness.state) {
    case "notInstalled":
      return readiness.reason === "missing"
        ? "Install it, then check again."
        : "Reinstall or fix the provider, then check again.";
    case "turnedOff":
      return "Turn it on in Settings.";
    case "signedOut":
      return "Sign in again.";
    case "rejected":
      return `Reauthorize the account (${readiness.code}) or use another provider.`;
    case "outOfUsage":
      return readiness.resetsAt === null
        ? "Add usage or use another provider."
        : (formatReadinessReset(readiness.resetsAt, timestampFormat) ??
            "Wait for the usage window to reset.");
    case "ready":
      return null;
  }
}

function getReadinessSummary(
  readiness: ProviderReadiness,
  timestampFormat: TimestampFormat,
): {
  readonly headline: string;
  readonly detail: string;
  readonly action: string | null;
} | null {
  if (readiness.state === "ready") return null;
  const action = getProviderReadinessAction(readiness, timestampFormat);
  const detail = action === null ? readiness.message : `${readiness.message} ${action}`;
  switch (readiness.state) {
    case "notInstalled":
      return {
        headline: readiness.reason === "missing" ? "Not installed" : "Unavailable",
        detail,
        action,
      };
    case "turnedOff":
      return { headline: "Turned off", detail, action };
    case "signedOut":
      return { headline: "Signed out", detail, action };
    case "rejected":
      return { headline: "Credentials rejected", detail, action };
    case "outOfUsage":
      return { headline: "Out of usage", detail, action };
    default:
      return null;
  }
}

export function getProviderStatusKey(provider: ServerProvider | undefined): ProviderStatusKey {
  if (provider && !provider.enabled) return "disabled";
  if (provider?.readiness) return providerReadinessStateKey(provider.readiness);
  if (provider && isAntigravitySignInUnchecked(provider)) return "neutral";
  return provider?.status ?? "warning";
}

export function getProviderSummary(
  provider: ServerProvider | undefined,
  timestampFormat: TimestampFormat,
) {
  if (!provider) {
    return {
      headline: "Checking provider status",
      detail: "Waiting for the server to report installation and authentication details.",
    };
  }
  // Readiness folds a refused turn and a usage window into the same one state the server
  // publishes; it wins over the probe fields those states would otherwise contradict.
  const readinessSummary = provider.readiness
    ? getReadinessSummary(provider.readiness, timestampFormat)
    : null;
  if (readinessSummary) return readinessSummary;
  if (!provider.enabled || provider.status === "disabled") {
    return {
      headline: "Disabled",
      detail:
        provider.message ?? "This provider is installed but disabled for new sessions in Houston.",
    };
  }
  if (!provider.installed) {
    return {
      headline: "Not found",
      detail: provider.message ?? "CLI not detected on PATH.",
    };
  }
  if (provider.auth.status === "unauthenticated") {
    const authLabel = provider.auth.label ?? provider.auth.type;
    return {
      headline: authLabel ? `Not authenticated · ${authLabel}` : "Not authenticated",
      detail: provider.message ?? null,
    };
  }
  if (isAntigravitySignInUnchecked(provider)) {
    return {
      headline: "Installed · Sign-in not checked",
      detail: provider.message ?? null,
    };
  }
  if (provider.status === "warning") {
    return {
      headline: "Needs attention",
      detail:
        provider.message ?? "The provider is installed, but the server could not fully verify it.",
    };
  }
  if (provider.status === "error") {
    return {
      headline: "Unavailable",
      detail: provider.message ?? "The provider failed its startup checks.",
    };
  }
  if (provider.auth.status === "authenticated") {
    const authLabel = provider.auth.label ?? provider.auth.type;
    return {
      headline: authLabel ? `Authenticated · ${authLabel}` : "Authenticated",
      detail: provider.message ?? null,
    };
  }
  return {
    headline: "Available",
    detail: provider.message ?? null,
  };
}

export function getProviderVersionLabel(version: string | null | undefined) {
  if (!version) return null;
  const antigravity = /^agy_acp_server_(\d{4})(\d{2})(\d{2})_\d+(?:_(\w+))?$/.exec(version);
  if (antigravity) {
    const [, year, month, day, candidate] = antigravity;
    return `${year}-${month}-${day}${candidate ? ` ${candidate}` : ""}`;
  }
  return /^\d/.test(version) ? `v${version}` : version;
}

const COMPATIBILITY_TITLES = {
  graceful: "Limited support",
  unsupported: "Unsupported version",
  broken: "Known broken version",
} as const;

export function getProviderVersionAdvisoryPresentation(
  advisory: ServerProviderVersionAdvisory | undefined,
  compatibility?: ServerProviderCompatibilityAdvisory | undefined,
  showCompatibility = true,
): {
  readonly title: string;
  readonly detail: string;
  readonly updateCommand: string | null;
  readonly emphasis: "normal" | "strong";
  readonly targetVersion: string | null;
} | null {
  const latestIsIncompatible =
    compatibility?.latestVersionStatus === "broken" ||
    compatibility?.latestVersionStatus === "unsupported";
  if (
    showCompatibility &&
    compatibility &&
    (compatibility.status === "graceful" ||
      compatibility.status === "unsupported" ||
      compatibility.status === "broken")
  ) {
    const targetVersion = compatibility.recommendedVersion;
    const recommendation = getProviderVersionLabel(targetVersion) ?? compatibility.recommendedRange;
    // Latest package versions cannot be updated into recommendations requiring another package.
    const isAlreadyLatest = advisory?.status === "current";
    return {
      title: COMPATIBILITY_TITLES[compatibility.status],
      detail:
        compatibility.message ??
        (recommendation ? `Use ${recommendation} for full support.` : "Update for full support."),
      updateCommand:
        targetVersion || latestIsIncompatible || isAlreadyLatest
          ? null
          : (advisory?.updateCommand ?? null),
      emphasis: compatibility.status === "graceful" ? "normal" : "strong",
      targetVersion,
    };
  }
  if (
    !advisory ||
    advisory.status === "current" ||
    advisory.status === "unknown" ||
    latestIsIncompatible
  ) {
    return null;
  }

  const label = "Update available";
  const version = advisory.latestVersion;
  const versionLabel = getProviderVersionLabel(version);

  return {
    title: label,
    detail:
      advisory.message ??
      (versionLabel
        ? `${label}: install ${versionLabel}.`
        : `${label}: install the latest provider version.`),
    updateCommand: advisory.updateCommand,
    emphasis: "normal" as const,
    targetVersion: null,
  };
}
