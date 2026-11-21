import type { DiscoveredLocalServer, ScopedThreadRef } from "@houston-app/contracts";
import { AsyncResult } from "effect/reactivity";
import {
  mapAtomCommandResult,
  type AtomCommandResult,
} from "@houston-app/client-runtime/state/runtime";

import { resolveDiscoveredServerUrl } from "~/browser/browserTargetResolver";
import type { BrowserSettingsReadError, OpenPreviewMutation } from "~/browser/openFileInPreview";
import { recordVisitForThread } from "~/browserHistoryStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { openPreviewSession } from "./openPreviewSession";
import { previewRuntimeFor } from "~/browser/previewRuntime";
import { forwardLoopbackUrl, needsLoopbackForward } from "~/browser/remotePortForwarding";

export async function openDiscoveredPort<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly port: DiscoveredLocalServer;
  readonly openPreview: OpenPreviewMutation<E>;
}): Promise<AtomCommandResult<void, E | BrowserSettingsReadError>> {
  const resolvedUrl =
    previewRuntimeFor(input.threadRef.environmentId) === "server"
      ? input.port.url
      : needsLoopbackForward(input.threadRef.environmentId)
        ? await forwardLoopbackUrl(input.threadRef.environmentId, input.port.url)
        : resolveDiscoveredServerUrl(input.threadRef.environmentId, input.port.url);
  // A refused forward was already reported; opening the address anyway would show this machine's own port.
  if (resolvedUrl === null) {
    return AsyncResult.success<void, E | BrowserSettingsReadError>(undefined);
  }
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
