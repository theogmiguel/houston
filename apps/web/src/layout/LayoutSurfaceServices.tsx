import {
  AuthOrchestrationOperateScope,
  AuthPreviewOperateScope,
  AuthTerminalOperateScope,
} from "@houston-app/contracts";
import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { isAtomCommandInterrupted } from "@houston-app/client-runtime/state/runtime";
import { useEffect } from "react";

import { closePreviewSession } from "../components/preview/closePreviewSession";
import { readThreadPreviewState } from "../previewStateStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShell } from "../state/entities";
import { previewEnvironment } from "../state/preview";
import { readEnvironmentScope } from "../state/session";
import { environmentShell } from "../state/shell";
import { terminalEnvironment } from "../state/terminal";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { registerLayoutSurfaceCloser } from "./layoutActions";
import { closeThreadSurface, registerSurfaceResourceServices } from "./closeThreadSurface";

/**
 * Mounted once with the layout host: closing a surface tab ends what the surface ran (terminal
 * sessions, a browser session) and deletes a side chat that never ran, through this client's
 * connections.
 */
export function LayoutSurfaceServices() {
  const closePreview = useAtomCommand(previewEnvironment.close, "preview close");
  const deleteThread = useAtomCommand(threadEnvironment.delete, "side chat delete");
  const closeTerminal = useAtomCommand(terminalEnvironment.close, "terminal close");
  const writeTerminal = useAtomCommand(terminalEnvironment.write, "terminal write");

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- registers the mounted commands with the surface close registry the layout actions call
  useEffect(() => {
    const removeServices = registerSurfaceResourceServices({
      closeTerminalSession: (threadRef, terminalId) => {
        if (!readEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope)) return;
        const { environmentId, threadId } = threadRef;
        void (async () => {
          const result = await closeTerminal({
            environmentId,
            input: { threadId, terminalId, deleteHistory: true },
          });
          // A failed close falls back to ending the shell from inside.
          if (
            result._tag === "Failure" &&
            !isAtomCommandInterrupted(result) &&
            readEnvironmentScope(environmentId, AuthTerminalOperateScope)
          ) {
            await writeTerminal({ environmentId, input: { threadId, terminalId, data: "exit\n" } });
          }
        })();
      },
      releaseSurface: (threadRef, surface) => {
        if (
          surface.kind === "preview" &&
          surface.resourceId &&
          readEnvironmentScope(threadRef.environmentId, AuthPreviewOperateScope)
        ) {
          void closePreviewSession({
            closePreview,
            snapshot: readThreadPreviewState(threadRef).sessions[surface.resourceId] ?? null,
            tabId: surface.resourceId,
            threadRef,
          });
        }
        if (
          surface.kind === "side-chat" &&
          readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope) &&
          // A live shell without the side chat means it is already deleted.
          !(
            appAtomRegistry.get(environmentShell.stateValueAtom(threadRef.environmentId)).status ===
              "live" &&
            readThreadShell(scopeThreadRef(threadRef.environmentId, surface.threadId)) === null
          )
        ) {
          // The server keeps a side chat with a run or message.
          void deleteThread({
            environmentId: threadRef.environmentId,
            input: { threadId: surface.threadId, onlyIfUnused: true },
          });
        }
      },
    });
    const removeCloser = registerLayoutSurfaceCloser(closeThreadSurface);
    return () => {
      removeCloser();
      removeServices();
    };
  }, [closePreview, closeTerminal, deleteThread, writeTerminal]);
  return null;
}
