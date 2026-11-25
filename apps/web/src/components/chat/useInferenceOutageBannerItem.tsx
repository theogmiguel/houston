import type { EnvironmentId, ServerProvider } from "@houston-app/contracts";
import type { InferenceServerId } from "@houston-app/contracts/houston/inference";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { CpuIcon, ImageOffIcon } from "lucide-react";
import { useRef, useState } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import {
  checkInferenceModelImages,
  INFERENCE_SERVERS_EMPTY_INPUT,
  inferenceServers,
  refreshInferenceServers,
} from "../../state/inference";
import {
  inferenceModelImageGap,
  inferenceModelNotServed,
  inferenceServerOutage,
} from "../../state/inferencePresentation";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

export interface InferenceBanner {
  readonly item: ComposerBannerStackItem | null;
  /** Call when an image is attached; an unchecked model starts its check here. */
  readonly onImagesAttached: () => void;
}

/**
 * A notice while the model server the selected agent is linked to is down, or is up but no longer
 * serves the selected model, or while an attached image would not reach that model.
 */
export function useInferenceOutageBannerItem(
  environmentId: EnvironmentId,
  provider: ServerProvider | null,
  modelSlug: string,
  hasImages: boolean,
  onChooseModel: () => void,
): InferenceBanner {
  const navigate = useNavigate();
  const servers = useEnvironmentSettings(environmentId, (settings) => settings.inferenceServers);
  const snapshotsQuery = useEnvironmentQuery(
    inferenceServers({ environmentId, input: INFERENCE_SERVERS_EMPTY_INPUT }),
  );
  const refresh = useAtomCommand(refreshInferenceServers, { reportFailure: false });
  const checkImages = useAtomCommand(checkInferenceModelImages, { label: "check images" });
  const canCheckImages = useAtomValue(checkInferenceModelImages.permissionAtom(environmentId));
  const [imageCheck, setImageCheck] = useState<{
    readonly key: string;
    readonly running: boolean;
    readonly detail?: string;
  } | null>(null);
  const autoChecked = useRef(new Set<string>());
  const snapshots = snapshotsQuery.data?.servers ?? [];
  const outage = inferenceServerOutage({
    serverId: provider?.inferenceServerId,
    servers,
    snapshots,
  });
  const linked = {
    serverId: provider?.inferenceServerId,
    driver: provider?.driver,
    modelSlug,
    servers,
    snapshots,
  };
  const imageGap = hasImages && outage === null ? inferenceModelImageGap(linked) : null;
  const imageKey = imageGap === null ? null : `${environmentId}:${imageGap.id}:${imageGap.model}`;
  const runImageCheck = useStableCallback(
    async (key: string, serverId: InferenceServerId, model: string) => {
      setImageCheck({ key, running: true });
      const result = await checkImages({ environmentId, input: { serverId, model } });
      setImageCheck(
        result._tag === "Success" && result.value.outcome === "unknown"
          ? { key, running: false, detail: result.value.detail }
          : null,
      );
    },
  );
  const onImagesAttached = useStableCallback(() => {
    if (imageGap === null || imageKey === null || imageGap.reason !== "unchecked") return;
    if (!canCheckImages || autoChecked.current.has(imageKey)) return;
    autoChecked.current.add(imageKey);
    void runImageCheck(imageKey, imageGap.id, imageGap.model);
  });

  const item = ((): ComposerBannerStackItem | null => {
    if (outage !== null) {
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
    const notServed = inferenceModelNotServed(linked);
    if (notServed !== null) {
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
    if (imageGap === null) return null;
    const check = imageCheck?.key === imageKey ? imageCheck : null;
    return {
      id: `inference-images:${imageGap.id}:${imageGap.model}`,
      group: "environment",
      variant: "warning",
      icon: <ImageOffIcon />,
      title:
        imageGap.reason === "text-only"
          ? `${imageGap.model} reads text only`
          : check?.running === true
            ? `Checking whether ${imageGap.model} reads images`
            : `Not known whether ${imageGap.model} reads images`,
      description:
        imageGap.reason === "text-only"
          ? "It will not see the attached image. Choose a model that reads images."
          : `${check?.detail === undefined ? "" : `${check.detail} `}The image is sent anyway; if the model cannot read it, its server will say so.`,
      actions: (
        <>
          {imageGap.reason === "unchecked" && canCheckImages ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={check?.running === true}
              onClick={() => void runImageCheck(imageKey!, imageGap.id, imageGap.model)}
            >
              {check?.running === true ? "Checking images" : "Check images"}
            </Button>
          ) : null}
          <Button size="xs" variant="ghost" onClick={onChooseModel}>
            Choose model
          </Button>
        </>
      ),
    };
  })();

  return { item, onImagesAttached };
}
