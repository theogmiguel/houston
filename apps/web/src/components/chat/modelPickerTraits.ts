import type { ModelCapabilities, ProviderOptionDescriptor } from "@t3tools/contracts";
import { REASONING_EFFORT_OPTION_IDS } from "@t3tools/client-runtime/state/thread-execution";
import { formatCompactContextWindowTokens } from "~/lib/contextWindow";

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;

export interface ModelPickerTraits {
  /** The model's context window as its provider labels it, such as "200k" or "1M". */
  readonly contextWindow: string | null;
  /** The model's reasoning effort as its provider labels it, such as "High" or "Max". */
  readonly effort: string | null;
}

const NO_MODEL_PICKER_TRAITS: ModelPickerTraits = { contextWindow: null, effort: null };

function selectDescriptor(
  capabilities: ModelCapabilities | null | undefined,
  ids: ReadonlyArray<string>,
): SelectDescriptor | null {
  for (const id of ids) {
    const descriptor = capabilities?.optionDescriptors?.find((candidate) => candidate.id === id);
    if (descriptor?.type === "select") return descriptor;
  }
  return null;
}

function descriptorLabel(descriptor: SelectDescriptor | null): string | null {
  if (descriptor === null) return null;
  const value =
    descriptor.currentValue ??
    descriptor.options.find((option) => option.isDefault === true)?.id ??
    descriptor.options[0]?.id;
  const label = descriptor.options.find((option) => option.id === value)?.label.trim();
  return label ? label : null;
}

/**
 * The context size and effort a model's catalog entry declares, read from the option descriptors
 * the provider already publishes. Models that declare neither contribute no picker metadata.
 */
export function resolveModelPickerTraits(
  capabilities: ModelCapabilities | null | undefined,
): ModelPickerTraits {
  const contextWindow =
    formatCompactContextWindowTokens(capabilities?.contextWindowTokens) ??
    descriptorLabel(selectDescriptor(capabilities, ["contextWindow"]));
  const effort = descriptorLabel(selectDescriptor(capabilities, REASONING_EFFORT_OPTION_IDS));
  if (contextWindow === null && effort === null) return NO_MODEL_PICKER_TRAITS;
  return { contextWindow, effort };
}

/** One muted line for the row's trailing column, e.g. "200K · High". */
export function formatModelPickerTraits(traits: ModelPickerTraits): string | null {
  return (
    [traits.contextWindow, traits.effort].filter((label) => label !== null).join(" · ") || null
  );
}
