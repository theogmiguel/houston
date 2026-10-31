import type { ChatComposerProps } from "./ChatComposer";
import type { PromptUltrathink } from "./TraitsPicker";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { type AppModelOption } from "../../modelSelection";
import { CircleAlertIcon } from "lucide-react";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { ComposerControl } from "./ComposerControl";
import {
  ComposerPermissionsPicker,
  ComposerPermissionsSection,
  ComposerFooterModeControls,
  ComposerModelPicker,
  type RuntimeModeOption,
} from "./ComposerFooterControls";
import {
  type EnvironmentId,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";
import type { EffortDisplay } from "@t3tools/contracts/settings";
import { cn } from "~/lib/utils";
import { shortcutLabelForCommand } from "../../keybindings";
import {
  renderProviderTraitsMenuContent,
  renderProviderTraitsPicker,
} from "./composerProviderState";
import type { useComposerProviderModel } from "./useComposerProviderModel";
import { resolveComposerControlsOwnership } from "./composerControlsOwnership";
import {
  SPLIT_CONTROL_CLASS,
  SPLIT_DIVIDER_CLASS,
  traitsSplitTriggerClassName,
} from "./modelTraits";

/**
 * The composer footer controls: model picker, traits, mode controls and the overflow menu for
 * blocks that do not fit. Rendered in the expanded footer or the resting controls host.
 */
// Model and effort sit a word space apart, so hover and open states brighten text, not a box.
const TEXT_CONTROL_STATES =
  "hover:bg-transparent data-pressed:bg-transparent data-popup-open:bg-transparent data-pressed:text-foreground data-popup-open:text-foreground";

export function ComposerControlsBar(props: {
  environmentId: EnvironmentId;
  routeKind: ChatComposerProps["routeKind"];
  routeThreadRef: ChatComposerProps["routeThreadRef"];
  draftId: ChatComposerProps["draftId"];
  selectedProvider: ProviderDriverKind;
  selectedInstanceId: ProviderInstanceId;
  selectedModel: string;
  selectedProviderModels: ServerProvider["models"];
  composerModelOptions: ReturnType<typeof useComposerProviderModel>["composerModelOptions"];
  reportedModelSelection: ChatComposerProps["reportedModelSelection"];
  promptUltrathink: PromptUltrathink;
  onPromptEdit: (edit: (prompt: string) => string) => void;
  planModeEnabled: boolean;
  planModeUiEnabled: boolean;
  effortDisplay: EffortDisplay;
  /** The strip under a new thread names the permissions, so the row does not repeat them. */
  permissionsShownInStrip: boolean;
  interactionMode: ProviderInteractionMode;
  compatibleRuntimeMode: RuntimeMode;
  defaultRuntimeMode: RuntimeMode | undefined;
  compatibleRuntimeModeOptions: ReadonlyArray<RuntimeModeOption>;
  toggleInteractionMode: () => void;
  handleRuntimeModeChange: (mode: RuntimeMode) => void;
  composerControlsCollapsed: boolean;
  composerControlsHidden: boolean;
  paneDensity: ChatComposerProps["paneDensity"];
  restingHiddenBlockCount: number;
  iconOnlyBlockCount: number;
  /** The model label has dropped to its provider icon, ahead of any block moving to the menu. */
  modelIconOnly: boolean;
  showProviderUnavailable: boolean;
  providerSetupInstanceId: ProviderInstanceId | undefined;
  onOpenProviderSetup: ChatComposerProps["onOpenProviderSetup"];
  providerCatalogPending: boolean;
  isSendBusy: boolean;
  multipleModelsEnabled: boolean;
  multipleModelSelections: ChatComposerProps["multipleModelSelections"];
  onMultipleModelSelectionsChange: ChatComposerProps["onMultipleModelSelectionsChange"];
  onSendMultipleModels: () => void;
  selectedModelSelection: ModelSelection;
  onProviderModelSelect: ChatComposerProps["onProviderModelSelect"];
  activeThreadModelSelection: ChatComposerProps["activeThreadModelSelection"];
  selectedModelForPickerWithCustomFallback: string;
  lockedProvider: ChatComposerProps["lockedProvider"];
  lockedContinuationGroupKey: string | null;
  providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings: ChatComposerProps["keybindings"];
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>;
  terminalOpen: boolean;
  modelPickerOpen: boolean;
  onModelPickerOpenChange: (open: boolean) => void;
  modelPickerIconClassName: string | undefined;
  getModelDisabledReason: ChatComposerProps["getModelDisabledReason"];
}) {
  const {
    environmentId,
    routeKind,
    routeThreadRef,
    draftId,
    selectedProvider,
    selectedInstanceId,
    selectedModel,
    selectedProviderModels,
    composerModelOptions,
    reportedModelSelection,
    promptUltrathink,
    onPromptEdit,
    planModeEnabled,
    planModeUiEnabled,
    interactionMode,
    compatibleRuntimeMode,
    defaultRuntimeMode,
    compatibleRuntimeModeOptions,
    toggleInteractionMode,
    handleRuntimeModeChange,
    composerControlsCollapsed,
    composerControlsHidden,
    paneDensity,
    restingHiddenBlockCount: measuredHiddenBlockCount,
    iconOnlyBlockCount,
    modelIconOnly,
    showProviderUnavailable,
    providerSetupInstanceId,
    onOpenProviderSetup,
    providerCatalogPending,
    isSendBusy,
    multipleModelsEnabled,
    multipleModelSelections,
    onMultipleModelSelectionsChange,
    onSendMultipleModels,
    selectedModelSelection,
    onProviderModelSelect,
    activeThreadModelSelection,
    selectedModelForPickerWithCustomFallback,
    lockedProvider,
    lockedContinuationGroupKey,
    providerInstanceEntries,
    keybindings,
    modelOptionsByInstance,
    terminalOpen,
    modelPickerOpen,
    onModelPickerOpenChange,
    modelPickerIconClassName,
    getModelDisabledReason,
  } = props;
  const providerTraitsMenuContent = renderProviderTraitsMenuContent({
    provider: selectedProvider,
    instanceId: selectedInstanceId,
    ...(routeKind === "server" ? { threadRef: routeThreadRef } : {}),
    ...(routeKind === "draft" && draftId ? { draftId } : {}),
    model: selectedModel,
    models: selectedProviderModels,
    modelOptions: composerModelOptions?.[selectedInstanceId],
    reportedModelSelection,
    promptUltrathink,
    onPromptEdit,
    planModeEnabled,
  });
  const accessMatchesDefault = compatibleRuntimeMode === defaultRuntimeMode;
  const permissionsChipHidden = accessMatchesDefault || props.permissionsShownInStrip;
  const providerTraitsPickerInput = {
    provider: selectedProvider,
    instanceId: selectedInstanceId,
    ...(routeKind === "server" ? { threadRef: routeThreadRef } : {}),
    ...(routeKind === "draft" && draftId ? { draftId } : {}),
    model: selectedModel,
    models: selectedProviderModels,
    modelOptions: composerModelOptions?.[selectedInstanceId],
    reportedModelSelection,
    promptUltrathink,
    onPromptEdit,
    planModeEnabled,
    isComposerOwned: true,
    keybindings,
    effortDisplay: props.effortDisplay,
    triggerClassName: cn(traitsSplitTriggerClassName("end"), "ps-1.5 pe-1", TEXT_CONTROL_STATES),
    // Permissions always live in the effort menu, so the section never unmounts while open.
    extraMenuContent: (
      <ComposerPermissionsSection
        runtimeMode={compatibleRuntimeMode}
        runtimeModeOptions={compatibleRuntimeModeOptions}
        onRuntimeModeChange={handleRuntimeModeChange}
      />
    ),
    ...(permissionsChipHidden
      ? {
          extraMenuHint: [
            `Permissions: ${
              compatibleRuntimeModeOptions.find((option) => option.mode === compatibleRuntimeMode)
                ?.label ?? compatibleRuntimeMode
            }`,
            shortcutLabelForCommand(keybindings, "composer.mode"),
          ]
            .filter(Boolean)
            .join(" · "),
        }
      : {}),
  } satisfies Parameters<typeof renderProviderTraitsPicker>[0];
  const providerTraitsPicker = renderProviderTraitsPicker(providerTraitsPickerInput);
  const {
    accessDisplay,
    showModeBlock,
    hiddenBlockCount: restingHiddenBlockCount,
    hiddenBlockIds: hiddenRestingBlockIds,
    traitsHidden: traitsBlockHidden,
    effortOwnsModeShortcut,
    overflowShowsPermissions,
  } = resolveComposerControlsOwnership({
    matchesDefault: permissionsChipHidden,
    hasTraits: providerTraitsPicker !== null,
    planModeUiEnabled,
    collapsed: composerControlsCollapsed,
    measuredHiddenBlockCount,
  });
  const restingProviderTraitsPicker = renderProviderTraitsPicker({
    ...providerTraitsPickerInput,
    size: composerControlsCollapsed ? "xs" : "sm",
    hidden: composerControlsHidden || traitsBlockHidden,
    extraMenuOwnsModeShortcut: effortOwnsModeShortcut,
  });
  const compactPane = paneDensity === "compact";
  const restingBlockDefs = compactPane
    ? []
    : [
        ...(providerTraitsPicker
          ? [
              {
                id: "traits",
                content: restingProviderTraitsPicker,
              },
            ]
          : []),
        ...(!showModeBlock
          ? []
          : [
              {
                id: "mode",
                content: (
                  <ComposerFooterModeControls
                    showInteractionModeToggle={planModeUiEnabled}
                    interactionMode={interactionMode}
                    runtimeMode={compatibleRuntimeMode}
                    runtimeModeOptions={compatibleRuntimeModeOptions}
                    size={composerControlsCollapsed ? "xs" : "sm"}
                    hidden={composerControlsHidden || restingHiddenBlockCount > 0}
                    accessDisplay={accessDisplay}
                    emphasized={!accessMatchesDefault}
                    onToggleInteractionMode={toggleInteractionMode}
                    onRuntimeModeChange={handleRuntimeModeChange}
                  />
                ),
              },
            ]),
      ];
  const traitsBlockIndex = restingBlockDefs.findIndex((def) => def.id === "traits");
  const traitsBlockInOverflow =
    traitsBlockIndex >= 0 && traitsBlockIndex >= restingBlockDefs.length - restingHiddenBlockCount;
  // Its own element, so typing (which rebuilds the controls around it) leaves it cached.
  const composerModelPicker = (
    <ComposerModelPicker
      environmentId={environmentId}
      compact={false}
      isComposerOwned
      iconOnly={modelIconOnly}
      {...(traitsBlockIndex >= 0 && !traitsBlockInOverflow ? { split: "start" as const } : {})}
      disabled={providerCatalogPending || isSendBusy}
      multipleModelsEnabled={multipleModelsEnabled}
      multipleModelSelections={multipleModelSelections}
      onMultipleModelSelectionsChange={onMultipleModelSelectionsChange}
      onSendMultipleModels={onSendMultipleModels}
      selectedModelSelection={selectedModelSelection}
      onProviderModelSelect={onProviderModelSelect}
      activeInstanceId={
        providerCatalogPending
          ? (activeThreadModelSelection?.instanceId ?? selectedInstanceId)
          : selectedInstanceId
      }
      model={
        providerCatalogPending
          ? (activeThreadModelSelection?.model ?? selectedModelForPickerWithCustomFallback)
          : selectedModelForPickerWithCustomFallback
      }
      lockedProvider={lockedProvider}
      lockedContinuationGroupKey={lockedContinuationGroupKey}
      instanceEntries={providerInstanceEntries}
      keybindings={keybindings}
      modelOptionsByInstance={modelOptionsByInstance}
      size={composerControlsCollapsed ? "xs" : "sm"}
      triggerClassName={cn(
        "pe-1",
        TEXT_CONTROL_STATES,
        composerControlsCollapsed ? "min-w-13 shrink text-xs!" : "min-w-13",
      )}
      terminalOpen={terminalOpen}
      open={modelPickerOpen}
      instanceIndicatorBackground={
        composerControlsCollapsed
          ? "color-mix(in srgb, var(--chat-composer-glass-surface) var(--glass-opacity), transparent)"
          : "var(--contrast-input)"
      }
      {...(modelPickerIconClassName
        ? { activeProviderIconClassName: modelPickerIconClassName }
        : {})}
      onOpenChange={onModelPickerOpenChange}
      getModelDisabledReason={getModelDisabledReason}
      onOpenProviderSetup={onOpenProviderSetup}
      {...(compactPane
        ? {
            menuAccessory: (
              <ComposerPermissionsPicker
                runtimeMode={compatibleRuntimeMode}
                runtimeModeOptions={compatibleRuntimeModeOptions}
                onRuntimeModeChange={handleRuntimeModeChange}
              />
            ),
          }
        : {})}
    />
  );
  const overflowHidden = compactPane || hiddenRestingBlockIds.length === 0;
  return showProviderUnavailable ? (
    <ComposerControl
      type="button"
      disabled={!providerSetupInstanceId}
      onClick={() => {
        if (providerSetupInstanceId) {
          onOpenProviderSetup(providerSetupInstanceId);
        }
      }}
      data-chat-provider-unavailable="true"
      className="h-6! shrink-0 gap-1.5! px-1.5! text-(--warn)! text-xs!"
    >
      <CircleAlertIcon className="size-4" />
      {providerSetupInstanceId ? "Open provider settings" : "No provider available"}
    </ComposerControl>
  ) : (
    <>
      <span
        data-composer-split-control={
          traitsBlockIndex >= 0 && !traitsBlockInOverflow ? "true" : undefined
        }
        className={SPLIT_CONTROL_CLASS}
      >
        {composerModelPicker}
        {traitsBlockIndex >= 0 ? (
          <>
            {traitsBlockInOverflow ? null : (
              <span
                aria-hidden="true"
                data-resting-controls-separator="true"
                className={SPLIT_DIVIDER_CLASS}
              />
            )}
            {(() => {
              const def = restingBlockDefs[traitsBlockIndex]!;
              const hidden = traitsBlockIndex >= restingBlockDefs.length - restingHiddenBlockCount;
              return (
                <div
                  key={def.id}
                  data-resting-block={def.id}
                  data-composer-block-icon-only={
                    traitsBlockIndex >= restingBlockDefs.length - iconOnlyBlockCount
                      ? "true"
                      : "false"
                  }
                  aria-hidden={hidden || undefined}
                  inert={hidden || undefined}
                  className={cn(
                    "flex w-max min-w-max shrink-0 items-center gap-1",
                    hidden && "pointer-events-none invisible absolute",
                    traitsBlockIndex >= restingBlockDefs.length - iconOnlyBlockCount &&
                      "[&_[data-composer-control-label]]:pointer-events-none [&_[data-composer-control-label]]:invisible [&_[data-composer-control-label]]:absolute [&_[data-composer-control-label]]:w-max [&_[data-composer-control-label]]:max-w-none [&_[data-composer-control-compact-icon]]:[visibility:inherit] [&_[data-composer-control-compact-icon]]:relative",
                  )}
                >
                  {def.content}
                </div>
              );
            })()}
          </>
        ) : null}
      </span>

      <>
        {restingBlockDefs.map((def, index) => {
          if (def.id === "traits") return null;
          const hidden = index >= restingBlockDefs.length - restingHiddenBlockCount;
          return (
            <div
              key={def.id}
              data-resting-block={def.id}
              data-composer-block-icon-only={
                index >= restingBlockDefs.length - iconOnlyBlockCount ? "true" : "false"
              }
              aria-hidden={hidden || undefined}
              inert={hidden || undefined}
              className={cn(
                "flex w-max min-w-max shrink-0 items-center gap-1",
                hidden && "pointer-events-none invisible absolute",
                index >= restingBlockDefs.length - iconOnlyBlockCount &&
                  "[&_[data-composer-control-label]]:pointer-events-none [&_[data-composer-control-label]]:invisible [&_[data-composer-control-label]]:absolute [&_[data-composer-control-label]]:w-max [&_[data-composer-control-label]]:max-w-none [&_[data-composer-control-compact-icon]]:[visibility:inherit] [&_[data-composer-control-compact-icon]]:relative",
              )}
            >
              {def.content}
            </div>
          );
        })}
        <div
          data-resting-controls-overflow
          aria-hidden={overflowHidden || undefined}
          inert={overflowHidden || undefined}
          className={cn(
            "min-w-0 shrink-0",
            overflowHidden && "pointer-events-none invisible absolute",
          )}
        >
          <CompactComposerControlsMenu
            interactionMode={interactionMode}
            runtimeMode={compatibleRuntimeMode}
            runtimeModeOptions={compatibleRuntimeModeOptions}
            size={composerControlsCollapsed ? "xs" : "sm"}
            hidden={composerControlsHidden || overflowHidden}
            showInteractionModeToggle={planModeUiEnabled && hiddenRestingBlockIds.includes("mode")}
            traitsMenuContent={
              hiddenRestingBlockIds.includes("traits") ? providerTraitsMenuContent : undefined
            }
            // Permissions join the overflow only when their normal home is in it.
            showPermissions={overflowShowsPermissions}
            onToggleInteractionMode={toggleInteractionMode}
            onRuntimeModeChange={handleRuntimeModeChange}
          />
        </div>
      </>
    </>
  );
}
