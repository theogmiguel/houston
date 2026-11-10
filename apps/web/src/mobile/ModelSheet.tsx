import type {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderInteractionMode,
  ResolvedKeybindingsConfig,
  RuntimeMode,
} from "@houston-app/contracts";
import type { EffortDisplay } from "@houston-app/contracts/settings";
import { BotIcon, ChevronDownIcon } from "lucide-react";
import { memo, useRef } from "react";

import { ComposerControl } from "../components/chat/ComposerControl";
import {
  ComposerFooterModeControls,
  ComposerPermissionsPicker,
  type RuntimeModeOption,
} from "../components/chat/ComposerFooterControls";
import {
  ModelPickerContent,
  resolveModelPickerSelectedModel,
} from "../components/chat/ModelPickerContent";
import { getDisplayModelName } from "../components/chat/providerIconUtils";
import { ProviderInstanceIcon } from "../components/chat/ProviderInstanceIcon";
import {
  getTraitsSectionVisibility,
  type TraitsSelectionInput,
} from "../components/chat/TraitsPicker";
import {
  ComposerEffortPanel,
  describeComposerEffort,
} from "../components/ui/composer-model-effort";
import { PHONE_PLAN_ROW_CLS, PHONE_SHEET_SECTION_CLS } from "../components/ui/phone-recipes";
import { PhoneSheetHeader } from "../components/ui/phone-sheet-header";
import { Sheet, SheetPopup } from "../components/ui/sheet";
import type { AppModelOption } from "../modelSelection";
import type { ProviderInstanceEntry } from "../providerInstances";

/**
 * Phone composer picker: one chip names the current model and effort, and the sheet below it
 * hosts the desktop model list, effort panel and permissions picker unchanged.
 */
export const ModelSheet = memo(function ModelSheet(props: {
  environmentId: EnvironmentId;
  activeInstanceId: ProviderInstanceId;
  model: string;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>;
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey: string | null;
  keybindings: ResolvedKeybindingsConfig;
  terminalOpen: boolean;
  traits: TraitsSelectionInput | null;
  effortDisplay: EffortDisplay;
  runtimeMode: RuntimeMode;
  runtimeModeOptions: ReadonlyArray<RuntimeModeOption>;
  planModeUiEnabled: boolean;
  interactionMode: ProviderInteractionMode;
  onToggleInteractionMode: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onProviderModelSelect: (instanceId: ProviderInstanceId, model: string) => void;
  onOpenProviderSetup: (instanceId: ProviderInstanceId) => void;
  getModelDisabledReason: (instanceId: ProviderInstanceId, model: string) => string | null;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const activeEntry =
    props.instanceEntries.find((entry) => entry.instanceId === props.activeInstanceId) ?? null;
  const selectedModel = resolveModelPickerSelectedModel({
    driverKind: activeEntry?.driverKind,
    model: props.model,
    options: props.modelOptionsByInstance.get(props.activeInstanceId) ?? [],
  });
  const modelLabel = selectedModel
    ? `${getDisplayModelName(selectedModel)}${selectedModel.isUnavailable ? " (Unavailable)" : ""}`
    : props.model || "Choose model";
  const effort = describeComposerEffort(props.traits, props.effortDisplay, "sm");
  const showEffortPanel =
    props.traits !== null && getTraitsSectionVisibility(props.traits).hasAnyControls;
  const triggerLabel = [modelLabel, effort.detail].filter(Boolean).join(", ");

  return (
    <>
      <ComposerControl
        aria-label={triggerLabel}
        data-composer-shortcut="composer.effort composer.mode"
        data-phone-model-sheet-trigger="true"
        onClick={() => props.onOpenChange(true)}
        className="max-w-full min-w-0"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="inline-flex shrink-0 items-center">
            {activeEntry ? (
              <ProviderInstanceIcon
                driverKind={activeEntry.driverKind}
                displayName={activeEntry.displayName}
                accentColor={activeEntry.accentColor}
                acpRegistryAgentId={activeEntry.acpRegistryAgentId}
                acpRegistryIconUrl={activeEntry.acpRegistryIconUrl}
                badgeContent="none"
                size="compact"
                iconClassName="size-3.5"
              />
            ) : (
              <BotIcon aria-hidden="true" className="size-3.5" />
            )}
          </span>
          <span className="truncate" data-composer-control-label>
            {modelLabel}
          </span>
          {/* The model name outranks the effort word: a narrow composer drops the word first. */}
          <span className="contents @max-[22rem]/composer-surface:hidden">{effort.suffix}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3.25 shrink-0" />
        </span>
      </ComposerControl>
      <Sheet open={props.open} onOpenChange={props.onOpenChange}>
        <SheetPopup
          side="bottom"
          variant="phone"
          showCloseButton={false}
          data-phone-model-sheet="true"
        >
          <PhoneSheetHeader title="Model and permissions" />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ModelPickerContent
              docked
              phone
              searchInputRef={searchInputRef}
              environmentId={props.environmentId}
              activeInstanceId={props.activeInstanceId}
              model={props.model}
              lockedProvider={props.lockedProvider}
              lockedContinuationGroupKey={props.lockedContinuationGroupKey}
              instanceEntries={props.instanceEntries}
              keybindings={props.keybindings}
              modelOptionsByInstance={props.modelOptionsByInstance}
              terminalOpen={props.terminalOpen}
              onRequestClose={() => props.onOpenChange(false)}
              onOpenProviderSetup={props.onOpenProviderSetup}
              getModelDisabledReason={props.getModelDisabledReason}
              onInstanceModelChange={props.onProviderModelSelect}
            />
            {showEffortPanel ? (
              <div data-model-picker-effort className={PHONE_SHEET_SECTION_CLS}>
                <ComposerEffortPanel traits={props.traits} phone />
              </div>
            ) : null}
            {props.planModeUiEnabled ? (
              <div
                data-phone-plan-mode="true"
                className={`flex items-center justify-between gap-2 ${PHONE_PLAN_ROW_CLS}`}
              >
                <span>Plan mode</span>
                <ComposerFooterModeControls
                  showInteractionModeToggle
                  interactionMode={props.interactionMode}
                  runtimeMode={props.runtimeMode}
                  runtimeModeOptions={props.runtimeModeOptions}
                  accessDisplay="hidden"
                  onToggleInteractionMode={props.onToggleInteractionMode}
                  onRuntimeModeChange={props.onRuntimeModeChange}
                />
              </div>
            ) : null}
            <ComposerPermissionsPicker
              phone
              runtimeMode={props.runtimeMode}
              runtimeModeOptions={props.runtimeModeOptions}
              onRuntimeModeChange={props.onRuntimeModeChange}
            />
          </div>
        </SheetPopup>
      </Sheet>
    </>
  );
});
