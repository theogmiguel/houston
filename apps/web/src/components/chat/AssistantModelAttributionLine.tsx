import type { AssistantModelAttribution } from "./assistantModelAttribution";

/** A muted line naming the provider and model behind an answer; absent when they are unknown. */
export function AssistantModelAttributionLine({
  attribution,
}: {
  attribution: AssistantModelAttribution | null;
}) {
  if (attribution === null) return null;
  return (
    <p
      className="mt-1 truncate text-xs text-muted-foreground"
      data-assistant-model-attribution="true"
    >
      {attribution.providerDisplayName} · {attribution.modelLabel}
    </p>
  );
}
