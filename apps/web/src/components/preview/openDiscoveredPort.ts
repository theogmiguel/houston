import type { DiscoveredLocalServer, ScopedThreadRef } from "@houston-app/contracts";
import {
  mapAtomCommandResult,
  type AtomCommandResult,
} from "@houston-app/client-runtime/state/runtime";

import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { isDesktopHost } from "~/env";
import { resolveDiscoveredServerUrl } from "~/browser/browserTargetResolver";
import type { BrowserSettingsReadError, OpenPreviewMutation } from "~/browser/openFileInPreview";
import { recordVisitForThread } from "~/browserHistoryStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { openPreviewSession } from "./openPreviewSession";
import { previewRuntimeFor } from "~/browser/previewRuntime";
import { readPreparedConnection } from "~/state/session";
import { stackedThreadToast, toastManager } from "../ui/toast";

function needsForward(environmentId: ScopedThreadRef["environmentId"]): boolean {
  if (!isDesktopHost || window.hostBridge === undefined) return false;
  const target = readPreparedConnection(environmentId)?.target;
  if (target === undefined) return false;
  return (
    target._tag === "SshConnectionTarget" ||
    (target._tag === "BearerConnectionTarget" && !isDesktopLocalConnectionTarget(target))
  );
}

async function forwardLoopbackPort(
  environmentId: ScopedThreadRef["environmentId"],
  rawUrl: string,
): Promise<string> {
  const parsed = URL.parse(rawUrl);
  if (parsed === null || window.hostBridge === undefined) return rawUrl;
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isInteger(port) || port <= 0) return rawUrl;
  try {
    const forward = await window.hostBridge.startPortForward({ environmentId, remotePort: port });
    return `${parsed.protocol}//localhost:${forward.localPort}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch (error) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not forward port",
        description: error instanceof Error ? error.message : String(error),
      }),
    );
    return rawUrl;
  }
}

export async function openDiscoveredPort<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly port: DiscoveredLocalServer;
  readonly openPreview: OpenPreviewMutation<E>;
}): Promise<AtomCommandResult<void, E | BrowserSettingsReadError>> {
  const resolvedUrl =
    previewRuntimeFor(input.threadRef.environmentId) === "server"
      ? input.port.url
      : needsForward(input.threadRef.environmentId)
        ? await forwardLoopbackPort(input.threadRef.environmentId, input.port.url)
        : resolveDiscoveredServerUrl(input.threadRef.environmentId, input.port.url);
  const result = await openPreviewSession({
    openPreview: input.openPreview,
    threadRef: input.threadRef,
    url: resolvedUrl,
  });
  return mapAtomCommandResult(result, (snapshot) => {
    recordVisitForThread(input.threadRef, input.port.url);
    useRightPanelStore.getState().openBrowser(input.threadRef, snapshot.tabId);
  });
}
