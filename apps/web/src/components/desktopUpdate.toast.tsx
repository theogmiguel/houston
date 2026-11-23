import type { HostBridge, DesktopUpdateState } from "@houston-app/contracts";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { ArrowRightIcon } from "lucide-react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { desktopUpdateStateAtom } from "~/state/desktopUpdate";
import {
  getDesktopUpdateDownloadedVersion,
  getDesktopUpdateReleaseUrl,
} from "./desktopUpdate.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";

type DesktopUpdateShell = Pick<HostBridge, "openExternal">;

export async function openDesktopUpdateReleaseNotes(
  shell: DesktopUpdateShell | undefined,
  releaseUrl: string,
): Promise<void> {
  try {
    if (shell && (await shell.openExternal(releaseUrl))) return;
  } catch {}
  toastManager.add({ type: "error", title: "Unable to open release notes" });
}

function ReleaseNotesLink({
  shell,
  releaseUrl,
}: {
  shell: DesktopUpdateShell;
  releaseUrl: string;
}) {
  return (
    <button
      className="ml-2 inline cursor-pointer text-muted-foreground underline decoration-dotted underline-offset-4 transition-colors hover:text-foreground"
      onClick={() => {
        void openDesktopUpdateReleaseNotes(shell, releaseUrl);
      }}
      type="button"
    >
      Read more
      <ArrowRightIcon
        aria-hidden
        className="ml-1 inline size-3 -rotate-45 align-[-0.125em]"
        strokeWidth={2.25}
      />
    </button>
  );
}

export function showDesktopUpdateDownloadedToast(
  shell: DesktopUpdateShell,
  state: DesktopUpdateState,
): void {
  const releaseUrl = getDesktopUpdateReleaseUrl(getDesktopUpdateDownloadedVersion(state));
  toastManager.add({
    type: "success",
    title: "Update downloaded",
    description: (
      <>
        Restart the app from the update button to install it.
        {releaseUrl ? <ReleaseNotesLink releaseUrl={releaseUrl} shell={shell} /> : null}
      </>
    ),
  });
}

/** A failed quit or relaunch reports after the install call has already returned accepted. */
const DESKTOP_UPDATE_INSTALL_FAILURE_WATCH_MS = 30_000;

export function watchDesktopUpdateInstallFailure(baselineMessage: string | null): () => void {
  if (typeof window === "undefined") return () => {};
  let stopped = false;
  let unsubscribe = () => {};
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    queueMicrotask(() => unsubscribe());
  };
  unsubscribe = appAtomRegistry.subscribe(
    desktopUpdateStateAtom,
    (result) => {
      const state = AsyncResult.getOrElse(result, () => null);
      if (!state || state.errorContext !== "install") return;
      const message = typeof state.message === "string" ? state.message.trim() : "";
      if (message.length === 0 || message === baselineMessage) return;
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not install update",
          description: message,
        }),
      );
      stop();
    },
    { immediate: false },
  );
  const timer = setTimeout(stop, DESKTOP_UPDATE_INSTALL_FAILURE_WATCH_MS);
  return stop;
}
