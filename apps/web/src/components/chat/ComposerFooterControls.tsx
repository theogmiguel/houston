import type {
  ModelSelection,
  ProviderInstanceId,
  ProviderInteractionMode,
  RuntimeMode,
} from "@houston-app/contracts";
import { createModelSelection } from "@houston-app/shared/model";
import { BotIcon, CheckIcon, PencilRulerIcon } from "lucide-react";
import { type ComponentProps, memo, useId, useRef } from "react";

import { cn } from "~/lib/utils";

import type { ContextWindowSnapshot } from "../../lib/contextWindow";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { focusRequestedPermission, useComposerMenuProps } from "./composerEventScope";
import { ComposerCompactBeforeSendChip, ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ContextWindowMeter, ContextWindowMeterPlaceholder } from "./ContextWindowMeter";
import { resolveModelPickerSelectedModel } from "./ModelPickerContent";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { runtimeModeConfig } from "./runtimeModeConfig";
import { useComposerMenuState } from "./useComposerMenuState";

export type RuntimeModeOption = {
  mode: RuntimeMode;
  disabledReason?: string;
} & (typeof runtimeModeConfig)[RuntimeMode];
const supervisedRuntimeModeOption: RuntimeModeOption = {
  mode: "approval-required" as const,
  ...runtimeModeConfig["approval-required"],
};
export const ComposerFooterModeControls = memo(function ComposerFooterModeControls(props: {
  showInteractionModeToggle: boolean;
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  runtimeModeOptions: ReadonlyArray<RuntimeModeOption>;
  size?: "sm" | "xs";
  hidden?: boolean;
  /** How the permissions chip shows: hidden while the thread matches the user's default. */
  accessDisplay?: "label" | "icon" | "hidden";
  /** Draw the icon in the label color, not muted (the mode differs from the user's default). */
  emphasized?: boolean;
  onToggleInteractionMode: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const size = props.size ?? "sm";
  const accessDisplay = props.accessDisplay ?? "label";
  const boardControlClassName = size === "sm" ? "h-6! gap-1! px-1.5! text-xs!" : undefined;
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const permissionsChipRef = useRef<HTMLButtonElement>(null);
  const runtimeModeOption =
    props.runtimeModeOptions.find((option) => option.mode === props.runtimeMode) ??
    supervisedRuntimeModeOption;
  const RuntimeModeIcon = runtimeModeOption.icon;
  const interactionModeTooltip =
    props.interactionMode === "plan"
      ? "Plan mode. Click to return to normal build mode"
      : "Default mode. Click to enter plan mode";

  const interactionModeToggle = props.showInteractionModeToggle ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <ComposerControl
            size={size}
            className={cn("shrink-0 whitespace-nowrap", boardControlClassName)}
            aria-pressed={props.interactionMode === "plan"}
            type="button"
            onClick={props.onToggleInteractionMode}
            aria-label={interactionModeTooltip}
          />
        }
      >
        {props.interactionMode === "plan" ? (
          <ComposerControlIcon
            icon={PencilRulerIcon}
            size={size}
            className="text-current opacity-100"
          />
        ) : (
          <ComposerControlIcon
            icon={BotIcon}
            size={size}
            opticalSize={size === "xs" ? "default" : "large"}
          />
        )}
        {/* The compacted row (xs) keeps this icon-only, like the other controls there. */}
        <span
          data-composer-control-label
          className={size === "xs" ? "sr-only" : "sr-only sm:not-sr-only"}
        >
          {props.interactionMode === "plan" ? "Plan" : "Build"}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="top">{interactionModeTooltip}</TooltipPopup>
    </Tooltip>
  ) : null;

  // The chip opens the same Permissions toggle used in the model picker and the overflow menu.
  const permissionsTooltip = `Permissions: ${runtimeModeOption.label}. ${runtimeModeOption.description}`;
  const permissionsChip = (
    <Menu
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(isOpen) =>
        focusRequestedPermission(isOpen, permissionsChipRef.current)
      }
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <ComposerControl
                  ref={permissionsChipRef}
                  data-composer-shortcut="composer.mode"
                  size={size}
                  // Mirrors the effort chip's trailing pe-1 so both gaps around the bars match.
                  className={cn("ps-1.5", boardControlClassName)}
                  aria-label={`Permissions: ${runtimeModeOption.label}`}
                />
              }
            />
          }
        >
          <ComposerControlIcon
            icon={RuntimeModeIcon}
            size={size}
            // Match the label, not full foreground: the chip's presence already marks the mode.
            {...(props.emphasized ? { className: "text-current" } : {})}
          />
          <span
            data-composer-control-label
            className={accessDisplay === "icon" ? "sr-only" : undefined}
          >
            {runtimeModeOption.label}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">{permissionsTooltip}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" {...composerFloatingLayerProps}>
        <ComposerPermissionsSection
          runtimeMode={props.runtimeMode}
          runtimeModeOptions={props.runtimeModeOptions}
          onRuntimeModeChange={props.onRuntimeModeChange}
        />
      </MenuPopup>
    </Menu>
  );

  return (
    <>
      {accessDisplay === "hidden" ? null : permissionsChip}
      {interactionModeToggle}
    </>
  );
});

/**
 * Permission modes as a labelled list: icon, name and a one-line description per mode, with a
 * check on the current one. Each row is a real menu radio item, so arrow keys reach it from the
 * rest of the menu and a pick closes the menu. Lives inside a Menu: the permissions chip, the
 * model picker, or the overflow menu.
 */
export function ComposerPermissionsSection(props: {
  runtimeMode: RuntimeMode;
  runtimeModeOptions: ReadonlyArray<RuntimeModeOption>;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const descriptionId = useId();
  return (
    <div data-composer-permissions className="grid w-72 gap-0.5 px-1 py-1.5">
      <div className="px-2 pb-1 font-medium text-muted-foreground text-xs">Permissions</div>
      <MenuPrimitive.RadioGroup
        aria-label="Permissions"
        value={props.runtimeMode}
        onValueChange={(value: RuntimeMode) => {
          if (value !== props.runtimeMode) props.onRuntimeModeChange(value);
        }}
        className="grid gap-0.5"
      >
        {props.runtimeModeOptions.map((option) => {
          const OptionIcon = option.icon;
          const description = option.disabledReason ?? option.description;
          return (
            <MenuPrimitive.RadioItem
              key={option.mode}
              value={option.mode}
              disabled={option.disabledReason !== undefined}
              label={option.label}
              aria-label={option.label}
              aria-describedby={`${descriptionId}-${option.mode}`}
              closeOnClick
              title={description}
              className="grid min-h-9 cursor-pointer grid-cols-[1rem_minmax(0,1fr)_1rem] items-center gap-x-2 rounded-md px-2 py-1 text-left outline-none data-disabled:cursor-not-allowed data-disabled:opacity-40 data-highlighted:bg-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            >
              <OptionIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
              <span className="grid min-w-0">
                <span className="truncate text-foreground text-sm leading-4">{option.label}</span>
                <span
                  id={`${descriptionId}-${option.mode}`}
                  className="truncate text-muted-foreground text-xs leading-4"
                >
                  {description}
                </span>
              </span>
              <MenuPrimitive.RadioItemIndicator className="flex size-4 items-center justify-center text-foreground">
                <CheckIcon aria-hidden="true" className="size-3.5" />
              </MenuPrimitive.RadioItemIndicator>
            </MenuPrimitive.RadioItem>
          );
        })}
      </MenuPrimitive.RadioGroup>
    </div>
  );
}

/** The same permissions picker as a plain radiogroup, for popovers outside a Menu root. */
export function ComposerPermissionsPicker(props: {
  runtimeMode: RuntimeMode;
  runtimeModeOptions: ReadonlyArray<
    { mode: RuntimeMode } & (typeof runtimeModeConfig)[RuntimeMode]
  >;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  return (
    <div data-composer-permissions className="grid w-72 gap-1.5 px-2 py-1.5">
      <div className="font-medium text-muted-foreground text-xs">Permissions</div>
      <div role="radiogroup" aria-label="Permissions" className="grid gap-0.5">
        {props.runtimeModeOptions.map((option) => {
          const OptionIcon = option.icon;
          const checked = option.mode === props.runtimeMode;
          return (
            <button
              key={option.mode}
              type="button"
              role="radio"
              aria-checked={checked}
              onClick={() => {
                if (!checked) props.onRuntimeModeChange(option.mode);
              }}
              className="flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-muted-foreground outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-checked:bg-input/72 aria-checked:text-foreground"
            >
              <OptionIcon aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-sm">{option.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export const ComposerFooterPrimaryActions = memo(function ComposerFooterPrimaryActions(props: {
  compact: boolean;
  canOperateThread: boolean;
  activeContextWindow: ContextWindowSnapshot | null;
  reserveContextWindowMeter: boolean;
  activeThreadModelDisplayName: string | null;
  isPreparingWorktree: boolean;
  pendingAction: {
    questionIndex: number;
    isLastQuestion: boolean;
    canAdvance: boolean;
    isResponding: boolean;
    isComplete: boolean;
  } | null;
  isRunning: boolean;
  /** When the running turn started; the stop button rings and names the elapsed time. */
  runningStartedAt?: string | null;
  /** The running thread's status word, such as "Waiting" while it is blocked on the user. */
  runningStateLabel?: string | null;
  canInterrupt: boolean;
  followUpBehavior: "queue" | "steer";
  canSteer: boolean;
  alternateShortcutLabel: string | null;
  showPlanFollowUpPrompt: boolean;
  promptHasText: boolean;
  voiceInputActive?: boolean;
  isSendBusy: boolean;
  sendDisabledReason: string | null;
  isEnvironmentUnavailable: boolean;
  hasSendableContent: boolean;
  canResume: boolean;
  preserveComposerFocusOnPointerDown?: boolean;
  isEditingQueuedMessage: boolean;
  onSubmitMessage: React.MouseEventHandler<HTMLButtonElement>;
  onResume: () => void;
  onPreviousPendingQuestion: () => void;
  onInterrupt: () => void;
  onImplementPlanInNewThread: () => void;
  onSubmitWithMode?: ((mode: "queue" | "steer" | "restart") => void) | undefined;
  onCompactContext?: (() => void) | undefined;
  compactDisabled: boolean;
  compactDisabledReason: string | null;
  compactBeforeSendTokens: number | null;
  keepFullHistory: boolean;
  onToggleKeepFullHistory: () => void;
}) {
  const showResume = props.canResume && !props.hasSendableContent && !props.isEditingQueuedMessage;
  const takesPrimaryActionSlot =
    props.pendingAction !== null ||
    (props.showPlanFollowUpPrompt && (props.promptHasText || !props.canResume)) ||
    (props.canInterrupt && !props.hasSendableContent && !props.isEditingQueuedMessage);
  const showCompactChip =
    !takesPrimaryActionSlot &&
    props.compactBeforeSendTokens !== null &&
    !showResume &&
    !props.isEditingQueuedMessage;
  return (
    <>
      {showCompactChip ? (
        <ComposerCompactBeforeSendChip
          tokens={props.compactBeforeSendTokens ?? 0}
          keepFullHistory={props.keepFullHistory}
          onToggleKeepFullHistory={props.onToggleKeepFullHistory}
          disabled={!props.canOperateThread}
          preserveComposerFocusOnPointerDown={props.preserveComposerFocusOnPointerDown ?? false}
        />
      ) : null}
      {props.activeContextWindow ? (
        <ContextWindowMeter
          usage={props.activeContextWindow}
          modelDisplayName={props.activeThreadModelDisplayName}
          onCompact={props.onCompactContext}
          compactDisabled={props.compactDisabled}
          compactDisabledReason={props.compactDisabledReason}
        />
      ) : props.reserveContextWindowMeter ? (
        <ContextWindowMeterPlaceholder />
      ) : null}
      <ComposerPrimaryActions
        compact={props.compact}
        canOperateThread={props.canOperateThread}
        pendingAction={props.pendingAction}
        isRunning={props.isRunning}
        runningStartedAt={props.runningStartedAt ?? null}
        runningStateLabel={props.runningStateLabel ?? null}
        canInterrupt={props.canInterrupt}
        followUpBehavior={props.followUpBehavior}
        canSteer={props.canSteer}
        alternateShortcutLabel={props.alternateShortcutLabel}
        showPlanFollowUpPrompt={props.showPlanFollowUpPrompt}
        promptHasText={props.promptHasText}
        voiceInputActive={props.voiceInputActive ?? false}
        isSendBusy={props.isSendBusy}
        sendDisabledReason={props.sendDisabledReason}
        isEnvironmentUnavailable={props.isEnvironmentUnavailable}
        isPreparingWorktree={props.isPreparingWorktree}
        hasSendableContent={props.hasSendableContent}
        canResume={props.canResume}
        preserveComposerFocusOnPointerDown={props.preserveComposerFocusOnPointerDown ?? false}
        isEditingQueuedMessage={props.isEditingQueuedMessage}
        onSubmitMessage={props.onSubmitMessage}
        onResume={props.onResume}
        onPreviousPendingQuestion={props.onPreviousPendingQuestion}
        onInterrupt={props.onInterrupt}
        onImplementPlanInNewThread={props.onImplementPlanInNewThread}
        onSubmitWithMode={props.onSubmitWithMode}
        compactBeforeSendTokens={props.compactBeforeSendTokens}
        keepFullHistory={props.keepFullHistory}
        onToggleKeepFullHistory={props.onToggleKeepFullHistory}
      />
    </>
  );
});

/**
 * The composer's model picker. It owns the single- and multi-model selection
 * handlers so they are cached against the selection state, not rebuilt on
 * every ChatComposer render.
 */
export function ComposerModelPicker({
  multipleModelsEnabled,
  multipleModelSelections,
  onMultipleModelSelectionsChange,
  onSendMultipleModels,
  selectedModelSelection,
  onProviderModelSelect,
  ...pickerProps
}: Omit<
  ComponentProps<typeof ProviderModelPicker>,
  "selectedModels" | "onToggleModel" | "onInstanceModelChange"
> & {
  readonly multipleModelsEnabled: boolean;
  readonly multipleModelSelections: ReadonlyArray<ModelSelection> | null;
  readonly onMultipleModelSelectionsChange: (
    selections: ReadonlyArray<ModelSelection> | null,
  ) => void;
  readonly onSendMultipleModels: () => void;
  readonly selectedModelSelection: ModelSelection;
  readonly onProviderModelSelect: (
    instanceId: ProviderInstanceId,
    model: string,
    options?: { focusComposer?: boolean },
  ) => void;
}) {
  const { instanceEntries, modelOptionsByInstance } = pickerProps;
  const toggleModel = (instanceId: ProviderInstanceId, model: string) => {
    const current = multipleModelSelections ?? [selectedModelSelection];
    const matchesModel = (selection: ModelSelection) => {
      if (selection.instanceId !== instanceId) return false;
      const entry = instanceEntries.find((entry) => entry.instanceId === selection.instanceId);
      const resolvedModel = resolveModelPickerSelectedModel({
        driverKind: entry?.driverKind,
        model: selection.model,
        options: modelOptionsByInstance?.get(selection.instanceId) ?? [],
      });
      return (resolvedModel?.slug ?? selection.model) === model;
    };
    const exists = current.some(matchesModel);
    const next = exists
      ? current.filter((selection) => !matchesModel(selection))
      : [...current, createModelSelection(instanceId, model)];
    if (next.length > 1) {
      onMultipleModelSelectionsChange(next);
    } else {
      onMultipleModelSelectionsChange(null);
      const remaining = next[0] ?? selectedModelSelection;
      onProviderModelSelect(remaining.instanceId, remaining.model, {
        focusComposer: false,
      });
    }
  };
  return (
    <ProviderModelPicker
      {...pickerProps}
      {...(multipleModelsEnabled
        ? {
            ...(multipleModelSelections !== null
              ? { selectedModels: multipleModelSelections }
              : {}),
            onToggleModel: toggleModel,
          }
        : {})}
      onSendSelectedModels={onSendMultipleModels}
      onInstanceModelChange={(instanceId, model) => {
        onMultipleModelSelectionsChange(null);
        onProviderModelSelect(instanceId, model);
      }}
    />
  );
}
