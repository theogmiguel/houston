import type { EnvironmentId } from "@houston-app/contracts";
import type {
  InferenceDiscoveredServer,
  InferenceServerConfig,
  InferenceServerId,
} from "@houston-app/contracts/houston/inference";
import { useState } from "react";

import {
  discoverInferenceServers,
  refreshInferenceServers,
  saveInferenceServer,
} from "../../state/inference";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { Text } from "../ui/text";
import { toastManager } from "../ui/toast";
import { repairCandidates } from "./localModelSetup.logic";

type Search =
  | { readonly status: "searching" }
  | { readonly status: "done"; readonly servers: ReadonlyArray<InferenceDiscoveredServer> }
  | { readonly status: "failed"; readonly message: string };

function hostOf(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Looks on a registered server's host for where it went, and moves the server there. The id stays,
 * so linked agents and their `houston-<server>/<model>` models keep working; the saved key goes
 * along because the save input omits it.
 */
export function FindInferenceServerDialog({
  environmentId,
  id,
  name,
  config,
  knownModelIds,
  onChangeAddress,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly id: InferenceServerId;
  readonly name: string;
  readonly config: InferenceServerConfig;
  /** Models it served before, to point out a candidate that serves them too. */
  readonly knownModelIds: ReadonlySet<string>;
  readonly onChangeAddress: () => void;
  readonly onClose: () => void;
}) {
  const save = useAtomCommand(saveInferenceServer, { reportFailure: false });
  const refresh = useAtomCommand(refreshInferenceServers, { reportFailure: false });
  const [moving, setMoving] = useState<string | null>(null);
  const host = hostOf(config.baseUrl);
  const query = useEnvironmentQuery(
    host === undefined ? null : discoverInferenceServers({ environmentId, input: { host } }),
  );
  const search: Search =
    host === undefined
      ? { status: "done", servers: [] }
      : query.error !== null
        ? { status: "failed", message: query.error }
        : query.data === undefined || query.data === null
          ? { status: "searching" }
          : { status: "done", servers: query.data.servers };
  const candidates =
    search.status === "done"
      ? repairCandidates(search.servers, id, config.baseUrl, knownModelIds)
      : [];

  const move = async (baseUrl: string) => {
    setMoving(baseUrl);
    const saved = await save({
      environmentId,
      input: {
        id,
        baseUrl,
        ...(config.displayName === undefined ? {} : { displayName: config.displayName }),
        enabled: config.enabled,
        ...(config.maxConcurrentRequests === undefined
          ? {}
          : { maxConcurrentRequests: config.maxConcurrentRequests }),
        fallbackServerId: config.fallbackServerId ?? null,
      },
    });
    if (saved._tag === "Failure") {
      setMoving(null);
      const error =
        saved.cause instanceof Error ? saved.cause.message : "The settings update failed.";
      toastManager.add({
        type: "error",
        title: `${name} was not moved`,
        description: error,
      });
      return;
    }
    const checked = await refresh({ environmentId, input: { id } });
    const snapshot =
      checked._tag === "Success"
        ? checked.value.servers.find((server) => server.id === id)
        : undefined;
    toastManager.add({
      type: snapshot?.status === "ready" ? "success" : "warning",
      title:
        snapshot?.status === "ready"
          ? `${name} now uses ${baseUrl}`
          : `${name} moved to ${baseUrl}, but is not ready`,
      description:
        snapshot?.status === "ready"
          ? "Threads already running keep the old address until their agent session restarts."
          : (snapshot?.message ?? "Check its address in Settings, Inference."),
    });
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && moving === null) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Find {name}</DialogTitle>
          <DialogDescription>
            {name} does not answer at {config.baseUrl}. Looking for model servers on{" "}
            {host ?? "its host"} that it may have moved to.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {search.status === "searching" ? (
            <div className="flex items-center gap-2" role="status">
              <Spinner className="size-4" />
              <Text as="p" tone="muted">
                Searching {host ?? "its host"}…
              </Text>
            </div>
          ) : search.status === "failed" ? (
            <Text as="p" tone="danger">
              {search.message}
            </Text>
          ) : candidates.length === 0 ? (
            <Text as="p" tone="muted">
              Nothing else answered on {host ?? "its host"}. If you know where it moved, change its
              address.
            </Text>
          ) : (
            <ul className="grid gap-2">
              {candidates.map(({ server, sameModel }) => (
                <li key={server.baseUrl}>
                  <Card>
                    <div className="flex items-center justify-between gap-3">
                      <div className="grid min-w-0 gap-0.5">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <Text mono variant="caption">
                            {server.baseUrl}
                          </Text>
                          {sameModel ? <Badge variant="success">Same model</Badge> : null}
                          {server.status === "needs-key" ? (
                            <Badge variant="outline">Uses {name}'s key</Badge>
                          ) : null}
                        </span>
                        <Text truncate variant="caption" tone="muted">
                          {[server.engine, ...server.models.map((model) => model.id)]
                            .filter(Boolean)
                            .join(" · ") || "Lists its models only with a key"}
                        </Text>
                      </div>
                      <Button
                        size="sm"
                        variant={sameModel ? "default" : "outline"}
                        disabled={moving !== null}
                        onClick={() => void move(server.baseUrl)}
                      >
                        {moving === server.baseUrl ? <Spinner className="size-3.5" /> : null}
                        Use this address
                      </Button>
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={moving !== null} onClick={onChangeAddress}>
            Change address
          </Button>
          <Button
            variant="ghost"
            disabled={moving !== null || search.status === "searching"}
            onClick={() => void query.refresh()}
          >
            Search again
          </Button>
          <Button variant="ghost" disabled={moving !== null} onClick={onClose}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
