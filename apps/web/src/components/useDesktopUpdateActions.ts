import { useAtomValue } from "@effect/atom-react";
import {
  type DesktopUpdateState,
  type HostBridge,
  managedUpdatesDenial,
} from "@houston-app/contracts";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { Atom } from "effect/reactivity";

import { ensureLocalApi } from "../localApi";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { desktopUpdateStateAtom, useDesktopUpdateState } from "../state/desktopUpdate";
import { usePrimaryManagedPolicy } from "../state/managedPolicy";
import {
  canCheckForUpdate,
  getDesktopUpdateActionError,
  getDesktopUpdateActionRefusal,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  type ReportLocalUpdateError,
} from "./desktopUpdate.logic";
import {
  showDesktopUpdateDownloadedToast,
  watchDesktopUpdateInstallFailure,
} from "./desktopUpdate.toast";
import { stackedThreadToast, toastManager } from "./ui/toast";

const desktopUpdateActionPendingAtom = Atom.make(false).pipe(
  Atom.keepAlive,
  Atom.withLabel("desktop-update-action-pending"),
);

let actionInFlight = false;

function setActionPending(pending: boolean): void {
  appAtomRegistry.set(desktopUpdateActionPendingAtom, pending);
}

export function getCurrentDesktopUpdateState(): DesktopUpdateState | null {
  return AsyncResult.getOrElse(appAtomRegistry.get(desktopUpdateStateAtom), () => null);
}

const toastUpdateError: ReportLocalUpdateError = (title, description) => {
  toastManager.add(stackedThreadToast({ type: "error", title, description }));
};

/** Runs one update action at a time across every surface and keeps its pending state shared. */
async function runUpdateAction<T>(action: () => Promise<T>): Promise<T | undefined> {
  if (actionInFlight) return undefined;
  actionInFlight = true;
  setActionPending(true);
  try {
    return await action();
  } finally {
    actionInFlight = false;
    setActionPending(false);
  }
}

export async function downloadLocalUpdate(
  bridge: HostBridge,
  {
    notifyDownloaded,
    reportError = toastUpdateError,
  }: { readonly notifyDownloaded: boolean; readonly reportError?: ReportLocalUpdateError },
): Promise<boolean> {
  try {
    const result = await bridge.downloadUpdate();
    if (!result.accepted) {
      reportError("Update not started", getDesktopUpdateActionRefusal(result.state, "download"));
      return false;
    }
    if (result.completed && notifyDownloaded) {
      showDesktopUpdateDownloadedToast(bridge, result.state);
    }
    const actionError = getDesktopUpdateActionError(result, "download");
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
  const current = getCurrentDesktopUpdateState();
  const baselineMessage = current?.message ?? null;
  // Name the downloaded build so a host keeps it while a newer check runs.
  const targetVersion = expectedVersion ?? current?.downloadedVersion ?? undefined;
  try {
    const result = await bridge.installUpdate(targetVersion);
    if (!result.accepted) {
      reportError("Update not started", getDesktopUpdateActionRefusal(result.state, "install"));
      return false;
    }
    // A failed quit or relaunch can arrive after this call; watch the state for it.
    watchDesktopUpdateInstallFailure(baselineMessage);
    return true;
  } catch (error) {
    reportError(
      "Could not install update",
      error instanceof Error ? error.message : "An unexpected error occurred.",
    );
    return false;
  }
}

export function useDesktopUpdateActions() {
  const state = useDesktopUpdateState();
  const updatesDenial = managedUpdatesDenial(usePrimaryManagedPolicy());
  const isPending = useAtomValue(desktopUpdateActionPendingAtom);
  const action = state ? resolveDesktopUpdateButtonAction(state) : "none";
  const bridge = typeof window === "undefined" ? undefined : window.hostBridge;

  const download = async (): Promise<boolean> => {
    if (!bridge) return false;
    return (
      (await runUpdateAction(() => downloadLocalUpdate(bridge, { notifyDownloaded: true }))) ??
      false
    );
  };

  const install = async (): Promise<boolean> => {
    if (!bridge) return false;
    const confirmedInstall = await runUpdateAction(async () => {
      let confirmed = false;
      try {
        confirmed = await ensureLocalApi().dialogs.confirm(
          getDesktopUpdateInstallConfirmationMessage(
            state ?? { availableVersion: null, downloadedVersion: null },
          ),
        );
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not confirm update",
            description: error instanceof Error ? error.message : "Update confirmation failed.",
          }),
        );
        return false;
      }
      if (!confirmed) return false;
      return installLocalUpdate(bridge);
    });
    return confirmedInstall ?? false;
  };

  const check = async (): Promise<void> => {
    if (!bridge || typeof bridge.checkForUpdate !== "function") return;
    await runUpdateAction(async () => {
      try {
        const result = await bridge.checkForUpdate();
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
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not check for updates",
            description: error instanceof Error ? error.message : "Update check failed.",
          }),
        );
      }
    });
  };

  const handleAction = async (): Promise<void> => {
    if (isPending) return;
    if (action === "install") {
      await install();
      return;
    }
    if (action === "download") {
      await download();
      return;
    }
    await check();
  };

  const disabled =
    action === "none" ? !canCheckForUpdate(state) : isDesktopUpdateButtonDisabled(state);

  return {
    state,
    action,
    updatesDenial,
    isPending,
    disabled,
    hasHostBridge: bridge !== undefined,
    handleAction,
    download,
    install,
    check,
  } as const;
}
