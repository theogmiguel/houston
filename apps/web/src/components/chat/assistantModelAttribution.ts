import type { ModelSelection, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import { getTriggerDisplayModelName } from "./providerIconUtils";

/** The provider and model an assistant answer ran on, as the history names them. */
export interface AssistantModelAttribution {
  readonly providerDisplayName: string;
  readonly modelLabel: string;
}

export function resolveAssistantModelAttribution(input: {
  readonly runs: ReadonlyArray<{
    readonly id: string;
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelSelection: ModelSelection;
  }>;
  readonly runId: string | null | undefined;
  readonly providers: ReadonlyArray<ServerProvider> | null | undefined;
}): AssistantModelAttribution | null {
  if (!input.runId) return null;
  const run = input.runs.find((candidate) => candidate.id === input.runId);
  if (run === undefined) return null;
  const selection = run.modelSelection;
  if (typeof selection?.model !== "string" || selection.model.trim().length === 0) return null;

  const instanceId = run.providerInstanceId ?? selection.instanceId;
  const provider = input.providers?.find((candidate) => candidate.instanceId === instanceId);
  const model = provider?.models.find((candidate) => candidate.slug === selection.model);
  return {
    providerDisplayName:
      provider === undefined ? instanceId : resolveProviderInstanceDisplayName(provider),
    modelLabel:
      model === undefined ? selection.model : getTriggerDisplayModelName(model, provider?.driver),
  };
}
