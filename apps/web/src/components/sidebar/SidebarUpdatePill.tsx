import { type DesktopUpdateState } from "@houston-app/contracts";
import { TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { isDesktopHost } from "../../env";
import { cn } from "../../lib/utils";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  canCheckForUpdate,
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateDownloadedVersion,
  getDesktopUpdateIdleTooltip,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
} from "../desktopUpdate.logic";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  downloadLocalUpdate,
  getCurrentDesktopUpdateState,
  installLocalUpdate,
  useDesktopUpdateActions,
} from "../useDesktopUpdateActions";
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
import { useUpdateEverything } from "./useUpdateEverything";
import { useReducedMotion } from "../../hooks/useReducedMotion";

function resolveSidebarUpdatePresentation({
  action,
  offersEverything,
  run,
  isDownloading,
  showCheckIcon,
}: {
  readonly action: ReturnType<typeof resolveDesktopUpdateButtonAction>;
  readonly offersEverything: boolean;
  readonly run: UpdateEverythingRun | null;
  readonly isDownloading: boolean;
  readonly showCheckIcon: boolean;
}) {
  const showUpdateDetails = action !== "none" || offersEverything || run !== null || isDownloading;
  const iconStatus: DesktopUpdateStatusIconState = showCheckIcon
    ? "checking"
    : isDownloading
      ? "downloading"
      : run !== null
        ? run.localVersion !== null && action === "install"
          ? "downloaded"
          : "everything"
        : action === "install"
          ? "downloaded"
          : action === "download"
            ? "available"
            : offersEverything
              ? "everything"
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

/**
 * The app's update state and actions. The footer's update button owns it, so a download, a run
 * and a confirmation survive the popover closing.
 */
const FIRST_LETTER = /^./;

export function useSidebarUpdate() {
  const actions = useDesktopUpdateActions();
  const { state, action, isPending: isActionPending } = actions;
  const updatesDenial = actions.updatesDenial;
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

  const isDownloading = state?.status === "downloading";
  const localUpdateVersion =
    state && action !== "none" ? getDesktopUpdateDownloadedVersion(state) : null;
  const everything = useUpdateEverything(localUpdateVersion);
  const offersEverything = everything.hasUpdates && !isDownloading;
  const run = useUpdateEverythingRun();
  const isRunningEverything = run !== null;
  // An available or downloaded app update keeps its own action while a check runs.
  const showCheckIcon =
    action === "none" &&
    shouldShowDesktopUpdateCheckIcon({
      isAnimationLatched: isCheckAnimationLatched,
      isChecking: state?.status === "checking",
      prefersReducedMotion,
    });
  const { iconStatus, showUpdateDetails } = resolveSidebarUpdatePresentation({
    action,
    offersEverything,
    run,
    isDownloading,
    showCheckIcon,
  });
  const idleTooltip =
    !showUpdateDetails && !showCheckIcon ? getDesktopUpdateIdleTooltip(state, updatesDenial) : null;
  const tooltip =
    action !== "none" && state
      ? getDesktopUpdateButtonTooltip(state)
      : offersEverything
        ? everything.summary
        : showCheckIcon
          ? "Checking for updates…"
          : (idleTooltip?.title ?? "Check for updates");
  const isInteractionDisabled =
    isRunningEverything ||
    isActionPending ||
    (action !== "none"
      ? isDesktopUpdateButtonDisabled(state)
      : offersEverything
        ? false
        : !canCheckForUpdate(state));

  const openUpdateEverything = () => setIsConfirmingEverything(true);

  const handleAction = async () => {
    if (isInteractionDisabled) return;
    if (action === "none" && offersEverything) {
      openUpdateEverything();
      return;
    }
    if (action === "none" && !prefersReducedMotion) {
      setIsCheckAnimationLatched(true);
      setCheckAnimationKey((key) => key + 1);
    }
    await actions.handleAction();
  };

  const runEverything = async () => {
    setIsConfirmingEverything(false);
    const bridge = window.hostBridge;
    // The action can change while the dialog is open; read it fresh when the run starts.
    const current = getCurrentDesktopUpdateState();
    const currentAction = current ? resolveDesktopUpdateButtonAction(current) : "none";
    const currentVersion =
      current && currentAction !== "none" ? getDesktopUpdateDownloadedVersion(current) : null;
    try {
      await everything.run({
        ...(bridge && currentAction === "download"
          ? {
              downloadLocal: (reportError) =>
                downloadLocalUpdate(bridge, { notifyDownloaded: false, reportError }),
            }
          : {}),
        ...(bridge && currentAction !== "none"
          ? { installLocal: (reportError) => installLocalUpdate(bridge, reportError) }
          : {}),
        localVersion: currentVersion,
      });
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not update everything",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      );
    }
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
  const pillLabel = pillCopy.label ?? (offersEverything ? everything.summary : null);
  const visible =
    (isDesktopHost || offersEverything || isRunningEverything) &&
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
    offersEverything,
    everythingSummary: offersEverything ? everything.summary : null,
    isInteractionDisabled,
    handleAction,
    openUpdateEverything,
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
  const offersNotesAction = hasNotes && action !== "none";
  const offersEverythingAction = model.offersEverything && action !== "none";
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
      {offersEverythingAction ? (
        <div className="flex justify-end">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={model.isInteractionDisabled}
                  onClick={model.openUpdateEverything}
                >
                  Update everything
                </Button>
              }
            />
            <TooltipPopup side="top">{model.everythingSummary ?? model.tooltip}</TooltipPopup>
          </Tooltip>
        </div>
      ) : null}
    </div>
  );
}
