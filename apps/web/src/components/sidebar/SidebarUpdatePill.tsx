import {
  type HostBridge,
  type DesktopUpdateState,
  managedUpdatesDenial,
} from "@houston-app/contracts";
import { TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { settlePromise, squashAtomCommandFailure } from "@houston-app/client-runtime/state/runtime";
import { isDesktopHost } from "../../env";
import { cn } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { usePrimaryManagedPolicy } from "../../state/managedPolicy";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  canCheckForUpdate,
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateDownloadedVersion,
  getDesktopUpdateIdleTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldToastDesktopUpdateActionResult,
} from "../desktopUpdate.logic";
import { showDesktopUpdateDownloadedToast } from "../desktopUpdate.toast";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import {
  DesktopUpdateStatusIcon,
  type DesktopUpdateStatusIconState,
  shouldContinueDesktopUpdateCheckAnimation,
  shouldShowDesktopUpdateCheckIcon,
} from "./DesktopUpdateStatusIcon";
import { SidebarUpdateReleaseNotes } from "./SidebarUpdateReleaseNotes";
import { SidebarUpdateCapsule } from "./SidebarUpdateCapsule";
import { UpdateEverythingDialog } from "./UpdateEverythingDialog";
import type { UpdateEverythingRun, UpdateRunLocalState } from "./updateEverything.logic";
import {
  clearSavedUpdateEverythingResult,
  saveUpdateEverythingResult,
  useUpdateEverythingRun,
} from "./updateEverythingRun";
import { type ReportLocalUpdateError, useUpdateEverything } from "./useUpdateEverything";
import { useReducedMotion } from "../../hooks/useReducedMotion";

function resolveSidebarUpdatePresentation({
  action,
  showsEverything,
  run,
  isDownloading,
  showCheckIcon,
}: {
  readonly action: ReturnType<typeof resolveDesktopUpdateButtonAction>;
  readonly showsEverything: boolean;
  readonly run: UpdateEverythingRun | null;
  readonly isDownloading: boolean;
  readonly showCheckIcon: boolean;
}) {
  const showUpdateDetails = action !== "none" || showsEverything || run !== null || isDownloading;
  const iconStatus: DesktopUpdateStatusIconState = showCheckIcon
    ? "checking"
    : isDownloading
      ? "downloading"
      : run !== null
        ? run.localVersion !== null && action === "install"
          ? "downloaded"
          : "everything"
        : showsEverything
          ? "everything"
          : action === "install"
            ? "downloaded"
            : action === "download"
              ? "available"
              : "idle";

  return {
    iconStatus,
    showUpdateDetails,
    showUpdateIconState: showUpdateDetails && !showCheckIcon,
  } as const;
}

function resolveSidebarUpdatePillCopy(
  state: DesktopUpdateState | null,
  action: ReturnType<typeof resolveDesktopUpdateButtonAction>,
): { label: string | null; meta: string | null; tone: "update" | "error" } {
  if (!state) return { label: null, meta: null, tone: "update" };
  if (state.status === "error" && state.errorContext !== null) {
    return {
      label:
        state.errorContext === "install"
          ? "Install failed"
          : state.errorContext === "download"
            ? "Couldn't download"
            : "Update failed",
      meta: null,
      tone: "error",
    };
  }
  if (action === "install") return { label: "Restart to update", meta: null, tone: "update" };
  if (state.status === "downloading") {
    return {
      label:
        typeof state.downloadPercent === "number"
          ? `Downloading ${Math.floor(state.downloadPercent)}%`
          : "Downloading update",
      meta: null,
      tone: "update",
    };
  }
  if (action === "download") {
    const version = getDesktopUpdateDownloadedVersion(state) ?? state.availableVersion;
    return {
      label: version ? `Update ${version}` : "Update available",
      meta: null,
      tone: "update",
    };
  }
  return { label: null, meta: null, tone: "update" };
}

export function SidebarUpdateArchitectureWarning() {
  return isDesktopHost ? <SidebarUpdateArchitectureWarningContent /> : null;
}

function SidebarUpdateArchitectureWarningContent() {
  const state = useDesktopUpdateState();
  const visible = shouldShowArm64IntelBuildWarning(state);
  const description = state && visible ? getArm64IntelBuildWarningDescription(state) : null;

  if (!visible || !description) return null;

  return (
    <Alert variant="warning">
      <TriangleAlertIcon />
      <AlertTitle>Intel build on Apple Silicon</AlertTitle>
      <AlertDescription>{description}</AlertDescription>
    </Alert>
  );
}

const toastUpdateError: ReportLocalUpdateError = (title, description) => {
  toastManager.add(stackedThreadToast({ type: "error", title, description }));
};

export async function downloadLocalUpdate(
  bridge: HostBridge,
  {
    notifyDownloaded,
    reportError = toastUpdateError,
  }: { readonly notifyDownloaded: boolean; readonly reportError?: ReportLocalUpdateError },
): Promise<boolean> {
  try {
    const result = await bridge.downloadUpdate();
    if (result.completed && notifyDownloaded) {
      showDesktopUpdateDownloadedToast(bridge, result.state);
    }
    const actionError = shouldToastDesktopUpdateActionResult(result)
      ? getDesktopUpdateActionError(result)
      : null;
    if (actionError) reportError("Could not download update", actionError);
    return result.completed;
  } catch (error) {
    reportError(
      "Could not start update download",
      error instanceof Error ? error.message : "An unexpected error occurred.",
    );
    return false;
  }
}

export async function installLocalUpdate(
  bridge: HostBridge,
  reportError: ReportLocalUpdateError = toastUpdateError,
  expectedVersion?: string,
): Promise<boolean> {
  try {
    const result = await bridge.installUpdate(expectedVersion);
    if (!result.accepted) {
      showDesktopUpdateDownloadedToast(bridge, result.state);
      return false;
    }
    const actionError = shouldToastDesktopUpdateActionResult(result)
      ? getDesktopUpdateActionError(result)
      : null;
    if (!actionError) return true;
    reportError("Could not install update", actionError);
    return false;
  } catch (error) {
    reportError(
      "Could not install update",
      error instanceof Error ? error.message : "An unexpected error occurred.",
    );
    return false;
  }
}

/**
 * The app's update state and actions. The footer's update button owns it, so a download, a run
 * and a confirmation survive the popover closing.
 */
const FIRST_LETTER = /^./;

export function useSidebarUpdate() {
  const state = useDesktopUpdateState();
  // The desktop updates this machine, whose policy the primary environment reports.
  const updatesDenial = managedUpdatesDenial(usePrimaryManagedPolicy());
  const [isActionPending, setIsActionPending] = useState(false);
  const [isConfirmingEverything, setIsConfirmingEverything] = useState(false);
  const [checkAnimationKey, setCheckAnimationKey] = useState(0);
  const prefersReducedMotion = useReducedMotion();

  const updateStatus = state?.status;
  const [isCheckAnimationLatched, setIsCheckAnimationLatched] = useState(
    () => !prefersReducedMotion && updateStatus === "checking",
  );
  const [latchInputs, setLatchInputs] = useState({ prefersReducedMotion, updateStatus });
  if (
    latchInputs.prefersReducedMotion !== prefersReducedMotion ||
    latchInputs.updateStatus !== updateStatus
  ) {
    setLatchInputs({ prefersReducedMotion, updateStatus });
    if (prefersReducedMotion) {
      setIsCheckAnimationLatched(false);
    } else if (updateStatus === "checking") {
      setIsCheckAnimationLatched(true);
    }
  }

  const action = state ? resolveDesktopUpdateButtonAction(state) : "none";
  const isDownloading = state?.status === "downloading";
  const localUpdateVersion =
    state && action !== "none" ? getDesktopUpdateDownloadedVersion(state) : null;
  const everything = useUpdateEverything(localUpdateVersion);
  const runsEverything = everything.hasUpdates && !isDownloading;
  const run = useUpdateEverythingRun();
  const isRunningEverything = run !== null;
  const showCheckIcon = shouldShowDesktopUpdateCheckIcon({
    isAnimationLatched: isCheckAnimationLatched,
    isChecking: state?.status === "checking",
    prefersReducedMotion,
  });
  const { iconStatus, showUpdateDetails } = resolveSidebarUpdatePresentation({
    action,
    showsEverything: runsEverything,
    run,
    isDownloading,
    showCheckIcon,
  });
  const idleTooltip =
    !showUpdateDetails && !showCheckIcon ? getDesktopUpdateIdleTooltip(state, updatesDenial) : null;
  const tooltip = runsEverything
    ? everything.summary
    : showUpdateDetails
      ? state
        ? getDesktopUpdateButtonTooltip(state)
        : "Update available"
      : showCheckIcon
        ? "Checking for updates…"
        : (idleTooltip?.title ?? "Check for updates");
  const disabled = showCheckIcon
    ? true
    : runsEverything
      ? false
      : showUpdateDetails
        ? isDesktopUpdateButtonDisabled(state)
        : !canCheckForUpdate(state);
  const isInteractionDisabled = disabled || isActionPending || isRunningEverything;
  const handleAction = async () => {
    const bridge = window.hostBridge;
    if (isInteractionDisabled) return;

    if (runsEverything) {
      setIsConfirmingEverything(true);
      return;
    }

    if (!bridge || !state) return;
    setIsActionPending(true);

    if (action === "download") {
      void downloadLocalUpdate(bridge, { notifyDownloaded: true }).finally(() =>
        setIsActionPending(false),
      );
      return;
    }

    if (action === "install") {
      let confirmed = false;
      try {
        confirmed = await ensureLocalApi().dialogs.confirm(
          getDesktopUpdateInstallConfirmationMessage(state),
        );
      } catch (error) {
        setIsActionPending(false);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not confirm update",
            description: error instanceof Error ? error.message : "Update confirmation failed.",
          }),
        );
        return;
      }
      if (!confirmed) {
        setIsActionPending(false);
        return;
      }
      void installLocalUpdate(bridge).finally(() => setIsActionPending(false));
      return;
    }

    if (!prefersReducedMotion) {
      setIsCheckAnimationLatched(true);
      setCheckAnimationKey((key) => key + 1);
    }
    void bridge
      .checkForUpdate()
      .then((result) => {
        if (result.checked) return;
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not check for updates",
            description:
              updatesDenial ??
              result.state.message ??
              "Automatic updates are not available in this build.",
          }),
        );
      })
      .catch((error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not check for updates",
            description: error instanceof Error ? error.message : "Update check failed.",
          }),
        );
      })
      .finally(() => setIsActionPending(false));
  };

  const runEverything = async () => {
    const bridge = window.hostBridge;
    setIsConfirmingEverything(false);
    setIsActionPending(true);
    const result = await settlePromise(() =>
      everything.run({
        ...(bridge && action === "download"
          ? {
              downloadLocal: (reportError) =>
                downloadLocalUpdate(bridge, { notifyDownloaded: false, reportError }),
            }
          : {}),
        ...(bridge && action !== "none"
          ? { installLocal: (reportError) => installLocalUpdate(bridge, reportError) }
          : {}),
      }),
    );
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not update everything",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      );
    }
    setIsActionPending(false);
  };

  const handleCheckAnimationIteration = () => {
    setIsCheckAnimationLatched(
      shouldContinueDesktopUpdateCheckAnimation({
        isChecking: state?.status === "checking",
        prefersReducedMotion,
      }),
    );
  };

  const pillCopy = resolveSidebarUpdatePillCopy(state, action);
  const pillLabel = pillCopy.label ?? (runsEverything ? everything.summary : null);
  const visible =
    (isDesktopHost || runsEverything || isRunningEverything) &&
    (run !== null || (showUpdateDetails && pillLabel !== null));

  const statusIcon = (
    <DesktopUpdateStatusIcon
      key={showCheckIcon ? checkAnimationKey : iconStatus}
      downloadPercent={state?.downloadPercent ?? null}
      isCheckAnimating={showCheckIcon && !prefersReducedMotion}
      onCheckAnimationIteration={handleCheckAnimationIteration}
      status={iconStatus}
    />
  );
  const confirmDialog = (
    <UpdateEverythingDialog
      open={isConfirmingEverything}
      onOpenChange={setIsConfirmingEverything}
      version={everything.version}
      providerCount={everything.providerCount}
      rows={everything.rows}
      restarts={everything.restarts}
      onConfirm={() => void runEverything()}
    />
  );

  const local: UpdateRunLocalState =
    run === null || run.localVersion === null
      ? null
      : state?.status === "downloading"
        ? { status: "downloading", percent: state.downloadPercent }
        : { status: "waiting" };
  const onRestart =
    run !== null && run.localVersion === null && action === "install" && window.hostBridge
      ? async () => {
          saveUpdateEverythingResult({
            localVersion: localUpdateVersion,
            updatedServers: 0,
            updatedProviders: 0,
            failures: [],
            restarting: [],
          });
          if (!(await installLocalUpdate(window.hostBridge!))) {
            clearSavedUpdateEverythingResult();
          }
        }
      : undefined;

  const failed = pillCopy.tone === "error";
  // What the update button says, in words, for its name and tooltip.
  const summary = !visible
    ? null
    : failed
      ? `Update failed: ${(pillCopy.label ?? "").replace(FIRST_LETTER, (letter) => letter.toLowerCase())}`
      : action === "install"
        ? "Update ready: restart to install"
        : tooltip;
  const tone: "failed" | "ready" | "downloading" | "available" = failed
    ? "failed"
    : action === "install"
      ? "ready"
      : isDownloading || run !== null
        ? "downloading"
        : "available";

  return {
    visible,
    tone,
    summary,
    state,
    action,
    run,
    local,
    onRestart,
    statusIcon,
    confirmDialog,
    pillLabel,
    pillTone: pillCopy.tone,
    tooltip,
    runsEverything,
    isInteractionDisabled,
    handleAction,
  };
}

export type SidebarUpdateModel = ReturnType<typeof useSidebarUpdate>;

/** The app's row in the updates popover: the run's capsule, or the release and its action. */
export function SidebarUpdateRow({
  model,
  onClose,
}: {
  readonly model: SidebarUpdateModel;
  /** Called when "Later" is chosen, so the popover can close. */
  readonly onClose?: () => void;
}) {
  const { state, run, action } = model;
  if (!model.visible) return null;
  if (run !== null) {
    return (
      <SidebarUpdateCapsule
        run={run}
        local={model.local}
        icon={model.statusIcon}
        {...(model.onRestart ? { onRestart: model.onRestart } : {})}
      />
    );
  }
  const hasNotes = state !== null && state.releaseNotes.length > 0;
  const offersNotesAction = hasNotes && action !== "none" && !model.runsEverything;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {hasNotes && state !== null ? (
        <SidebarUpdateReleaseNotes
          action={offersNotesAction ? action : "none"}
          onAction={() => void model.handleAction()}
          {...(onClose ? { onDismiss: onClose } : {})}
          shell={window.hostBridge}
          state={state}
          tooltip={model.tooltip}
        />
      ) : null}
      {offersNotesAction ? null : (
        <button
          type="button"
          aria-label={model.summary ?? model.tooltip}
          aria-disabled={model.isInteractionDisabled || undefined}
          className={cn(
            "flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-headline leading-4.5 font-medium outline-hidden ring-ring transition-colors focus-visible:ring-2 focus-visible:ring-inset",
            model.pillTone === "error"
              ? "bg-destructive/12 text-destructive"
              : "bg-sidebar-control-surface text-sidebar-foreground hover:bg-sidebar-row-hover",
            model.isInteractionDisabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
          )}
          onClick={() => void model.handleAction()}
        >
          {model.statusIcon}
          <span className="min-w-0 flex-1 truncate">{model.pillLabel}</span>
        </button>
      )}
    </div>
  );
}
