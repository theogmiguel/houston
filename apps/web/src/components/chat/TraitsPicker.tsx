import {
  buildTraitsTriggerDisplay,
  getDescriptorStringValue,
  getTraitSelectChange,
  replaceDescriptorCurrentValue,
  selectableProviderOptionChoices,
  REASONING_SELECT_DESCRIPTOR_IDS,
  ULTRATHINK_PROMPT_PREFIX,
} from "@t3tools/client-runtime/model-traits";
import {
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type { EffortDisplay } from "@t3tools/contracts/settings";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentLabel,
  getProviderOptionDescriptors,
  isClaudeUltrathinkPrompt,
  normalizeModelSlug,
} from "@t3tools/shared/model";
import { memo, type ReactNode, useRef } from "react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import {
  BrainIcon,
  ChartNoAxesColumnIcon,
  ChevronDownIcon,
  GaugeIcon,
  ZapIcon,
} from "lucide-react";
import {
  Menu,
  MenuGroup,
  MenuPopup,
  MenuSeparator as MenuDivider,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuTrigger,
} from "../ui/menu";
import { useComposerDraftStore, DraftId } from "../../composerDraftStore";
import { getProviderModelCapabilities } from "../../providerModels";
import { formatCompactContextWindowTokens } from "../../lib/contextWindow";
import { shortcutLabelForCommand } from "../../keybindings";
import { shortEffortLabel, traitsSplitTriggerClassName, type TraitsSplitPart } from "./modelTraits";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";
import { focusRequestedPermission, useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";
import { EffortGlyph, resolveEffortGlyph } from "./EffortGlyph";

type ProviderOptions = ReadonlyArray<ProviderOptionSelection>;

/**
 * All the picker reads from the prompt while rendering. Passing this instead of
 * the prompt keeps the picker from re-rendering on every keystroke.
 */
export type PromptUltrathink = "none" | "prefix" | "body";

export function readPromptUltrathink(prompt: string): PromptUltrathink {
  if (!isClaudeUltrathinkPrompt(prompt)) return "none";
  return isClaudeUltrathinkPrompt(prompt.replace(/^Ultrathink:\s*/i, "")) ? "body" : "prefix";
}

const SAVED_OPTION_LABELS: Readonly<Record<string, string>> = {
  agent: "Agent",
  effort: "Effort",
  reasoningEffort: "Reasoning effort",
  variant: "Reasoning",
};

function savedOptionLabel(id: string): string {
  return (
    SAVED_OPTION_LABELS[id] ??
    id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (character) => character.toUpperCase())
  );
}

function buildUnavailableModelOptionDescriptors(
  selections: ProviderOptions | null | undefined,
): ReadonlyArray<ProviderOptionDescriptor> {
  return (selections ?? []).map((selection) =>
    typeof selection.value === "boolean"
      ? {
          id: selection.id,
          label: savedOptionLabel(selection.id),
          type: "boolean" as const,
          currentValue: selection.value,
        }
      : {
          id: selection.id,
          label: savedOptionLabel(selection.id),
          type: "select" as const,
          options: [{ id: selection.value, label: selection.value }],
          currentValue: selection.value,
        },
  );
}

type TraitsPersistence =
  | {
      threadRef?: ScopedThreadRef;
      draftId?: DraftId;
      onModelOptionsChange?: never;
    }
  | {
      threadRef?: undefined;
      onModelOptionsChange: (nextOptions: ProviderOptions | undefined) => void;
    };

function DefaultBadge() {
  return (
    <Badge variant="outline" size="sm" className="min-w-0">
      Default
    </Badge>
  );
}

function getSelectedTraits(
  provider: ProviderDriverKind,
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  promptUltrathink: PromptUltrathink,
  modelOptions: ProviderOptions | null | undefined,
  allowPromptInjectedEffort: boolean,
  planModeEnabled: boolean,
) {
  const caps = getProviderModelCapabilities(models, model, provider, planModeEnabled);
  const modelIsUnavailable =
    provider === "opencode" &&
    !models.some((candidate) => candidate.slug === normalizeModelSlug(model, provider));
  const descriptors = modelIsUnavailable
    ? buildUnavailableModelOptionDescriptors(
        planModeEnabled
          ? modelOptions
          : modelOptions?.filter((option) => option.id !== "agent" || option.value !== "plan"),
      )
    : getProviderOptionDescriptors({
        caps,
        selections: modelOptions,
      });
  const selectDescriptors = descriptors.filter(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "select" }> =>
      descriptor.type === "select",
  );
  const booleanDescriptors = descriptors.filter(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "boolean" }> =>
      descriptor.type === "boolean",
  );
  const primarySelectDescriptor = selectDescriptors[0] ?? null;
  const contextWindowDescriptor =
    selectDescriptors.find((descriptor) => descriptor.id === "contextWindow") ?? null;
  const agentDescriptor = selectDescriptors.find((descriptor) => descriptor.id === "agent") ?? null;
  const fastModeDescriptor =
    booleanDescriptors.find((descriptor) => descriptor.id === "fastMode") ?? null;
  const thinkingDescriptor =
    booleanDescriptors.find((descriptor) => descriptor.id === "thinking") ?? null;

  const ultrathinkPromptControlled =
    allowPromptInjectedEffort &&
    (primarySelectDescriptor?.promptInjectedValues?.length ?? 0) > 0 &&
    promptUltrathink !== "none";
  const ultrathinkInBodyText = ultrathinkPromptControlled && promptUltrathink === "body";
  const effort =
    (ultrathinkPromptControlled
      ? "ultrathink"
      : getDescriptorStringValue(primarySelectDescriptor)) ?? null;
  const thinkingEnabled =
    typeof thinkingDescriptor?.currentValue === "boolean" ? thinkingDescriptor.currentValue : null;
  const contextWindow = getDescriptorStringValue(contextWindowDescriptor);
  const contextWindowTokens = contextWindowDescriptor
    ? null
    : caps.contextWindowTokens !== undefined && caps.contextWindowTokens > 0
      ? caps.contextWindowTokens
      : null;
  const selectedAgent = getDescriptorStringValue(agentDescriptor);
  const selectedAgentLabel = agentDescriptor
    ? getProviderOptionCurrentLabel(agentDescriptor)
    : null;

  return {
    caps,
    descriptors,
    selectDescriptors,
    booleanDescriptors,
    primarySelectDescriptor,
    contextWindowDescriptor,
    agentDescriptor,
    fastModeDescriptor,
    thinkingDescriptor,
    effort,
    thinkingEnabled,
    contextWindow,
    contextWindowTokens,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
    selectedAgent,
    selectedAgentLabel,
    modelIsUnavailable,
  };
}

function getTraitsSectionVisibility(input: {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  promptUltrathink?: PromptUltrathink | undefined;
  modelOptions: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
  planModeEnabled: boolean;
}) {
  const selected = getSelectedTraits(
    input.provider,
    input.models,
    input.model,
    input.promptUltrathink ?? "none",
    input.modelOptions,
    input.allowPromptInjectedEffort ?? true,
    input.planModeEnabled,
  );

  const showEffort = selected.primarySelectDescriptor !== null;
  const showThinking = selected.thinkingDescriptor !== null;
  const showFastMode = selected.fastModeDescriptor !== null;
  const showContextWindow =
    selected.contextWindowDescriptor !== null || selected.contextWindowTokens !== null;
  const showAgent = selected.agentDescriptor !== null;

  return {
    ...selected,
    showEffort,
    showThinking,
    showFastMode,
    showContextWindow,
    showAgent,
    hasAnyControls:
      showEffort ||
      showThinking ||
      showFastMode ||
      showContextWindow ||
      showAgent ||
      (selected.modelIsUnavailable && selected.descriptors.length > 0),
  };
}

/**
 * `modelOptions` must already carry the composer's implicit defaults (see
 * `withImplicitFastModeDefault`) so the persisted selection matches what the
 * picker would write.
 */
export function getReasoningTraitStep(input: {
  provider: ProviderDriverKind;
  instanceId: ProviderInstanceId;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ProviderOptions | undefined;
  reportedModelSelection: ModelSelection | null | undefined;
  prompt: string;
  planModeEnabled: boolean;
  direction: 1 | -1;
}) {
  const selected = getSelectedTraits(
    input.provider,
    input.models,
    input.model,
    readPromptUltrathink(input.prompt),
    input.modelOptions,
    true,
    input.planModeEnabled,
  );
  if (selected.modelIsUnavailable || selected.ultrathinkInBodyText) return null;
  const descriptor = selected.selectDescriptors.find((entry) =>
    REASONING_SELECT_DESCRIPTOR_IDS.has(entry.id),
  );
  if (!descriptor || descriptor.options.length < 2) return null;
  const isPrimary = descriptor.id === selected.primarySelectDescriptor?.id;
  const current =
    isPrimary && selected.ultrathinkPromptControlled
      ? "ultrathink"
      : getDescriptorStringValue(
          descriptor,
          { instanceId: input.instanceId, model: input.model, options: input.modelOptions ?? [] },
          input.reportedModelSelection,
        );
  const ordered = input.direction > 0 ? descriptor.options : descriptor.options.toReversed();
  const position =
    [current, getDescriptorStringValue(descriptor)]
      .map((value) => ordered.findIndex((option) => option.id === value))
      .find((index) => index >= 0) ?? -1;
  for (const option of [
    ...ordered.slice(position + 1),
    ...ordered.slice(0, Math.max(position, 0)),
  ]) {
    const change = getTraitSelectChange(selected, descriptor, input.prompt, option.id);
    if (!change) return null;
    if ("modelOptions" in change) {
      return change.modelOptions
        ? { prompt: change.prompt, modelOptions: change.modelOptions }
        : null;
    }
    // A slash command refuses the Ultrathink prefix, so skip that level.
    if (change.prompt.startsWith(ULTRATHINK_PROMPT_PREFIX)) return change;
  }
  return null;
}

export function shouldRenderTraitsControls(input: {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  promptUltrathink?: PromptUltrathink | undefined;
  modelOptions: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
  planModeEnabled: boolean;
}): boolean {
  return getTraitsSectionVisibility(input).hasAnyControls;
}

interface TraitsMenuContentProps {
  provider: ProviderDriverKind;
  instanceId?: ProviderInstanceId;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  promptUltrathink?: PromptUltrathink | undefined;
  /** Receives an edit of the live prompt; the picker never holds the prompt text itself. */
  onPromptEdit?: (edit: (prompt: string) => string) => void;
  modelOptions?: ProviderOptions | null | undefined;
  reportedModelSelection?: ModelSelection | null | undefined;
  allowPromptInjectedEffort?: boolean;
  planModeEnabled: boolean;
  triggerClassName?: string;
  isComposerOwned?: boolean;
  keybindings?: ResolvedKeybindingsConfig;
  /** Composer chips name the effort level unless the user picked bars. */
  effortDisplay?: EffortDisplay;
  /** Extra section shown below the traits in the picker popup (Permissions). */
  extraMenuContent?: ReactNode;
  /** This trigger also answers composer.mode (while the permissions chip is hidden). */
  extraMenuOwnsModeShortcut?: boolean;
  /** Extra tooltip text naming what else the menu holds. */
  extraMenuHint?: string;
  size?: ComposerControlSize;
}

const TRAITS_SECTION_HEADER =
  "flex items-center px-2 pt-1.5 pb-0.5 text-2xs font-semibold text-(--t3)";

function TraitsSectionHeader(props: { label: string; shortcut?: string | null | undefined }) {
  return (
    <div className={TRAITS_SECTION_HEADER}>
      <span className="flex-1">{props.label}</span>
      {props.shortcut ? <MenuShortcut>{props.shortcut}</MenuShortcut> : null}
    </div>
  );
}

function TraitsToggleRow(props: {
  icon: ReactNode;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <MenuPrimitive.CheckboxItem
      checked={props.checked}
      disabled={props.disabled}
      onCheckedChange={(checked) => props.onCheckedChange(checked === true)}
      className="grid h-7.5 min-h-0 cursor-pointer grid-cols-[1fr_auto] items-center gap-4 rounded-sm px-2 pe-2 text-(--t1) text-headline outline-none data-disabled:cursor-not-allowed data-disabled:opacity-64 data-highlighted:bg-(--sel)"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="flex size-3.5 shrink-0 items-center justify-center text-(--t3)">
          {props.icon}
        </span>
        <span className="min-w-0 truncate">{props.label}</span>
      </span>
      <MenuPrimitive.CheckboxItemIndicator
        keepMounted
        className="group inline-flex h-3.75 w-6.5 shrink-0 items-center rounded-full bg-(--tog-off) p-0.5 data-checked:bg-primary"
      >
        <span
          className={cn(
            "pointer-events-none block size-2.75 shrink-0 rounded-full bg-white shadow-xs transition-transform",
            props.checked && "translate-x-2.75",
          )}
        />
      </MenuPrimitive.CheckboxItemIndicator>
    </MenuPrimitive.CheckboxItem>
  );
}

function TraitsValueRow(props: {
  icon?: ReactNode;
  label: string;
  value?: string | null | undefined;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <MenuSub>
      <MenuPrimitive.SubmenuTrigger
        disabled={props.disabled}
        className="flex h-7.5 min-h-0 cursor-pointer items-center gap-2 rounded-sm px-2 text-(--t1) text-headline outline-none data-disabled:cursor-not-allowed data-disabled:opacity-64 data-highlighted:bg-(--sel) data-popup-open:bg-(--sel)"
      >
        {props.icon ? (
          <span className="flex size-3.5 shrink-0 items-center justify-center text-(--t3)">
            {props.icon}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate">{props.label}</span>
        {props.value ? <span className="shrink-0 text-(--t3)">{props.value}</span> : null}
        <ChevronDownIcon aria-hidden="true" className="size-3.25 shrink-0 text-(--t3)" />
      </MenuPrimitive.SubmenuTrigger>
      <MenuSubPopup>{props.children}</MenuSubPopup>
    </MenuSub>
  );
}

function TraitsReadOnlyRow(props: { icon?: ReactNode; label: string; value: string }) {
  return (
    <div className="flex h-7.5 min-h-0 items-center gap-2 px-2 text-(--t1) text-headline">
      {props.icon ? (
        <span className="flex size-3.5 shrink-0 items-center justify-center text-(--t3)">
          {props.icon}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      <span className="shrink-0 text-(--t3)">{props.value}</span>
    </div>
  );
}

export const TraitsMenuContent = memo(function TraitsMenuContentImpl({
  provider,
  instanceId,
  models,
  model,
  promptUltrathink,
  onPromptEdit,
  modelOptions,
  reportedModelSelection,
  allowPromptInjectedEffort = true,
  planModeEnabled,
  isComposerOwned,
  keybindings,
  size = "sm",
  ...persistence
}: TraitsMenuContentProps & TraitsPersistence) {
  const modelSelection =
    instanceId && model ? { instanceId, model, options: modelOptions ?? [] } : null;
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  const updateModelOptions = (nextOptions: ProviderOptions | undefined) => {
    if ("onModelOptionsChange" in persistence) {
      persistence.onModelOptionsChange(nextOptions);
      return;
    }
    const threadTarget = persistence.threadRef ?? persistence.draftId;
    if (!threadTarget) {
      return;
    }
    setProviderModelOptions(threadTarget, provider, nextOptions, {
      ...(instanceId ? { instanceId } : {}),
      model,
      persistSticky: true,
    });
  };
  const selected = getTraitsSectionVisibility({
    provider,
    models,
    model,
    promptUltrathink,
    modelOptions,
    allowPromptInjectedEffort,
    planModeEnabled,
  });
  const {
    descriptors,
    selectDescriptors,
    primarySelectDescriptor,
    contextWindowDescriptor,
    contextWindowTokens,
    fastModeDescriptor,
    thinkingDescriptor,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
    hasAnyControls,
    modelIsUnavailable,
  } = selected;
  const updateDescriptors = (nextDescriptors: ReadonlyArray<ProviderOptionDescriptor>) => {
    updateModelOptions(buildProviderOptionSelectionsFromDescriptors(nextDescriptors));
  };

  const handleSelectChange = (
    descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
    value: string,
  ) => {
    // Whether a pick applies, and the options it writes, do not depend on the prompt text.
    const change = getTraitSelectChange(selected, descriptor, "", value);
    if (!change) return;
    onPromptEdit?.(
      (prompt) => getTraitSelectChange(selected, descriptor, prompt, value)?.prompt ?? prompt,
    );
    if ("modelOptions" in change) updateModelOptions(change.modelOptions);
  };

  const effortDescriptor =
    selectDescriptors.find(
      (descriptor) =>
        descriptor.id === primarySelectDescriptor?.id &&
        REASONING_SELECT_DESCRIPTOR_IDS.has(descriptor.id),
    ) ?? null;
  const effortOptions =
    effortDescriptor?.options.filter(
      (option) => !effortDescriptor.promptInjectedValues?.includes(option.id),
    ) ?? [];
  const effortValue =
    effortDescriptor && !ultrathinkPromptControlled
      ? (getDescriptorStringValue(effortDescriptor, modelSelection, reportedModelSelection) ?? "")
      : null;
  const showUltrathinkToggle =
    effortDescriptor?.promptInjectedValues?.includes("ultrathink") === true &&
    allowPromptInjectedEffort;
  const toggleUltrathink = (enabled: boolean) => {
    if (enabled) {
      onPromptEdit?.(
        (prompt) =>
          (effortDescriptor
            ? getTraitSelectChange(selected, effortDescriptor, prompt, "ultrathink")
            : null
          )?.prompt ?? prompt,
      );
      return;
    }
    onPromptEdit?.((prompt) => prompt.replace(/^Ultrathink:\s*/i, ""));
  };
  const otherSelectDescriptors = selectDescriptors.filter(
    (descriptor) =>
      descriptor.id !== effortDescriptor?.id && descriptor.id !== contextWindowDescriptor?.id,
  );
  const effortShortcut =
    isComposerOwned && keybindings ? shortcutLabelForCommand(keybindings, "composer.effort") : null;
  if (!hasAnyControls) {
    return null;
  }

  if (modelIsUnavailable) {
    return (
      <>
        {descriptors.map((descriptor, index) => {
          const value = getProviderOptionCurrentLabel(
            descriptor,
            modelSelection,
            reportedModelSelection,
          );
          if (!value) return null;
          return (
            <div key={descriptor.id}>
              {index > 0 ? <MenuDivider /> : null}
              <TraitsSectionHeader label={descriptor.label} />
              <div className="px-2 pb-1.5 text-(--t3) text-xs">{value}</div>
            </div>
          );
        })}
      </>
    );
  }

  const currentSelectValue = (descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>) =>
    getDescriptorStringValue(descriptor, modelSelection, reportedModelSelection) ??
    descriptor.options.find((option) => option.isDefault === true)?.id ??
    descriptor.options[0]?.id ??
    "";

  const renderSelectOptions = (
    descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
  ) => (
    <MenuPrimitive.RadioGroup
      value={currentSelectValue(descriptor)}
      onValueChange={(value) => handleSelectChange(descriptor, value)}
    >
      {selectableProviderOptionChoices(descriptor).map((option) => (
        <MenuPrimitive.RadioItem
          key={option.id}
          value={option.id}
          closeOnClick
          className="flex min-h-7 cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-(--t1) text-headline outline-none data-highlighted:bg-(--sel)"
        >
          <span className="flex w-full min-w-0 flex-col">
            <span className="flex min-w-0 items-center gap-1">
              <span className="min-w-0 truncate">{option.label}</span>
              {option.isDefault ? <DefaultBadge /> : null}
            </span>
            {option.description ? (
              <span className="max-w-56 text-pretty text-muted-foreground/80 text-xs">
                {option.description}
              </span>
            ) : null}
          </span>
        </MenuPrimitive.RadioItem>
      ))}
    </MenuPrimitive.RadioGroup>
  );

  return (
    <>
      {effortDescriptor && effortOptions.length > 1 ? (
        <div>
          <TraitsSectionHeader label={effortDescriptor.label} shortcut={effortShortcut} />
          <MenuPrimitive.RadioGroup
            value={effortValue ?? ""}
            onValueChange={(value) => handleSelectChange(effortDescriptor, value)}
            className="mx-1.5 mt-1 mb-1.5 flex gap-0.5 rounded-sm bg-(--field) p-0.5"
          >
            {effortOptions.map((option) => {
              const active = option.id === effortValue;
              return (
                <MenuPrimitive.RadioItem
                  key={option.id}
                  value={option.id}
                  disabled={ultrathinkInBodyText}
                  className={cn(
                    "flex h-5.5 min-h-0 flex-1 cursor-pointer items-center justify-center rounded-sm px-1 text-xs leading-5.5 outline-none",
                    active
                      ? "bg-(--raised) text-(--t1) shadow-(--shadow-seg)"
                      : "text-(--t2) data-highlighted:bg-(--raised) data-highlighted:text-(--t1)",
                  )}
                >
                  <span className="truncate">{shortEffortLabel(option.label, size === "xs")}</span>
                </MenuPrimitive.RadioItem>
              );
            })}
          </MenuPrimitive.RadioGroup>
        </div>
      ) : null}

      {ultrathinkInBodyText ? (
        <div className="px-2 pb-1.5 text-(--t3) text-xs">
          Your prompt contains &quot;ultrathink&quot; in the text. Remove it to change this option.
        </div>
      ) : null}

      {fastModeDescriptor ? (
        <TraitsToggleRow
          icon={<ZapIcon className="size-3.5" />}
          label="Fast mode"
          checked={fastModeDescriptor.currentValue === true}
          onCheckedChange={(checked) =>
            updateDescriptors(
              replaceDescriptorCurrentValue(descriptors, fastModeDescriptor.id, checked),
            )
          }
        />
      ) : null}

      {contextWindowDescriptor ? (
        <TraitsValueRow
          icon={<ChartNoAxesColumnIcon className="size-3.5" />}
          label="Context window"
          value={getProviderOptionCurrentLabel(
            contextWindowDescriptor,
            modelSelection,
            reportedModelSelection,
          )}
        >
          {renderSelectOptions(contextWindowDescriptor)}
        </TraitsValueRow>
      ) : contextWindowTokens !== null ? (
        <TraitsReadOnlyRow
          icon={<ChartNoAxesColumnIcon className="size-3.5" />}
          label="Context window"
          value={formatCompactContextWindowTokens(contextWindowTokens) ?? ""}
        />
      ) : null}

      {showUltrathinkToggle ? (
        <TraitsToggleRow
          icon={<ZapIcon className="size-3.5" />}
          label="Ultrathink"
          checked={ultrathinkPromptControlled}
          disabled={ultrathinkInBodyText}
          onCheckedChange={toggleUltrathink}
        />
      ) : null}

      {thinkingDescriptor ? (
        <TraitsToggleRow
          icon={<BrainIcon className="size-3.5" />}
          label={thinkingDescriptor.label}
          checked={thinkingDescriptor.currentValue === true}
          onCheckedChange={(checked) =>
            updateDescriptors(
              replaceDescriptorCurrentValue(descriptors, thinkingDescriptor.id, checked),
            )
          }
        />
      ) : null}

      {otherSelectDescriptors.length > 0 ? (
        <div>
          <MenuDivider />
          <MenuGroup>
            {otherSelectDescriptors.map((descriptor) => (
              <TraitsValueRow
                key={descriptor.id}
                label={descriptor.label}
                value={getProviderOptionCurrentLabel(
                  descriptor,
                  modelSelection,
                  reportedModelSelection,
                )}
              >
                {renderSelectOptions(descriptor)}
              </TraitsValueRow>
            ))}
          </MenuGroup>
        </div>
      ) : null}
    </>
  );
});

function ResponsiveEffortLabel(props: { label: string; responsive: boolean }) {
  const full = shortEffortLabel(props.label);
  const compact = shortEffortLabel(props.label, true);
  if (!props.responsive || full === compact) return <>{full}</>;
  return (
    <>
      <span className="@max-[560px]/composer-surface:hidden">{full}</span>
      <span className="hidden @max-[560px]/composer-surface:inline">{compact}</span>
    </>
  );
}

/** One bolt for Fast. Ultrafast adds an outlined echo behind it, cut away by the surface color. */
function FastBolt(props: { ultra: boolean }) {
  if (!props.ultra) {
    return (
      <ZapIcon aria-hidden="true" data-composer-control-icon className="size-3 fill-current" />
    );
  }
  return (
    <span aria-hidden="true" className="relative h-3 w-3.75 shrink-0">
      <ZapIcon className="absolute top-0 left-0.75 size-3" />
      <ZapIcon
        strokeWidth={4}
        className="absolute top-0 left-0 size-3 fill-current stroke-(--chat-composer-glass-surface) [paint-order:stroke]"
      />
    </span>
  );
}

export const TraitsPicker = memo(function TraitsPicker({
  provider,
  instanceId,
  models,
  model,
  promptUltrathink,
  onPromptEdit,
  modelOptions,
  reportedModelSelection,
  allowPromptInjectedEffort = true,
  planModeEnabled,
  triggerClassName,
  split,
  isComposerOwned,
  keybindings,
  effortDisplay = "label",
  extraMenuContent,
  extraMenuOwnsModeShortcut,
  extraMenuHint,
  size = "sm",
  hidden = false,
  disabled = false,
  ...persistence
}: TraitsMenuContentProps &
  TraitsPersistence & {
    size?: ComposerControlSize;
    hidden?: boolean;
    disabled?: boolean;
    /** Draws this trigger as the right half of the model/traits split control. */
    split?: TraitsSplitPart;
  }) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const [isMenuOpen, setIsMenuOpen] = useComposerMenuState(hidden || disabled);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const permissionsShortcut =
    isComposerOwned && keybindings ? shortcutLabelForCommand(keybindings, "composer.mode") : null;
  const { descriptors, primarySelectDescriptor, ultrathinkPromptControlled } =
    getTraitsSectionVisibility({
      provider,
      models,
      model,
      promptUltrathink,
      modelOptions,
      allowPromptInjectedEffort,
      planModeEnabled,
    });
  if (
    !shouldRenderTraitsControls({
      provider,
      models,
      model,
      promptUltrathink,
      modelOptions,
      allowPromptInjectedEffort,
      planModeEnabled,
    })
  ) {
    return null;
  }

  const {
    label: triggerLabel,
    speedLabel,
    otherLabels,
  } = buildTraitsTriggerDisplay({
    provider,
    descriptors,
    primarySelectDescriptorId: primarySelectDescriptor?.id ?? null,
    ultrathinkPromptControlled,
    modelSelection: instanceId && model ? { instanceId, model, options: modelOptions ?? [] } : null,
    reportedModelSelection,
  });
  const isCodexStyle = provider === "codex";
  // In the composer the glyph has no word, so the tooltip and label name the control.
  const triggerDescription = isComposerOwned
    ? [`Effort: ${triggerLabel}`, speedLabel, extraMenuHint].filter(Boolean).join(" · ")
    : triggerLabel;
  const effortGlyph =
    isComposerOwned &&
    primarySelectDescriptor &&
    REASONING_SELECT_DESCRIPTOR_IDS.has(primarySelectDescriptor.id)
      ? resolveEffortGlyph(
          primarySelectDescriptor,
          ultrathinkPromptControlled
            ? "ultrathink"
            : getDescriptorStringValue(
                primarySelectDescriptor,
                instanceId && model ? { instanceId, model, options: modelOptions ?? [] } : null,
                reportedModelSelection,
              ),
        )
      : null;
  // Workflow levels such as Ultracode always show their name; the setting names every level.
  // Traits the bars cannot show, such as an agent mode, appear as words in the composer.
  const effortWord = effortGlyph ? (
    effortGlyph.special !== null ? (
      effortGlyph.special
    ) : effortDisplay === "label" ? (
      <ResponsiveEffortLabel label={effortGlyph.label} responsive={isComposerOwned === true} />
    ) : null
  ) : isComposerOwned ? (
    triggerLabel
  ) : null;

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        setIsMenuOpen(open && !disabled);
      }}
      onOpenChangeComplete={(open) => focusRequestedPermission(open, triggerRef.current)}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <ComposerControl
                  ref={triggerRef}
                  disabled={disabled}
                  aria-label={triggerDescription}
                  data-composer-shortcut={
                    isComposerOwned
                      ? extraMenuOwnsModeShortcut
                        ? "composer.effort composer.mode"
                        : "composer.effort"
                      : undefined
                  }
                  size={size}
                  className={cn(
                    isCodexStyle
                      ? "min-w-0 max-w-40 shrink justify-start overflow-hidden whitespace-nowrap sm:max-w-48"
                      : "shrink-0 whitespace-nowrap",
                    triggerClassName,
                    traitsSplitTriggerClassName(split),
                    // The word is muted next to the model name and brightens like it on hover.
                    effortWord !== null &&
                      "text-muted-foreground hover:text-foreground data-pressed:text-foreground data-popup-open:text-foreground",
                  )}
                />
              }
            />
          }
        >
          {effortGlyph ? (
            <span className="flex items-center gap-1.5">
              <EffortGlyph count={effortGlyph.count} filled={effortGlyph.filled} size={size} />
              {effortWord !== null ? (
                <span data-composer-control-label>{effortWord}</span>
              ) : (
                <span data-composer-control-label className="sr-only">
                  {triggerLabel}
                </span>
              )}
              {speedLabel === "Fast" || speedLabel === "Ultrafast" ? (
                <FastBolt ultra={speedLabel === "Ultrafast"} />
              ) : null}
              {otherLabels.length > 0 ? (
                <span
                  aria-hidden="true"
                  // A label, so icon-only footers drop it; compacted rows drop it before the model.
                  data-composer-control-label
                  data-composer-secondary-trait
                  className="max-w-24 truncate text-xs"
                >
                  {otherLabels.join(" · ")}
                </span>
              ) : null}
            </span>
          ) : effortWord !== null ? (
            <>
              <span data-composer-control-label>{effortWord}</span>
              <GaugeIcon
                aria-hidden="true"
                data-composer-control-compact-icon
                className="invisible absolute size-3.5"
              />
            </>
          ) : isCodexStyle ? (
            <span
              className={cn(
                "flex min-w-0 w-full items-center",
                size === "xs" ? "gap-1" : "gap-1.5",
              )}
            >
              <ComposerControlIcon icon={GaugeIcon} size={size} />
              <span data-composer-control-label className="min-w-0 truncate">
                {triggerLabel}
              </span>
            </span>
          ) : (
            <>
              <ComposerControlIcon icon={GaugeIcon} size={size} />
              <span data-composer-control-label>{triggerLabel}</span>
            </>
          )}
        </TooltipTrigger>
        <TooltipPopup side="top">{triggerDescription}</TooltipPopup>
      </Tooltip>
      <MenuPopup
        align="start"
        className="w-[300px]"
        {...(isComposerOwned ? composerFloatingLayerProps : {})}
      >
        <TraitsMenuContent
          provider={provider}
          {...(instanceId ? { instanceId } : {})}
          models={models}
          model={model}
          promptUltrathink={promptUltrathink}
          {...(onPromptEdit ? { onPromptEdit } : {})}
          modelOptions={modelOptions}
          reportedModelSelection={reportedModelSelection}
          allowPromptInjectedEffort={allowPromptInjectedEffort}
          planModeEnabled={planModeEnabled}
          {...(keybindings ? { keybindings } : {})}
          size={size}
          {...persistence}
        />
        {extraMenuContent ? (
          <>
            <MenuDivider />
            <div
              data-composer-traits-extra
              className="[&_[data-composer-permissions]>div:first-child]:hidden"
            >
              <TraitsSectionHeader label="Permissions" shortcut={permissionsShortcut} />
              {extraMenuContent}
            </div>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});
