import type { EnvironmentId } from "@houston-app/contracts";
import type { InferenceDiscoveredServer } from "@houston-app/contracts/houston/inference";

import { discoverInferenceServers, INFERENCE_DISCOVERY_EMPTY_INPUT } from "../../state/inference";
import { useEnvironmentQuery } from "../../state/query";
import { Badge } from "../ui/badge";
import { Card } from "../ui/card";
import { Button } from "../ui/button";
import { Text } from "../ui/text";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

function baseUrlHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** Searches this machine once on open; nothing is saved until the user adds a result. */
export function FindInferenceServersDialog({
  environmentId,
  environmentLabel,
  onClose,
  onPick,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly onClose: () => void;
  readonly onPick: (server: InferenceDiscoveredServer) => void;
}) {
  const query = useEnvironmentQuery(
    discoverInferenceServers({ environmentId, input: INFERENCE_DISCOVERY_EMPTY_INPUT }),
  );
  const servers = query.data?.servers ?? null;
  const searchedListeningPorts = query.data?.searchedListeningPorts === true;
  const failure = query.error;
  const pending = query.isPending;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Find inference servers</DialogTitle>
          <DialogDescription>
            Well-known ports on {environmentLabel}
            {searchedListeningPorts ? " and the ports it listens on" : ""}, and the servers you
            already registered. Nothing is saved until you add a server.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {!searchedListeningPorts ? (
            <Text as="p" variant="caption" tone="muted">
              Only the usual ports were searched: the server reads its listening ports on Linux
              only. Enter another address with Add server.
            </Text>
          ) : null}
          {pending ? (
            <Text as="p" tone="muted">
              Looking for model servers…
            </Text>
          ) : failure !== null ? (
            <Text as="p" tone="danger" role="alert">
              {failure}
            </Text>
          ) : servers !== null && servers.length === 0 ? (
            <Text as="p" tone="muted">
              No model server answered. Start one, then search again.
            </Text>
          ) : (
            <div className="flex flex-col gap-2">
              {(servers ?? []).map((server) => (
                <Card key={server.baseUrl}>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Text truncate weight="medium">
                          {server.engine ?? baseUrlHost(server.baseUrl)}
                        </Text>
                        <Badge variant={server.status === "ready" ? "success" : "warning"}>
                          {server.status === "ready" ? "Ready" : "Needs an API key"}
                        </Badge>
                        {server.registeredServerId === undefined ? null : (
                          <Badge variant="outline">Registered</Badge>
                        )}
                      </div>
                      <Text as="p" truncate variant="caption" tone="muted">
                        {server.baseUrl}
                      </Text>
                      {server.status === "ready" ? (
                        <Text as="p" variant="caption" tone="muted">
                          {server.models.length === 1
                            ? "1 model"
                            : `${server.models.length} models`}
                          {server.registeredServerId === undefined ? "" : " · already registered"}
                        </Text>
                      ) : null}
                    </div>
                    <Button
                      size="compact"
                      variant="outline"
                      onClick={() => {
                        onPick(server);
                        onClose();
                      }}
                    >
                      {server.registeredServerId === undefined ? "Add" : "Edit"}
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button size="compact" variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button
            size="compact"
            variant="ghost-muted"
            disabled={pending}
            onClick={() => query.refresh()}
          >
            {pending ? "Searching…" : "Search again"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
