import { type ProviderInstanceId, type ServerProvider } from "@houston-app/contracts";
import type { TimestampFormat } from "@houston-app/contracts/settings";
import { memo } from "react";
import { InfoIcon, XIcon } from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button, InlineButton } from "../ui/button";
import { useClientSettings } from "~/hooks/useSettings";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { getProviderReadinessAction, getProviderSummary } from "../settings/providerStatus";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function getIncompatibleVersion(status: ServerProvider) {
  const compatibility = status.compatibilityAdvisory;
  if (status.status === "error" && status.auth.status === "unauthenticated") return null;
  return compatibility?.status === "broken" ||
    (status.status === "ready" && compatibility?.status === "unsupported")
    ? compatibility
    : null;
}

export function getProviderStatusBannerKey(status: ServerProvider | null): string | null {
  if (!status || status.status === "disabled") return null;
  // A refused turn, a usage window or a probe mismatch is a provider state of its own; show
  // it even while the probe fields still read ready.
  const readiness = status.readiness;
  if (readiness !== undefined && readiness.state !== "ready") {
    const cause =
      readiness.state === "rejected"
        ? readiness.code
        : readiness.state === "outOfUsage"
          ? `${readiness.resetsAt ?? ""}`
          : readiness.state === "notInstalled"
            ? readiness.reason
            : "";
    return [status.instanceId, readiness.state, cause, readiness.message].join("\u0000");
  }
  const incompatible = getIncompatibleVersion(status);
  if (incompatible) {
    return [
      status.instanceId,
      incompatible.status,
      status.version ?? "",
      incompatible.message ?? "",
    ].join("\u0000");
  }
  if (status.status === "ready") return null;
  // Antigravity validates credentials at session start; unknown restart auth is not failure.
  if (
    status.driver === "antigravity" &&
    status.installed &&
    status.status === "warning" &&
    status.auth.status === "unknown"
  ) {
    return null;
  }
  return [status.instanceId, status.status, status.auth.status, status.message ?? ""].join(
    "\u0000",
  );
}

export function shouldShowProviderStatusBanner(
  status: ServerProvider | null,
  dismissedBannerKey: string | null,
): boolean {
  const bannerKey = getProviderStatusBannerKey(status);
  return bannerKey !== null && bannerKey !== dismissedBannerKey;
}

export function hasProviderSetup(status: ServerProvider): boolean {
  return (
    status.driver === "antigravity" ||
    status.setup?.canAuthenticate === true ||
    status.setup?.canInstall === true
  );
}

export function getProviderStatusMessage(
  status: ServerProvider,
  timestampFormat: TimestampFormat,
): string {
  const readiness = status.readiness;
  if (readiness !== undefined && readiness.state !== "ready") {
    const action = getProviderReadinessAction(readiness, timestampFormat);
    return [readiness.message, action].filter(Boolean).join(" ");
  }
  if (
    status.auth.status !== "unauthenticated" &&
    status.compatibilityAdvisory?.status === "broken" &&
    status.compatibilityAdvisory.message
  ) {
    return status.compatibilityAdvisory.message;
  }
  if (status.message) return status.message;
  const providerName = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  if (!status.installed && hasProviderSetup(status)) {
    return `Open provider setup to install ${formatProviderDriverKindLabel(status.driver)} on this environment.`;
  }
  if (status.auth.status === "unauthenticated") {
    if (hasProviderSetup(status)) {
      return status.driver === "antigravity"
        ? "Open provider setup to sign in with Google."
        : "Open provider setup to sign in.";
    }
    return "Sign in via the CLI to authenticate again.";
  }
  return status.status === "ready"
    ? "No models are available for this provider."
    : status.status === "error"
      ? `${providerName} provider is unavailable.`
      : `${providerName} provider has limited availability.`;
}

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  onDismiss,
  onOpenProviderSetup,
  status,
}: {
  onDismiss: () => void;
  onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  status: ServerProvider | null;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  if (!status || getProviderStatusBannerKey(status) === null) {
    return null;
  }

  const providerName = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  const readiness = status.readiness;
  const hasReadinessState = readiness !== undefined && readiness.state !== "ready";
  const isUnauthenticated = status.status === "error" && status.auth.status === "unauthenticated";
  const incompatible = getIncompatibleVersion(status);
  const title = hasReadinessState
    ? `${providerName}: ${getProviderSummary(status, timestampFormat).headline.toLowerCase()}`
    : isUnauthenticated
      ? `${providerName} is unauthenticated`
      : incompatible
        ? `${providerName} ${status.version ?? ""} is ${incompatible.status === "broken" ? "known to be broken" : "unsupported"}`
        : `${providerName} provider status`;
  const message = incompatible?.message ?? getProviderStatusMessage(status, timestampFormat);
  const isWarning = hasReadinessState
    ? readiness.state !== "rejected"
    : incompatible?.status !== "broken" && (status.status === "warning" || incompatible !== null);

  return (
    <div className="pointer-events-auto mx-auto w-fit max-w-[calc(100%-2rem)] pt-3">
      <Alert
        variant={isWarning ? "stateWarning" : "stateError"}
        role={incompatible && incompatible.status !== "broken" ? "status" : "alert"}
        controlAlignment="first-line"
      >
        <InfoIcon />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>
          <Tooltip>
            <TooltipTrigger render={<div className="line-clamp-3" />}>{message}</TooltipTrigger>
            <TooltipPopup side="top" className="whitespace-pre-wrap">
              {message}
            </TooltipPopup>
          </Tooltip>
          {onOpenProviderSetup && hasProviderSetup(status) ? (
            <InlineButton onClick={() => onOpenProviderSetup(status.instanceId)}>
              Open provider setup
            </InlineButton>
          ) : null}
        </AlertDescription>
        <AlertAction>
          <Button
            aria-label={`Dismiss ${providerName} provider ${status.status}`}
            onClick={onDismiss}
            size="icon-xs"
            variant="ghost-muted"
          >
            <XIcon />
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
});
