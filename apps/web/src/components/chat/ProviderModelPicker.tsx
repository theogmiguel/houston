import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type ProviderInstanceId,
  type EnvironmentId,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { memo, useRef, useState, type ReactNode } from "react";
import { BotIcon, ChevronDownIcon } from "lucide-react";
import { Badge } from "../ui/badge";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { ModelPickerContent, resolveModelPickerSelectedModel } from "./ModelPickerContent";
import { ChatGptSharingControl } from "./ChatGptSharingControl";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { ModelEsque, getDisplayModelName, getTriggerDisplayModelName } from "./providerIconUtils";
import { type ProviderInstanceEntry } from "../../providerInstances";
import { ComposerControl, type ComposerControlSize } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { shortcutLabelForCommand } from "../../keybindings";
import { traitsSplitTriggerClassName, type TraitsSplitPart } from "./modelTraits";

/** Holds the page still behind the open picker; its lifetime is the popup element's. */
function lockBackgroundScroll(popup: HTMLElement | null) {
  if (!popup) return;
  const { documentElement, body } = document;
  const previousDocumentOverscrollBehavior = documentElement.style.overscrollBehavior;
  const previousBodyOverflow = body.style.overflow;
  const previousBodyPaddingRight = body.style.paddingRight;
  const scrollbarWidth = window.innerWidth - documentElement.clientWidth;

  documentElement.style.overscrollBehavior = "contain";
  body.style.overflow = "hidden";
  if (scrollbarWidth > 0) {
    body.style.paddingRight = `${scrollbarWidth}px`;
  }

  const shouldAllowOverlayScroll = (target: EventTarget | null) => {
    return target instanceof Element && target.closest("[data-model-picker-content]");
  };
  const preventBackgroundWheel = (event: WheelEvent) => {
    if (shouldAllowOverlayScroll(event.target)) {
      return;
    }
    event.preventDefault();
  };
  const preventBackgroundTouchMove = (event: TouchEvent) => {
    if (shouldAllowOverlayScroll(event.target)) {
      return;
    }
    event.preventDefault();
  };

  document.addEventListener("wheel", preventBackgroundWheel, { capture: true, passive: false });
  document.addEventListener("touchmove", preventBackgroundTouchMove, {
    capture: true,
    passive: false,
  });

  return () => {
    document.removeEventListener("wheel", preventBackgroundWheel, { capture: true });
    document.removeEventListener("touchmove", preventBackgroundTouchMove, { capture: true });
    documentElement.style.overscrollBehavior = previousDocumentOverscrollBehavior;
    body.style.overflow = previousBodyOverflow;
    body.style.paddingRight = previousBodyPaddingRight;
  };
}

export const ProviderModelPicker = memo(function ProviderModelPicker(props: {
  environmentId: EnvironmentId | null;
  activeInstanceId: ProviderInstanceId;
  model: string;
  selectedModels?: ReadonlyArray<{ instanceId: ProviderInstanceId; model: string }>;
  onToggleModel?: (instanceId: ProviderInstanceId, model: string) => void;
  onSendSelectedModels?: (() => void) | undefined;
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings?: ResolvedKeybindingsConfig;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  activeProviderIconClassName?: string;
  instanceIndicatorBackground?: string;
  size?: ComposerControlSize;
  compact?: boolean;
  isComposerOwned?: boolean;
  /** The label no longer fits: keep the provider icon and the affordance, drop the text. */
  iconOnly?: boolean;
  /** Draws this trigger as the left half of the model/traits split control. */
  split?: TraitsSplitPart;
  disabled?: boolean;
  terminalOpen?: boolean;
  open?: boolean;
  triggerClassName?: string;
  triggerLabel?: string;
  triggerAriaLabel?: string;
  /** Extra menu content below the model list, such as access in a compact pane. */
  menuAccessory?: ReactNode;
  onOpenChange?: (open: boolean) => void;
  onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
}) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const [uncontrolledIsMenuOpen, setUncontrolledIsMenuOpen] = useState(false);
  const isMenuOpen = props.open ?? uncontrolledIsMenuOpen;
  const searchInputRef = useRef<HTMLInputElement>(null);
  const size = props.size ?? "sm";
  const iconOnly = props.iconOnly === true;

  const activeEntry =
    props.instanceEntries.find((entry) => entry.instanceId === props.activeInstanceId) ?? null;

  const activeInstanceId = props.activeInstanceId;
  const selectedInstanceOptions = props.modelOptionsByInstance.get(activeInstanceId) ?? [];
  const selectedModel =
    resolveModelPickerSelectedModel({
      driverKind: activeEntry?.driverKind,
      model: props.model,
      options: selectedInstanceOptions,
    }) ??
    (activeEntry?.driverKind === "opencode" || activeEntry?.driverKind === "antigravity"
      ? undefined
      : selectedInstanceOptions[0]);
  // The footer shows the catalog's short name, as the board's split control does.
  const triggerModelName = selectedModel
    ? getTriggerDisplayModelName(selectedModel, activeEntry?.driverKind)
    : null;
  const triggerTitle = triggerModelName
    ? triggerModelName
    : props.model === ANTIGRAVITY_DEFAULT_MODEL
      ? "Choose model"
      : props.model || "Choose model";
  const triggerLabel = selectedModel
    ? `${triggerModelName}${selectedModel.isUnavailable ? " (Unavailable)" : ""}`
    : triggerTitle;
  const setIsMenuOpen = (open: boolean) => {
    props.onOpenChange?.(open);
    if (props.open === undefined) {
      setUncontrolledIsMenuOpen(open);
    }
  };

  const handleInstanceModelChange = (instanceId: ProviderInstanceId, model: string) => {
    if (props.disabled) return;
    props.onInstanceModelChange(instanceId, model);
    setIsMenuOpen(false);
  };

  const shortcutLabel = props.keybindings
    ? shortcutLabelForCommand(props.keybindings, "modelPicker.toggle")
    : null;
  const selectedEntries = props.selectedModels?.map((selection) => {
    const entry = props.instanceEntries.find(
      (candidate) => candidate.instanceId === selection.instanceId,
    );
    const model = resolveModelPickerSelectedModel({
      driverKind: entry?.driverKind,
      model: selection.model,
      options: props.modelOptionsByInstance.get(selection.instanceId) ?? [],
    });
    const unavailable = model?.isUnavailable ? " (Unavailable)" : "";
    return {
      ...selection,
      entry,
      label: model
        ? `${getTriggerDisplayModelName(model, entry?.driverKind)}${unavailable}`
        : selection.model,
      fullLabel: model ? `${getDisplayModelName(model)}${unavailable}` : selection.model,
    };
  });
  const multipleLabel = selectedEntries
    ? selectedEntries.length === 0
      ? "Choose models"
      : `${selectedEntries
          .slice(0, 2)
          .map((selection) => selection.label)
          .join(", ")}${selectedEntries.length > 2 ? `, ${selectedEntries.length - 2} more` : ""}`
    : undefined;
  const allModelNames = selectedEntries
    ? selectedEntries.map((selection) => selection.fullLabel).join(", ") || "Choose models"
    : undefined;
  const triggerTooltipContent = shortcutLabel
    ? `${props.triggerLabel ?? allModelNames ?? triggerLabel} · ${shortcutLabel}`
    : (props.triggerLabel ?? allModelNames ?? triggerLabel);

  return (
    <Popover
      open={isMenuOpen}
      onOpenChange={(open) => {
        if (props.disabled) {
          setIsMenuOpen(false);
          return;
        }
        setIsMenuOpen(open);
      }}
    >
      <PopoverTrigger
        render={
          <ComposerControl
            aria-label={
              props.triggerAriaLabel ?? props.triggerLabel ?? allModelNames ?? triggerLabel
            }
            size={size}
            data-chat-provider-model-picker="true"
            data-chat-provider-model-picker-icon-only={iconOnly ? "true" : undefined}
            className={cn(
              "min-w-0 shrink justify-between whitespace-nowrap",
              props.compact
                ? "max-w-42 shrink-0"
                : !props.isComposerOwned && "max-w-48 sm:max-w-56",
              traitsSplitTriggerClassName(props.split),
              props.triggerClassName,
            )}
            disabled={props.disabled}
          />
        }
      >
        <span
          className={cn("flex min-w-0 flex-1 items-center", size === "xs" ? "gap-1" : "gap-1.5")}
        >
          {iconOnly ? (
            <span
              className="inline-flex shrink-0 items-center"
              data-chat-provider-model-picker-icon="true"
            >
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
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  className={cn("min-w-0 flex-1 overflow-hidden truncate", iconOnly && "sr-only")}
                  data-chat-provider-model-picker-label="true"
                />
              }
            >
              {props.triggerLabel ?? multipleLabel ?? triggerTitle}
            </TooltipTrigger>
            <TooltipPopup side="top">{triggerTooltipContent}</TooltipPopup>
          </Tooltip>
          {selectedModel?.isUnavailable && !selectedEntries && props.triggerLabel === undefined ? (
            <Badge variant="outline" size="sm">
              Unavailable
            </Badge>
          ) : null}
          <ChevronDownIcon aria-hidden className="size-3.25 shrink-0 text-(--t3)" />
        </span>
      </PopoverTrigger>
      <PopoverPopup
        {...(props.isComposerOwned ? composerFloatingLayerProps : {})}
        ref={lockBackgroundScroll}
        initialFocus={searchInputRef}
        align="start"
        className="before:hidden"
        padding="none"
        touchBackdrop
      >
        <ModelPickerContent
          searchInputRef={searchInputRef}
          environmentId={props.environmentId}
          activeInstanceId={activeInstanceId}
          model={props.model}
          {...(props.selectedModels !== undefined ? { selectedModels: props.selectedModels } : {})}
          {...(props.onToggleModel
            ? {
                onToggleModel: (instanceId: ProviderInstanceId, model: string) => {
                  if (!props.disabled) props.onToggleModel?.(instanceId, model);
                },
                ...(props.onSendSelectedModels
                  ? { onSendSelectedModels: props.onSendSelectedModels }
                  : {}),
              }
            : {})}
          lockedProvider={props.lockedProvider}
          lockedContinuationGroupKey={props.lockedContinuationGroupKey ?? null}
          instanceEntries={props.instanceEntries}
          {...(props.keybindings ? { keybindings: props.keybindings } : {})}
          modelOptionsByInstance={props.modelOptionsByInstance}
          terminalOpen={props.terminalOpen ?? false}
          onRequestClose={() => setIsMenuOpen(false)}
          {...(props.onOpenProviderSetup ? { onOpenProviderSetup: props.onOpenProviderSetup } : {})}
          getModelDisabledReason={(instanceId, model) =>
            props.disabled
              ? "Model picker is disabled"
              : (props.getModelDisabledReason?.(instanceId, model) ?? null)
          }
          onInstanceModelChange={handleInstanceModelChange}
        />
        {props.selectedModels === undefined ? (
          <ChatGptSharingControl provider={activeEntry?.snapshot ?? null} />
        ) : null}
        {props.menuAccessory}
      </PopoverPopup>
    </Popover>
  );
});
