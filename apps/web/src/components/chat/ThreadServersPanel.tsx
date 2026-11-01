import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthPreviewOperateScope,
  type DiscoveredLocalServer,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { LoaderCircleIcon, SquareIcon } from "lucide-react";
import { type MouseEvent, useState } from "react";

import { resolveDiscoveredServerUrl } from "../../browser/browserTargetResolver";
import { readLocalApi } from "../../localApi";
import { isMacPlatform } from "../../lib/utils";
import { useThreadDiscoveredPorts } from "../../portDiscoveryState";
import { useEnvironment } from "../../state/environments";
import { previewEnvironment } from "../../state/preview";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { openDiscoveredPort } from "../preview/openDiscoveredPort";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  ThreadDetailsRow,
  ThreadDetailsRowContent,
  ThreadDetailsRowLabelButton,
} from "../ui/thread-details-row";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

const serverKey = (server: DiscoveredLocalServer) => `${server.pid}:${server.port}`;

/** Web servers the thread's terminals and agent started. Hidden while none run. */
export function ThreadServersPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const servers = useThreadDiscoveredPorts(props);
  const canOpen = useEnvironmentScope(props.environmentId, AuthPreviewOperateScope);
  const canStop = useAtomValue(
    previewEnvironment.stopLocalServer.permissionAtom(props.environmentId),
  );
  const supportsStop =
    useEnvironment(props.environmentId)?.serverConfig?.environment.capabilities.localServerStop ===
    true;
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const stopServer = useAtomCommand(previewEnvironment.stopLocalServer, {
    label: "thread server stop",
  });
  const [stoppingKey, setStoppingKey] = useState<string | null>(null);

  if (servers.length === 0) return null;
  const externalClickLabel = isMacPlatform(navigator.platform) ? "⌘-click" : "Ctrl-click";
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);

  const reportFailure = (title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  const open = async (server: DiscoveredLocalServer, event: MouseEvent<HTMLElement>) => {
    if (event.button > 1) return;
    // Like links: modified and middle clicks go to the system browser.
    if (event.metaKey || event.ctrlKey || event.button === 1) {
      event.preventDefault();
      const url = resolveDiscoveredServerUrl(props.environmentId, server.url);
      await readLocalApi()
        ?.shell.openExternal(url)
        .catch((error: unknown) => reportFailure("Unable to open in browser", error));
      return;
    }
    const result = await openDiscoveredPort({ threadRef, port: server, openPreview });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Unable to open preview", squashAtomCommandFailure(result));
    }
  };

  const stop = async (server: DiscoveredLocalServer) => {
    if (server.pid === null || stoppingKey !== null) return;
    setStoppingKey(serverKey(server));
    const result = await stopServer({
      environmentId: props.environmentId,
      input: { pid: server.pid, port: server.port },
    });
    setStoppingKey(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not stop server", squashAtomCommandFailure(result));
    }
  };

  return (
    <ThreadDetailsSection headingId="thread-details-servers-heading" title="Servers">
      <ul className="m-0 list-none p-0">
        {servers.map((server) => {
          const key = serverKey(server);
          const stoppable = canStop && supportsStop && server.pid !== null;
          return (
            <li key={key} className="group">
              <ThreadDetailsRow>
                <Tooltip>
                  <TooltipTrigger
                    delay={200}
                    render={
                      <ThreadDetailsRowLabelButton
                        className="col-start-1"
                        disabled={!canOpen}
                        onClick={(event) => void open(server, event)}
                        onAuxClick={(event) => void open(server, event)}
                      />
                    }
                  >
                    <ThreadDetailsRowContent
                      label={`localhost:${server.port}`}
                      value={
                        server.processName ?? (server.terminal === null ? "Agent" : "Terminal")
                      }
                    />
                  </TooltipTrigger>
                  <TooltipPopup side="left">
                    Open in the browser panel. {externalClickLabel} for your browser.
                  </TooltipPopup>
                </Tooltip>
                <span className="col-start-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="size-1.5 rounded-full bg-success" aria-hidden />
                  Running
                  {stoppable ? (
                    <span className="hidden transition-opacity group-hover:flex group-focus-within:flex pointer-coarse:flex">
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <ThreadDetailsControl
                              size="icon-xs"
                              variant="ghost"
                              part="icon"
                              tone="destructive"
                              aria-label={`Stop localhost:${server.port}`}
                              disabled={stoppingKey !== null}
                              onClick={() => void stop(server)}
                            />
                          }
                        >
                          {stoppingKey === key ? (
                            <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
                          ) : (
                            <SquareIcon aria-hidden className="size-3 fill-current" />
                          )}
                        </TooltipTrigger>
                        <TooltipPopup side="left">Stop server</TooltipPopup>
                      </Tooltip>
                    </span>
                  ) : null}
                </span>
              </ThreadDetailsRow>
            </li>
          );
        })}
      </ul>
    </ThreadDetailsSection>
  );
}
