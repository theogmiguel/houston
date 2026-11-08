import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type ProviderInstanceId,
  type EnvironmentId,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
} from "@houston-app/contracts";
import { memo, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { BotIcon, ChevronDownIcon } from "lucide-react";
import { Badge } from "../ui/badge";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { ModelPickerContent, resolveModelPickerSelectedModel } from "./ModelPickerContent";
import { ChatGptSharingControl } from "./ChatGptSharingControl";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { ModelEsque, getDisplayModelName } from "./providerIconUtils";
import { type ProviderInstanceEntry } from "../../providerInstances";
import { ComposerControl, type ComposerControlSize } from "./ComposerControl";
import { takeOpenTarget, useComposerMenuProps } from "./composerEventScope";
import { shortcutLabelForCommand } from "../../keybindings";
import { traitsSplitTriggerClassName, type TraitsSplitPart } from "./modelTraits";
import {
  DOCKED_EFFORT_PANEL_CLASS,
  DOCKED_PICKER_FRAME_CLASS,
  MODEL_TRIGGER_GROUP_CLASS,
} from "../ui/composer-picker-recipes";

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

/**
 * The composer card a docked picker lines up with: its left edge starts where the card's does, so
 * the context row under the card shows no chip edge beside the popup.
 */
function composerCardOf(trigger: HTMLElement | null): HTMLElement | null {
  return trigger?.closest<HTMLElement>('[data-inline-resting-controls="true"]') ?? null;
}

/** Space kept between a docked popup and the header it must not cross. */
const HEADER_CLEARANCE_PX = 8;

/**
 * Where a docked popup's top edge may start: just under the route header of the column the
 * picker sits in. A grid cell has no header, so it keeps the default collision padding.
 */
function headerClearanceOf(trigger: HTMLElement | null): number | null {
  const header = trigger
    ?.closest<HTMLElement>("[data-chat-column]")
    ?.querySelector<HTMLElement>("[data-chat-header]");
  if (!header) return null;
  return Math.ceil(header.getBoundingClientRect().bottom) + HEADER_CLEARANCE_PX;
}

/**
 * The docked popup's height with eight model rows, the search field and the effort panel,
 * measured in the browser; used until the open popup can be measured itself.
 */
const DOCKED_PICKER_FULL_HEIGHT_PX = 304;

/** The gap and collision padding the positioner keeps around the popup. */
const DOCKED_PICKER_EDGE_ROOM_PX = 9;

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
  /** The picker is open beside an effort panel; hide the panel when the model has no levels. */
  showEffortPanel?: boolean;
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
   * Docks an effort panel under the list and an optional footer under both. The popup then stays
   * open until Escape or an outside press, and picking a model moves focus to its levels.
   */
  effortPanel?: ReactNode;
  footer?: ReactNode;
}) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const [uncontrolledIsMenuOpen, setUncontrolledIsMenuOpen] = useState(false);
  const isMenuOpen = props.open ?? uncontrolledIsMenuOpen;
  const searchInputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const size = props.size ?? "sm";
  const iconOnly = props.iconOnly === true;
  const docked = props.effortPanel !== undefined;
  const [headerClearance, setHeaderClearance] = useState<number | null>(null);
  const [dockSide, setDockSide] = useState<"top" | "bottom">("bottom");
  // The new-thread page pins the popup under the card; the positioner must not flip it.
  const [dockPinned, setDockPinned] = useState(false);
  // A picker opened inside a grid cell lives in that cell: it opens toward the roomier side and
  // never spills past the cell's edges.
  const [cellBoundary, setCellBoundary] = useState<HTMLElement | null>(null);
  // The route header is a DOM node outside React, measured each time the popup opens (also when a
  // shortcut opens it through `props.open`, which no handler of this component sees).
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- measures the header's rect and the room under the card, which only the DOM knows
  useLayoutEffect(() => {
    if (!docked || !isMenuOpen) return;
    const trigger = triggerRef.current;
    setHeaderClearance(headerClearanceOf(trigger));
    const cell = trigger?.closest<HTMLElement>("[data-grid-cell]") ?? null;
    setCellBoundary(cell);
    const card = composerCardOf(trigger);
    if (card === null) {
      setDockSide("bottom");
      return;
    }
    const cardRect = card.getBoundingClientRect();
    const boundaryRect = cell?.getBoundingClientRect() ?? null;
    const topLimit = boundaryRect?.top ?? headerClearanceOf(trigger) ?? 0;
    const bottomLimit = boundaryRect?.bottom ?? window.innerHeight;
    const roomAbove = cardRect.top - topLimit;
    const roomBelow = bottomLimit - cardRect.bottom;
    const inDraftHero = card.closest("[data-draft-hero]") !== null;
    setDockPinned(inDraftHero);
    const needed =
      (popupRef.current?.scrollHeight ?? DOCKED_PICKER_FULL_HEIGHT_PX) + DOCKED_PICKER_EDGE_ROOM_PX;
    const fitsBelow = roomBelow >= needed;
    const fitsAbove = roomAbove >= needed;
    // The new-thread page always opens under the card; the list scrolls inside the height cap.
    // Elsewhere the side where the whole popup fits wins; with both or neither, the roomier one.
    const opensDownward = inDraftHero
      ? true
      : fitsBelow !== fitsAbove
        ? fitsBelow
        : roomAbove <= roomBelow;
    setDockSide(opensDownward ? "bottom" : "top");
  }, [docked, isMenuOpen]);

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
  // The trigger names the model exactly as its row in the list does.
  const triggerModelName = selectedModel ? getDisplayModelName(selectedModel) : null;
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
   * to the panel's other options. False when nothing took focus.
   */
  const focusEffort = (rows: "levels" | "any") => {
    const panel = popupRef.current?.querySelector("[data-model-picker-effort]");
    const first = (selector: string) =>
      panel?.querySelector<HTMLElement>(`${selector}[aria-checked="true"]:not(:disabled)`) ??
      panel?.querySelector<HTMLElement>(`${selector}:not(:disabled)`);
    const row =
      first("[data-effort-level]") ?? (rows === "any" ? first("[data-effort-row]") : null);
    row?.focus({ preventScroll: true });
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
    // The panel renders the new model's levels on commit.
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
      label: model ? `${getDisplayModelName(model)}${unavailable}` : selection.model,
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
      {...(docked ? { docked, onFocusEffort: () => void focusEffort("any") } : {})}
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
            data-chat-provider-model-picker-icon-only={iconOnly ? "true" : undefined}
            {...(iconOnly ? { title: triggerTooltipContent } : {})}
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
            className={cn(
              MODEL_TRIGGER_GROUP_CLASS,
              "min-w-0 shrink justify-between whitespace-nowrap",
              // A long model name truncates (its tooltip keeps the full name) instead of
              // stretching across the composer footer.
              props.compact
                ? "max-w-42 shrink-0"
                : props.isComposerOwned
                  ? "max-w-56"
                  : "max-w-48 sm:max-w-56",
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
          {/* The provider mark tells Claude, Codex and OpenCode models apart at a glance. */}
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
          {props.triggerSuffix}
          {selectedModel?.isUnavailable && !selectedEntries && props.triggerLabel === undefined ? (
            <Badge variant="outline" size="sm">
              Unavailable
            </Badge>
          ) : null}
          <ChevronDownIcon aria-hidden className="size-3.25 shrink-0 text-(--houston)" />
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
        align="start"
        {...(docked
          ? {
              anchor: () => composerCardOf(triggerRef.current) ?? triggerRef.current,
              // The side with more room; a tie opens downward.
              side: dockSide,
              ...(dockPinned ? { collisionAvoidance: { side: "none" } as const } : {}),
              ...(cellBoundary === null ? {} : { collisionBoundary: cellBoundary }),
              ...(headerClearance === null
                ? { collisionPadding: { top: 5, right: 5, bottom: 5, left: 5 } }
                : { collisionPadding: { top: headerClearance, right: 5, bottom: 5, left: 5 } }),
              sideOffset: 4,
            }
          : {})}
        className="before:hidden"
        padding="none"
        touchBackdrop
      >
        {props.effortPanel ? (
          <div className={DOCKED_PICKER_FRAME_CLASS}>
            {picker}
            {props.showEffortPanel === false ? null : (
              <div
                data-model-picker-effort
                className={DOCKED_EFFORT_PANEL_CLASS}
                onKeyDown={(event) => {
                  // Up and Left leave the panel for the search field; the panel's own rows handle
                  // the moves that stay inside it.
                  if (event.key !== "ArrowLeft" && event.key !== "ArrowUp") return;
                  if (event.altKey || event.ctrlKey || event.metaKey) return;
                  event.preventDefault();
                  event.stopPropagation();
                  searchInputRef.current?.focus();
                }}
              >
                {props.effortPanel}
              </div>
            )}
            {props.footer}
          </div>
        ) : (
          picker
        )}
        {props.selectedModels === undefined ? (
          <ChatGptSharingControl provider={activeEntry?.snapshot ?? null} />
        ) : null}
        {props.menuAccessory}
      </PopoverPopup>
    </Popover>
  );
});
