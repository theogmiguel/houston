import {
  type ModelCapabilities,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionSelection,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  buildExplicitProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  isClaudeUltrathinkPrompt,
  normalizeModelSlug,
} from "@t3tools/shared/model";

import type { DraftId } from "../../composerDraftStore";
import { getProviderModelCapabilities } from "../../providerModels";
import {
  getReasoningTraitStep,
  type PromptUltrathink,
  type TraitsSelectionInput,
} from "./TraitsPicker";

type ComposerProviderStateInput = {
  provider: ProviderDriverKind;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  promptInjectionState?: ComposerPromptInjectionState;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  planModeEnabled: boolean;
};

type ComposerPromptInjectionState = "none" | "ultrathink";

type ComposerProviderState = {
  provider: ProviderDriverKind;
  promptEffort: string | null;
  modelOptionsForDispatch: ReadonlyArray<ProviderOptionSelection> | undefined;
  composerFrameClassName?: string;
  composerSurfaceClassName?: string;
  modelPickerIconClassName?: string;
};

type ComposerTraitsTarget = {
  provider: ProviderDriverKind;
  instanceId: ProviderInstanceId;
  threadRef?: ScopedThreadRef | undefined;
  draftId?: DraftId | undefined;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | undefined;
  reportedModelSelection?: ModelSelection | null | undefined;
  promptUltrathink: PromptUltrathink;
  onPromptEdit: (edit: (prompt: string) => string) => void;
  planModeEnabled: boolean;
<<<<<<< 57f5b2527b386f5e6f3426d989d40921b2199f5b
  size?: ComposerControlSize;
  hidden?: boolean;
  triggerClassName?: string;
  isComposerOwned?: boolean;
  keybindings?: ResolvedKeybindingsConfig;
  effortDisplay?: EffortDisplay;
  extraMenuContent?: ReactNode;
  extraMenuOwnsModeShortcut?: boolean;
  extraMenuHint?: string;
=======
>>>>>>> e6e2ab05cceb3f8245e87f8499d4891f27de33cb
};

export function getComposerPromptInjectionState(prompt: string): ComposerPromptInjectionState {
  return isClaudeUltrathinkPrompt(prompt) ? "ultrathink" : "none";
}

/** Cursor ACP can default Fast to true; T3 requires a user selection. */
export function withImplicitFastModeDefault(
  caps: ModelCapabilities,
  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  const hasExplicitFastMode = modelOptions?.some((selection) => selection.id === "fastMode");
  if (hasExplicitFastMode) {
    return modelOptions ?? undefined;
  }
  const hasFastModeDescriptor = caps.optionDescriptors?.some(
    (descriptor) => descriptor.type === "boolean" && descriptor.id === "fastMode",
  );
  if (!hasFastModeDescriptor) {
    return modelOptions ?? undefined;
  }
  return [...(modelOptions ?? []), { id: "fastMode", value: false }];
}

function resolveComposerOptionSelections(
  models: ReadonlyArray<ServerProviderModel>,
  model: string,
  provider: ProviderDriverKind,
  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  planModeEnabled: boolean,
): {
  caps: ModelCapabilities;
  selections: ReadonlyArray<ProviderOptionSelection> | undefined;
} {
  const caps = getProviderModelCapabilities(models, model, provider, planModeEnabled);
  return { caps, selections: withImplicitFastModeDefault(caps, modelOptions) };
}

export function getComposerProviderState(input: ComposerProviderStateInput): ComposerProviderState {
  const {
    provider,
    model,
    models,
    modelOptions,
    promptInjectionState = "none",
    planModeEnabled,
  } = input;
  if (provider === "opencode") {
    const normalizedModel = normalizeModelSlug(model, provider);
    const modelIsInCatalog = models.some((candidate) => candidate.slug === normalizedModel);
    if (!modelIsInCatalog) {
      const preservedOptions = modelOptions?.filter(
        (option) => planModeEnabled || option.id !== "agent" || option.value !== "plan",
      );
      return {
        provider,
        promptEffort: null,
        modelOptionsForDispatch:
          preservedOptions && preservedOptions.length > 0 ? preservedOptions : undefined,
      };
    }
  }
  const { caps, selections } = resolveComposerOptionSelections(
    models,
    model,
    provider,
    modelOptions,
    planModeEnabled,
  );
  const descriptors = getProviderOptionDescriptors({ caps, selections });
  const primarySelectDescriptor = descriptors.find(
    (descriptor): descriptor is Extract<(typeof descriptors)[number], { type: "select" }> =>
      descriptor.type === "select",
  );
  const primaryValue = getProviderOptionCurrentValue(primarySelectDescriptor ?? null);
  const promptEffort = typeof primaryValue === "string" ? primaryValue : null;
  const ultrathinkActive =
    (primarySelectDescriptor?.promptInjectedValues?.length ?? 0) > 0 &&
    promptInjectionState === "ultrathink";

  return {
    provider,
    promptEffort,
    modelOptionsForDispatch: buildExplicitProviderOptionSelectionsFromDescriptors(
      descriptors,
      selections,
    ),
    ...(ultrathinkActive
      ? {
          composerFrameClassName: "ultrathink-frame",
          composerSurfaceClassName: "shadow-[0_0_0_1px_rgba(255,255,255,0.07)_inset]",
          modelPickerIconClassName: "ultrathink-chroma",
        }
      : {}),
  };
}

/** The caret stays on the same character when stepping strips a typed Ultrathink prefix. */
export function getComposerReasoningStep(input: {
  provider: ProviderDriverKind;
  instanceId: ProviderInstanceId;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  reportedModelSelection?: ModelSelection | null | undefined;
  prompt: string;
  cursor: number;
  planModeEnabled: boolean;
  direction: 1 | -1;
}): {
  prompt: string;
  cursor: number;
  modelOptions: ReadonlyArray<ProviderOptionSelection>;
} | null {
  const { prompt, cursor } = input;
  const { selections } = resolveComposerOptionSelections(
    input.models,
    input.model,
    input.provider,
    input.modelOptions,
    input.planModeEnabled,
  );
  const step = getReasoningTraitStep({
    provider: input.provider,
    instanceId: input.instanceId,
    model: input.model,
    models: input.models,
    modelOptions: selections,
    reportedModelSelection: input.reportedModelSelection,
    prompt,
    planModeEnabled: input.planModeEnabled,
    direction: input.direction,
  });
  if (!step) return null;
  return {
    prompt: step.prompt,
    cursor: Math.max(0, cursor + step.prompt.length - prompt.length),
    modelOptions: step.modelOptions,
  };
}

<<<<<<< 57f5b2527b386f5e6f3426d989d40921b2199f5b
function renderTraitsControl(
  Component: typeof TraitsMenuContent | typeof TraitsPicker,
  input: TraitsRenderInput,
): ReactNode {
  const {
    provider,
    instanceId,
    threadRef,
    draftId,
    model,
    models,
    modelOptions,
    reportedModelSelection,
    promptUltrathink,
    onPromptEdit,
    planModeEnabled,
    size,
    hidden,
    triggerClassName,
    isComposerOwned,
    keybindings,
    effortDisplay,
    extraMenuContent,
    extraMenuOwnsModeShortcut,
    extraMenuHint,
  } = input;
  const hasTarget = threadRef !== undefined || draftId !== undefined;
  const { selections: resolvedModelOptions } = resolveComposerOptionSelections(
    models,
    model,
    provider,
    modelOptions,
    planModeEnabled,
  );
  if (
    !hasTarget ||
    !shouldRenderTraitsControls({
      provider,
      models,
      model,
      modelOptions: resolvedModelOptions,
      promptUltrathink,
      planModeEnabled,
    })
  ) {
    return null;
  }
  return (
    <Component
      provider={provider}
      {...(instanceId ? { instanceId } : {})}
      models={models}
      {...(threadRef ? { threadRef } : {})}
      {...(draftId ? { draftId } : {})}
      model={model}
      modelOptions={resolvedModelOptions}
      reportedModelSelection={reportedModelSelection}
      promptUltrathink={promptUltrathink}
      onPromptEdit={onPromptEdit}
      planModeEnabled={planModeEnabled}
      {...(size !== undefined ? { size } : {})}
      {...(hidden !== undefined ? { hidden } : {})}
      {...(triggerClassName !== undefined ? { triggerClassName } : {})}
      {...(isComposerOwned ? { isComposerOwned } : {})}
      {...(keybindings ? { keybindings } : {})}
      {...(effortDisplay ? { effortDisplay } : {})}
      {...(extraMenuContent ? { extraMenuContent } : {})}
      {...(extraMenuOwnsModeShortcut ? { extraMenuOwnsModeShortcut } : {})}
      {...(extraMenuHint ? { extraMenuHint } : {})}
    />
=======
/**
 * The composer's traits input with the model's implicit defaults applied, so a pick writes what
 * the composer would send. Null without a draft or thread to persist to.
 */
export function resolveComposerTraitsInput(
  input: ComposerTraitsTarget,
): TraitsSelectionInput | null {
  const { threadRef, draftId, ...rest } = input;
  const { selections } = resolveComposerOptionSelections(
    input.models,
    input.model,
    input.provider,
    input.modelOptions,
    input.planModeEnabled,
>>>>>>> e6e2ab05cceb3f8245e87f8499d4891f27de33cb
  );
  const persistence = threadRef ? { threadRef } : draftId ? { draftId } : null;
  if (!persistence) return null;
  return { ...rest, ...persistence, modelOptions: selections };
}
