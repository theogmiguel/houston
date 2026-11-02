import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type ProviderInstanceId,
  type EnvironmentId,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
<<<<<<< 57f5b2527b386f5e6f3426d989d40921b2199f5b
import { memo, useRef, useState, type ReactNode } from "react";
import { BotIcon, ChevronDownIcon } from "lucide-react";
=======
import { createContext, memo, type ReactNode, useRef, useState } from "react";
>>>>>>> e6e2ab05cceb3f8245e87f8499d4891f27de33cb
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
import { takeOpenTarget, useComposerMenuProps } from "./composerEventScope";
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
    return (
      target instanceof Element &&
      target.closest(
        "[data-model-picker-content], [data-model-picker-effort], [data-model-picker-option-menu]",
      )
    );
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

/** What a docked effort column needs from its picker: the model it serves. */
export const DockedPickerContext = createContext<{ modelLabel: string }>({ modelLabel: "" });

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
  popupAlign?: "start" | "end";
  triggerClassName?: string;
  triggerLabel?: string;
  triggerAriaLabel?: string;
  /** Extra menu content below the model list, such as access in a compact pane. */
  menuAccessory?: ReactNode;
  onOpenChange?: (open: boolean) => void;
  onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
  /** Shown after the model name inside the same trigger, such as the effort level. */
  triggerSuffix?: ReactNode;
  /** Names the suffix for the tooltip and screen readers. */
  triggerDetail?: string | null;
  /** Composer shortcuts this trigger answers besides the picker's own. */
  triggerShortcuts?: string;
  /**
   * Docks an effort column beside the list and a footer under both. The popup then stays open
   * until Escape or an outside press, and picking a model moves focus to its levels.
   */
  effortColumn?: ReactNode;
  footer?: ReactNode;
}) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const [uncontrolledIsMenuOpen, setUncontrolledIsMenuOpen] = useState(false);
  const isMenuOpen = props.open ?? uncontrolledIsMenuOpen;
  const searchInputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const size = props.size ?? "sm";
<<<<<<< 57f5b2527b386f5e6f3426d989d40921b2199f5b
  const iconOnly = props.iconOnly === true;
=======
  const docked = props.effortColumn !== undefined;
>>>>>>> e6e2ab05cceb3f8245e87f8499d4891f27de33cb

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

  /**
   * Focuses the selected reasoning level, else the first level. With `rows: "any"` it falls back
   * to the column's first enabled option. False when nothing took focus.
   */
  const focusEffort = (rows: "levels" | "any") => {
    const column = popupRef.current?.querySelector("[data-model-picker-effort]");
    const level =
      column?.querySelector<HTMLElement>(
        '[data-effort-level][aria-checked="true"]:not(:disabled)',
      ) ?? column?.querySelector<HTMLElement>("[data-effort-level]:not(:disabled)");
    // No aria-checked here: an On switch is checked but is not where focus belongs.
    const row =
      level ??
      (rows === "any"
        ? column?.querySelector<HTMLElement>("[data-effort-row]:not(:disabled)")
        : null);
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "nearest" });
    return row != null;
  };
  const openTarget = (target: "effort" | "permissions") => {
    if (target === "effort") {
      focusEffort("any");
      return;
    }
    popupRef.current
      ?.querySelector<HTMLButtonElement>("[data-composer-permissions-trigger]")
      ?.click();
  };

  const handleInstanceModelChange = (instanceId: ProviderInstanceId, model: string) => {
    if (props.disabled) return;
    props.onInstanceModelChange(instanceId, model);
    if (!docked) {
      setIsMenuOpen(false);
      return;
    }
    // The column renders the new model's levels on commit.
    window.requestAnimationFrame(() => focusEffort("levels"));
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
  const triggerTooltipContent = [
    props.triggerLabel ?? allModelNames ?? triggerLabel,
    props.triggerDetail,
    shortcutLabel,
  ]
    .filter(Boolean)
    .join(" · ");

  const triggerText = props.triggerLabel ?? multipleLabel ?? triggerTitle;
  const triggerTextProps = {
    className: cn(
      "min-w-0 flex-1 overflow-hidden truncate",
      // Long names such as "Fusion (Claude Opus 5.5 Medium + SWE-2 High)" would push the composer.
      props.isComposerOwned && "max-w-56",
    ),
    "data-chat-provider-model-picker-label": "true",
  } as const;

  const picker = (
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
      {...(docked
        ? {
            docked,
            onFocusEffort: () => void focusEffort("any"),
            // Inside the fixed height, so switching to or from a ChatGPT plan never resizes it.
            ...(props.selectedModels === undefined
              ? { listFooter: <ChatGptSharingControl provider={activeEntry?.snapshot ?? null} /> }
              : {}),
          }
        : {})}
    />
  );

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
      onOpenChangeComplete={(open) => {
        const target = takeOpenTarget(triggerRef.current);
        if (open && docked && target) openTarget(target);
      }}
    >
      <PopoverTrigger
        render={
          <ComposerControl
            ref={triggerRef}
            aria-label={[
              props.triggerAriaLabel ?? props.triggerLabel ?? allModelNames ?? triggerLabel,
              props.triggerDetail,
            ]
              .filter(Boolean)
              .join(", ")}
            size={size}
            data-chat-provider-model-picker="true"
<<<<<<< 57f5b2527b386f5e6f3426d989d40921b2199f5b
            data-chat-provider-model-picker-icon-only={iconOnly ? "true" : undefined}
=======
            data-composer-shortcut={props.triggerShortcuts}
            onClick={(event) => {
              if (!isMenuOpen || !docked) return;
              const target = takeOpenTarget(triggerRef.current);
              if (!target) return;
              // A shortcut aimed at the open picker moves within it instead of closing it.
              (
                event as typeof event & { preventBaseUIHandler?: () => void }
              ).preventBaseUIHandler?.();
              openTarget(target);
            }}
>>>>>>> e6e2ab05cceb3f8245e87f8499d4891f27de33cb
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
<<<<<<< 57f5b2527b386f5e6f3426d989d40921b2199f5b
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
=======
              {selectedEntries
                .slice(0, 3)
                .map((selection) =>
                  selection.entry ? (
                    <ProviderInstanceIcon
                      key={`${selection.instanceId}:${selection.model}`}
                      driverKind={selection.entry.driverKind}
                      displayName={selection.entry.displayName}
                      accentColor={selection.entry.accentColor}
                      acpRegistryAgentId={selection.entry.acpRegistryAgentId}
                      acpRegistryIconUrl={selection.entry.acpRegistryIconUrl}
                      className="size-4 rounded-full bg-(--chat-composer-glass-surface,var(--background)) ring-2 ring-(--chat-composer-glass-surface,var(--background))"
                      iconClassName="size-4"
                    />
                  ) : null,
                )}
              {selectedEntries.length > 3 ? (
                <span className="relative z-30 flex size-4 items-center justify-center rounded-full bg-(--chat-composer-glass-surface,var(--background)) text-3xs ring-2 ring-(--chat-composer-glass-surface,var(--background))">
                  +{selectedEntries.length - 3}
                </span>
              ) : null}
            </span>
          ) : activeEntry && props.triggerLabel === undefined ? (
            // Narrow compacted composers hide the provider icon before truncating the name.
            <span data-chat-provider-model-picker-icon className="contents">
              <ProviderInstanceIcon
                driverKind={activeEntry.driverKind}
                displayName={activeEntry.displayName}
                accentColor={activeEntry.accentColor}
                acpRegistryAgentId={activeEntry.acpRegistryAgentId}
                acpRegistryIconUrl={activeEntry.acpRegistryIconUrl}
                showBadge={showInstanceBadge}
                className="size-4"
                iconClassName={cn("size-4", props.activeProviderIconClassName)}
                indicatorBackground={props.instanceIndicatorBackground ?? "var(--contrast-input)"}
                badgeClassName={cn(
                  "right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 px-0.5 text-5xs",
                  size === "xs" && "shadow-none",
                )}
              />
            </span>
          ) : null}
          {props.isComposerOwned ? (
            <span {...triggerTextProps}>{triggerText}</span>
          ) : (
            <Tooltip>
              <TooltipTrigger render={<span {...triggerTextProps} />}>{triggerText}</TooltipTrigger>
              <TooltipPopup side="top">{triggerTooltipContent}</TooltipPopup>
            </Tooltip>
          )}
          {props.triggerSuffix}
>>>>>>> e6e2ab05cceb3f8245e87f8499d4891f27de33cb
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
        ref={(popup) => {
          popupRef.current = popup;
          const unlock = lockBackgroundScroll(popup);
          return () => {
            popupRef.current = null;
            unlock?.();
          };
        }}
        initialFocus={searchInputRef}
        align={props.popupAlign ?? "start"}
        collisionAvoidance={docked ? { align: "shift", fallbackAxisSide: "none" } : undefined}
        className="before:hidden"
        padding="none"
        touchBackdrop
      >
<<<<<<< 57f5b2527b386f5e6f3426d989d40921b2199f5b
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
=======
        {props.effortColumn ? (
          <DockedPickerContext value={{ modelLabel: triggerTitle }}>
            <div className="flex max-h-(--available-height) flex-col">
              {/* One fixed height, so a model with more options never resizes the popup. Short
                  windows shrink it and keep the footer. */}
              <div className="flex h-86.5 min-h-0 max-sm:h-auto max-sm:flex-col">
                {picker}
                <div
                  data-model-picker-effort
                  className="flex min-h-0 w-48 flex-col sm:shrink-0 border-l border-border/70 bg-muted/40 max-sm:h-64 max-sm:w-full max-sm:border-t max-sm:border-l-0"
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowLeft" || event.altKey || event.ctrlKey || event.metaKey)
                      return;
                    event.preventDefault();
                    event.stopPropagation();
                    searchInputRef.current?.focus();
                  }}
                >
                  {props.effortColumn}
                </div>
              </div>
              {props.footer}
            </div>
          </DockedPickerContext>
        ) : (
          picker
        )}
        {props.selectedModels === undefined && !docked ? (
>>>>>>> e6e2ab05cceb3f8245e87f8499d4891f27de33cb
          <ChatGptSharingControl provider={activeEntry?.snapshot ?? null} />
        ) : null}
        {props.menuAccessory}
      </PopoverPopup>
    </Popover>
  );
});
