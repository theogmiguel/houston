import type { EnvironmentId, ServerProvider } from "@houston-app/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CpuIcon } from "lucide-react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import {
  INFERENCE_SERVERS_EMPTY_INPUT,
  inferenceServers,
  refreshInferenceServers,
} from "../../state/inference";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { inferenceModelNotServed, inferenceServerOutage } from "../../state/inferencePresentation";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/**
 * A notice while the model server the selected agent is linked to is down, or is up but no longer
 * serves the selected model, with ways to fix it.
 */
export function useInferenceOutageBannerItem(
  environmentId: EnvironmentId,
  provider: ServerProvider | null,
  modelSlug: string,
  onChooseModel: () => void,
): ComposerBannerStackItem | null {
  const navigate = useNavigate();
  const servers = useEnvironmentSettings(environmentId, (settings) => settings.inferenceServers);
  const snapshotsQuery = useEnvironmentQuery(
    inferenceServers({ environmentId, input: INFERENCE_SERVERS_EMPTY_INPUT }),
  );
  const refresh = useAtomCommand(refreshInferenceServers, { reportFailure: false });
  const snapshots = snapshotsQuery.data?.servers ?? [];
  const outage = inferenceServerOutage({
    serverId: provider?.inferenceServerId,
    servers,
    snapshots,
  });
  if (outage === null) {
    const notServed = inferenceModelNotServed({
      serverId: provider?.inferenceServerId,
      driver: provider?.driver,
      modelSlug,
      servers,
      snapshots,
    });
    if (notServed === null) return null;
    return {
      id: `inference-not-served:${notServed.id}:${notServed.model}`,
      group: "environment",
      variant: "warning",
      icon: <CpuIcon />,
      title: `${notServed.name} no longer serves ${notServed.model}`,
      description: `It serves ${notServed.served.join(", ")} now. Choose one of them, or check again if the model is coming back.`,
      actions: (
        <>
          <Button size="xs" variant="ghost" onClick={onChooseModel}>
            Choose model
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void refresh({ environmentId, input: { id: notServed.id } })}
          >
            Check again
          </Button>
        </>
      ),
    };
  }
  return {
    id: `inference-outage:${outage.id}`,
    group: "environment",
    variant: "warning",
    icon: <CpuIcon />,
    title: `${outage.name} is not answering`,
    description: `${outage.baseUrl}: ${outage.message} Its models are hidden until it answers again.`,
    actions: (
      <>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => void refresh({ environmentId, input: { id: outage.id } })}
        >
          Check again
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            void navigate({
              to: "/settings/inference",
              search: { repair: outage.id },
            })
          }
        >
          Find server
        </Button>
      </>
    ),
  };
}
