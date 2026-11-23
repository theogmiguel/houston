import type { DesktopUpdateActionResult, DesktopUpdateState } from "@houston-app/contracts";

export type DesktopUpdateButtonAction = "download" | "install" | "none";

export type DesktopUpdateAction = "download" | "install";

export type ReportLocalUpdateError = (title: string, description: string) => void;

const DEFAULT_DESKTOP_RELEASE_REPOSITORY = "theogmiguel/houston";
const GITHUB_REPOSITORY_SEGMENT = /^[A-Za-z0-9._-]+$/u;

function isValidRepositorySegment(value: string | undefined): value is string {
  return (
    value !== undefined && value !== "." && value !== ".." && GITHUB_REPOSITORY_SEGMENT.test(value)
  );
}

function desktopReleaseRepositoryUrl(repository: string | undefined): string {
  const configuredRepository = repository?.trim() ?? "";
  const [owner, name, ...extra] = configuredRepository.split("/");
  const releaseRepository =
    isValidRepositorySegment(owner) && isValidRepositorySegment(name) && extra.length === 0
      ? configuredRepository
      : DEFAULT_DESKTOP_RELEASE_REPOSITORY;
  return `https://github.com/${releaseRepository}/releases`;
}

/** The download RPC can beat the updater's downloadedVersion event; fall back to the requested version. */
export function getDesktopUpdateDownloadedVersion(state: DesktopUpdateState): string | null {
  return state.downloadedVersion ?? state.availableVersion;
}

export function getDesktopUpdateReleaseUrl(
  version: string | null,
  repository: string | undefined = import.meta.env.HOUSTON_DESKTOP_UPDATE_REPOSITORY,
): string | null {
  const normalizedVersion = version?.trim();
  if (!normalizedVersion) return null;
  return `${desktopReleaseRepositoryUrl(repository)}/tag/v${encodeURIComponent(normalizedVersion)}`;
}

export function getDesktopUpdateReleaseHistoryUrl(
  repository: string | undefined = import.meta.env.HOUSTON_DESKTOP_UPDATE_REPOSITORY,
): string {
  return desktopReleaseRepositoryUrl(repository);
}

export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState,
): DesktopUpdateButtonAction {
  if (
    state.downloadedVersion &&
    (state.status === "downloaded" ||
      state.status === "checking" ||
      (state.status === "error" &&
        (state.errorContext === null || state.errorContext === "install")))
  ) {
    return "install";
  }
  if (state.status === "available" || state.status === "checking") {
    return state.availableVersion ? "download" : "none";
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return "download";
    }
  }
  return "none";
}

export function shouldShowArm64IntelBuildWarning(state: DesktopUpdateState | null): boolean {
  return state?.hostArch === "arm64" && state.appArch === "x64";
}

export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return state?.status === "downloading";
}

export function getArm64IntelBuildWarningDescription(state: DesktopUpdateState): string {
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return "This install is using the correct architecture.";
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    return "This Mac has Apple Silicon, but Houston is still running the Intel build under Rosetta. Download the available update to switch to the native Apple Silicon build.";
  }
  if (action === "install") {
    return "This Mac has Apple Silicon, but Houston is still running the Intel build under Rosetta. Restart to install the downloaded Apple Silicon build.";
  }
  return "This Mac has Apple Silicon, but Houston is still running the Intel build under Rosetta. The next app update will replace it with the native Apple Silicon build.";
}

function downloadedUpdateTooltip(state: DesktopUpdateState): string {
  const downloadedVersion = state.downloadedVersion ?? state.availableVersion ?? "ready";
  if (state.availableVersion !== null && state.availableVersion !== state.downloadedVersion) {
    return `Update ${downloadedVersion} downloaded. ${state.availableVersion} is newer; restarting installs ${downloadedVersion}.`;
  }
  return `Update ${downloadedVersion} downloaded. Click to restart and install.`;
}

export function getDesktopUpdateButtonTooltip(state: DesktopUpdateState): string {
  if (
    state.notAppliedVersion !== undefined &&
    (state.status === "available" || state.status === "downloaded") &&
    getDesktopUpdateDownloadedVersion(state) === state.notAppliedVersion
  ) {
    return `Update ${state.notAppliedVersion} did not apply. Click to retry.`;
  }
  if (state.status === "available") {
    return `Update ${state.availableVersion ?? "available"} ready to download`;
  }
  if (state.status === "checking") {
    if (state.downloadedVersion !== null) return downloadedUpdateTooltip(state);
    return state.availableVersion !== null
      ? `Update ${state.availableVersion} ready to download`
      : "Checking for updates…";
  }
  if (state.status === "downloading") {
    const progress =
      typeof state.downloadPercent === "number" ? ` (${Math.floor(state.downloadPercent)}%)` : "";
    return `Downloading update${progress}`;
  }
  if (state.status === "downloaded") {
    return downloadedUpdateTooltip(state);
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return `Download failed for ${state.availableVersion}. Click to retry.`;
    }
    if (state.errorContext === "install" && state.downloadedVersion) {
      return `Install failed for ${state.downloadedVersion}. Click to retry.`;
    }
    if (state.downloadedVersion) {
      return `Update ${state.downloadedVersion} downloaded. Click to restart and install.`;
    }
    return state.message ?? "Update failed";
  }
  return "Up to date";
}

export function getDesktopUpdateInstallConfirmationMessage(
  state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">,
): string {
  const version = state.downloadedVersion ?? state.availableVersion;
  return `Install update${version ? ` ${version}` : ""} and restart Houston?\n\nAny running tasks will be interrupted. Make sure you're ready before continuing.`;
}

/** Why the host refused to start an action, in words the user can act on. */
export function getDesktopUpdateActionRefusal(
  state: DesktopUpdateState,
  action: DesktopUpdateAction,
): string {
  const message = typeof state.message === "string" ? state.message.trim() : "";
  if (message.length > 0) return message;
  if (state.status === "checking") {
    return "A check for updates is still running. Try again when it finishes.";
  }
  if (state.status === "downloading") {
    return "A download is already running.";
  }
  if (action === "install") {
    if (state.downloadedVersion === null) {
      return "There is no downloaded build to install yet.";
    }
    return "Houston could not start the install.";
  }
  if (state.status === "downloaded") {
    return `Update ${state.downloadedVersion ?? ""} is already downloaded; restart to install it.`.trim();
  }
  return "Houston could not start the download.";
}

function inferRefusedAction(state: DesktopUpdateState): DesktopUpdateAction {
  return state.downloadedVersion !== null && state.status !== "available" ? "install" : "download";
}

export function getDesktopUpdateActionError(
  result: DesktopUpdateActionResult,
  action?: DesktopUpdateAction,
): string | null {
  if (!result.accepted) {
    return getDesktopUpdateActionRefusal(result.state, action ?? inferRefusedAction(result.state));
  }
  if (result.completed) return null;
  const message = typeof result.state.message === "string" ? result.state.message.trim() : "";
  return message.length > 0 ? message : "The update did not finish.";
}

export function canCheckForUpdate(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) return false;
  return (
    state.status !== "checking" && state.status !== "downloading" && state.status !== "disabled"
  );
}

/** `managedDenial` is this machine's policy refusing updates (`managedUpdatesDenial`); it wins. */
export function getDesktopUpdateDisabledReason(
  state: Pick<DesktopUpdateState, "enabled" | "status" | "message"> | null,
  managedDenial?: string,
): string | null {
  if (managedDenial !== undefined) return managedDenial;
  if (!state || (state.enabled && state.status !== "disabled")) return null;
  return state.message?.trim() || "Automatic updates are not available in this build.";
}

export function getDesktopUpdateIdleTooltip(
  state: Pick<DesktopUpdateState, "enabled" | "status" | "message"> | null,
  managedDenial?: string,
) {
  const disabledReason = getDesktopUpdateDisabledReason(state, managedDenial);
  return disabledReason
    ? { title: "Updates unavailable", detail: disabledReason }
    : { title: "Check for updates", detail: null };
}
