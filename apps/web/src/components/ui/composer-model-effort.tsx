import {
  buildTraitsTriggerDisplay,
  getDescriptorStringValue,
  isReasoningSelect,
  selectableProviderOptionChoices,
} from "@houston-app/client-runtime/model-traits";
import type { ProviderOptionDescriptor, RuntimeMode } from "@houston-app/contracts";
import type { EffortDisplay } from "@houston-app/contracts/settings";
import { ChevronRightIcon } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useRef } from "react";

import { cn } from "~/lib/utils";
import { Menu, MenuPopup, MenuTrigger } from "./menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";
import type { ComposerControlSize } from "../chat/ComposerControl";
import { ComposerPermissionsSection, type RuntimeModeOption } from "../chat/ComposerFooterControls";
import { composerFloatingLayerProps, focusCheckedPermission } from "../chat/composerEventScope";
import { EffortGlyph, FastBolt, resolveEffortGlyph } from "../chat/EffortGlyph";
import {
  getTraitsSectionVisibility,
  type TraitsSelectionInput,
  ULTRATHINK_IN_BODY_NOTE,
  useTraitsSelection,
} from "../chat/TraitsPicker";

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;
type BooleanDescriptor = Extract<ProviderOptionDescriptor, { type: "boolean" }>;

/** Codex service tiers and Claude's Fast mode share the footer's speed control. */
function splitSpeed(
  provider: TraitsSelectionInput["provider"],
  selects: ReadonlyArray<SelectDescriptor>,
  toggles: ReadonlyArray<BooleanDescriptor>,
) {
  const speedSelect =
    provider === "codex"
      ? (selects.find((descriptor) => descriptor.id === "serviceTier") ?? null)
      : null;
  const fastToggle = toggles.find((descriptor) => descriptor.id === "fastMode") ?? null;
  return {
    speedSelect,
    fastToggle,
    columnSelects: selects.filter((descriptor) => descriptor !== speedSelect),
    columnToggles: toggles.filter((descriptor) => descriptor !== fastToggle),
  };
}

type ColumnControl =
  | { kind: "select"; descriptor: SelectDescriptor }
  | { kind: "boolean"; descriptor: BooleanDescriptor };

/**
 * The column lists the model's reasoning control first, under the header that names it, then
 * its other options.
 */
function columnControls(
  provider: TraitsSelectionInput["provider"],
  selects: ReadonlyArray<SelectDescriptor>,
  toggles: ReadonlyArray<BooleanDescriptor>,
) {
  const { columnSelects, columnToggles } = splitSpeed(provider, selects, toggles);
  const controls: ReadonlyArray<ColumnControl> = [
    ...columnSelects.map((descriptor) => ({ kind: "select" as const, descriptor })),
    ...columnToggles.map((descriptor) => ({ kind: "boolean" as const, descriptor })),
  ];
  const effort =
    controls.find(
      (control): control is Extract<ColumnControl, { kind: "select" }> =>
        control.kind === "select" && isReasoningSelect(control.descriptor),
    ) ?? null;
  return { effort, others: controls.filter((control) => control !== effort) };
}

/**
 * What the model trigger shows after the model name: the effort word (or bars, per the
 * Appearance setting), a bolt for Fast, and other traits such as a context window.
 */
export function describeComposerEffort(
  traits: TraitsSelectionInput | null,
  effortDisplay: EffortDisplay,
  size: ComposerControlSize,
): { suffix: ReactNode; detail: string | null } {
  if (!traits) return { suffix: null, detail: null };
  const visibility = getTraitsSectionVisibility(traits);
  if (!visibility.hasAnyControls) return { suffix: null, detail: null };
  const modelSelection =
    traits.instanceId && traits.model
      ? { instanceId: traits.instanceId, model: traits.model, options: traits.modelOptions ?? [] }
      : null;
  const primary = visibility.primarySelectDescriptor;
  const display = buildTraitsTriggerDisplay({
    provider: traits.provider,
    descriptors: visibility.descriptors,
    primarySelectDescriptorId: primary?.id ?? null,
    ultrathinkPromptControlled: visibility.ultrathinkPromptControlled,
    modelSelection,
    reportedModelSelection: traits.reportedModelSelection,
  });
  const glyph =
    primary && isReasoningSelect(primary)
      ? resolveEffortGlyph(
          primary,
          visibility.ultrathinkPromptControlled
            ? "ultrathink"
            : getDescriptorStringValue(primary, modelSelection, traits.reportedModelSelection),
        )
      : null;
  // Without a reasoning select the whole label is the word; it already names speed and the rest.
  // Workflow levels such as Ultracode always show their name; the setting names every level.
  const word = glyph
    ? (glyph.special ?? (effortDisplay === "label" ? glyph.label : null))
    : display.label;
  return {
    detail: display.label,
    suffix: (
      <span
        className={cn(
          "flex shrink-0 items-center gap-1.5 text-(--houston) group-hover/model-trigger:text-(--t1) group-data-popup-open/model-trigger:text-(--t1)",
          // A word space after the model name: the regular trigger's gap is wider than one.
          size === "sm" && "-ms-0.5",
        )}
      >
        {word !== null ? (
          <span data-composer-control-label>{word}</span>
        ) : glyph ? (
          <EffortGlyph count={glyph.count} filled={glyph.filled} size={size} />
        ) : null}
        {glyph && (display.speedLabel === "Fast" || display.speedLabel === "Ultrafast") ? (
          <FastBolt ultra={display.speedLabel === "Ultrafast"} />
        ) : null}
        {glyph && display.otherLabels.length > 0 ? (
          <span
            // A label, so icon-only footers drop it; compacted rows drop it before the model.
            data-composer-control-label
            data-composer-secondary-trait
            className="max-w-24 truncate text-xs"
          >
            {display.otherLabels.join(" · ")}
          </span>
        ) : null}
      </span>
    ),
  };
}

const CHIP =
  "flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-left text-(--t2) text-xs outline-none hover:bg-(--sel) hover:text-(--t1) focus-visible:bg-(--sel) focus-visible:text-(--t1) aria-checked:bg-(--sel) aria-checked:font-medium aria-checked:text-(--t1) disabled:cursor-not-allowed disabled:opacity-64";
const GROUP_LABEL = "w-14 shrink-0 pt-1.5 text-(--houston) text-2xs";

/**
 * The choices sit in one row that scrolls sideways, so a model with many levels never grows the
 * panel; the checked choice is scrolled into view when the row mounts.
 */
const OPTION_ROW_CLS =
  "flex flex-nowrap gap-0.5 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

function scrollCheckedIntoView(row: HTMLElement | null) {
  const checked = row?.querySelector<HTMLElement>('[aria-checked="true"]');
  if (!row || !checked) return;
  row.scrollLeft = checked.offsetLeft + checked.offsetWidth - row.clientWidth;
}

/** One labelled row of options: the label on the left, the choices in a scrolling row beside it. */
function OptionGroup(props: { label: string; children: ReactNode; note?: ReactNode }) {
  return (
    <div role="radiogroup" aria-label={props.label} className="flex items-start gap-1">
      <span aria-hidden="true" className={GROUP_LABEL}>
        {props.label}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {props.note}
        <div ref={scrollCheckedIntoView} className={OPTION_ROW_CLS}>
          {props.children}
        </div>
      </div>
    </div>
  );
}

function ColumnRow(props: {
  label: string;
  /** Shown on hover; the chip is too small to print it beside the label. */
  description?: string | undefined;
  selected: boolean;
  isDefault?: boolean | undefined;
  disabled?: boolean;
  /** A level of the reasoning control, where focus lands after a model pick. */
  level: boolean;
  onPick: () => void;
  icon?: ReactNode;
}) {
  const rowProps = {
    type: "button",
    role: "radio",
    "aria-checked": props.selected,
    disabled: props.disabled,
    "data-effort-row": true,
    "data-effort-level": props.level || undefined,
    // The reasoning control holds the panel's one tab stop; the arrow keys move between rows.
    tabIndex: props.selected && props.level ? 0 : -1,
    className: CHIP,
    onClick: props.onPick,
  } as const;
  const content = (
    <>
      {props.icon}
      {props.label}
      {props.isDefault ? <span className="sr-only">Default</span> : null}
    </>
  );
  if (!props.description) return <button {...rowProps}>{content}</button>;
  return (
    <Tooltip>
      <TooltipTrigger render={<button {...rowProps} />}>{content}</TooltipTrigger>
      <TooltipPopup side="top" className="max-w-56">
        {props.description}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * Arrow keys move through the rows in reading order. Going back from the first row is left to
 * the popup, which returns to the search field.
 */
function moveBetweenRows(event: KeyboardEvent<HTMLElement>) {
  const direction =
    event.key === "ArrowDown" || event.key === "ArrowRight"
      ? 1
      : event.key === "ArrowUp" || event.key === "ArrowLeft"
        ? -1
        : 0;
  if (direction === 0 || event.altKey || event.ctrlKey || event.metaKey) return;
  const rows = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-effort-row]:not(:disabled)"),
  );
  const index = rows.findIndex((row) => row === document.activeElement);
  if (direction === -1 && index <= 0) return;
  const next = rows[Math.min(rows.length - 1, index + direction)];
  if (!next) return;
  event.preventDefault();
  event.stopPropagation();
  next.focus();
  next.scrollIntoView({ block: "nearest" });
}

function EffortLevels(props: { traits: TraitsSelectionInput }) {
  const traits = useTraitsSelection(props.traits);
  const { effort, others } = columnControls(
    props.traits.provider,
    traits.selectDescriptors,
    traits.booleanDescriptors,
  );
  if (traits.modelIsUnavailable) {
    return (
      <>
        {traits.descriptors.map((descriptor) => {
          const value = traits.currentLabel(descriptor);
          return value ? (
            <div key={descriptor.id} className="flex items-start gap-1">
              <span className={GROUP_LABEL}>{descriptor.label}</span>
              <span className="pt-1.5 text-(--houston) text-xs">{value}</span>
            </div>
          ) : null;
        })}
      </>
    );
  }
  if (!effort && others.length === 0) return <NoEffortRow />;
  const renderControl = (control: ColumnControl) => {
    const isEffort = control === effort;
    const { descriptor } = control;
    if (control.kind === "boolean") {
      return (
        <OptionGroup key={descriptor.id} label={descriptor.label}>
          {([true, false] as const).map((value) => (
            <ColumnRow
              key={String(value)}
              label={value ? "On" : "Off"}
              selected={(control.descriptor.currentValue === true) === value}
              level={isEffort}
              onPick={() => traits.changeBoolean(descriptor.id, value)}
            />
          ))}
        </OptionGroup>
      );
    }
    const locked =
      descriptor.id === traits.primarySelectDescriptor?.id && traits.ultrathinkInBodyText;
    const value = traits.selectValue(control.descriptor);
    return (
      <OptionGroup
        key={descriptor.id}
        label={descriptor.label}
        note={
          locked ? (
            <span className="text-(--houston) text-xs">{ULTRATHINK_IN_BODY_NOTE}</span>
          ) : undefined
        }
      >
        {selectableProviderOptionChoices(control.descriptor).map((option) => (
          <ColumnRow
            key={option.id}
            label={option.label}
            selected={option.id === value}
            description={option.description}
            isDefault={option.isDefault}
            disabled={locked}
            level={isEffort}
            onPick={() => traits.changeSelect(control.descriptor, option.id)}
          />
        ))}
      </OptionGroup>
    );
  };
  return (
    <>
      {effort ? renderControl(effort) : null}
      {others.map(renderControl)}
    </>
  );
}

function NoEffortRow() {
  return (
    <div className="flex h-6 items-center ps-15 text-(--houston) text-xs">No effort levels</div>
  );
}

/** Codex service tiers and Claude's Fast mode, as one more row of the panel. */
function SpeedGroup(props: { traits: TraitsSelectionInput }) {
  const traits = useTraitsSelection(props.traits);
  const { speedSelect, fastToggle } = splitSpeed(
    props.traits.provider,
    traits.selectDescriptors,
    traits.booleanDescriptors,
  );
  if (traits.modelIsUnavailable || (!speedSelect && !fastToggle)) return null;
  const bolt = (label: string) =>
    label === "Fast" || label === "Ultrafast" ? <FastBolt ultra={label === "Ultrafast"} /> : null;
  return (
    <OptionGroup label={speedSelect?.label ?? fastToggle?.label ?? "Speed"}>
      {speedSelect
        ? selectableProviderOptionChoices(speedSelect).map((option) => (
            <ColumnRow
              key={option.id}
              label={option.label}
              icon={bolt(option.label)}
              selected={option.id === traits.selectValue(speedSelect)}
              description={option.description}
              level={false}
              onPick={() => traits.changeSelect(speedSelect, option.id)}
            />
          ))
        : fastToggle
          ? ([false, true] as const).map((value) => (
              <ColumnRow
                key={String(value)}
                label={value ? "Fast" : "Standard"}
                icon={value ? bolt("Fast") : null}
                selected={(fastToggle.currentValue === true) === value}
                level={false}
                onPick={() => traits.changeBoolean(fastToggle.id, value)}
              />
            ))
          : null}
    </OptionGroup>
  );
}

/** The model picker's effort panel: the selected model's levels, speed and other options. */
export function ComposerEffortPanel(props: { traits: TraitsSelectionInput | null }) {
  return (
    <div className="flex flex-col gap-1 px-3 py-2" onKeyDown={moveBetweenRows}>
      {props.traits ? (
        <>
          <EffortLevels traits={props.traits} />
          <SpeedGroup traits={props.traits} />
        </>
      ) : (
        <div className="flex items-start gap-1">
          <span className={GROUP_LABEL}>Effort</span>
          <span className="pt-1.5 text-(--houston) text-xs">No effort levels</span>
        </div>
      )}
    </div>
  );
}

/** The docked picker's frame, which the permissions submenu opens beside. */
function pickerFrameOf(trigger: HTMLElement | null): HTMLElement | null {
  return trigger?.closest<HTMLElement>("[data-docked-picker-frame]") ?? null;
}

/** Permissions change rarely, so the footer names the mode and nests the choice in a menu. */
function PermissionsMenu(props: {
  runtimeMode: RuntimeMode;
  options: ReadonlyArray<RuntimeModeOption>;
  onChange: (mode: RuntimeMode) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const current = props.options.find((option) => option.mode === props.runtimeMode);
  if (!current) return null;
  const CurrentIcon = current.icon;
  return (
    <Menu
      onOpenChangeComplete={(open) => {
        if (open) focusCheckedPermission(triggerRef.current);
      }}
    >
      <MenuTrigger
        render={
          <button
            ref={triggerRef}
            type="button"
            data-composer-permissions-trigger
            aria-label={`Permissions: ${current.label}`}
            className="ms-auto flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-(--houston) text-xs outline-none hover:bg-(--sel) hover:text-(--t1) focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-popup-open:bg-(--sel) data-popup-open:text-(--t1)"
          />
        }
      >
        <CurrentIcon aria-hidden="true" className="size-3.5" />
        {current.label}
        <ChevronRightIcon aria-hidden="true" className="size-3" />
      </MenuTrigger>
      {/* Beside the picker (the right, or the left without room), so it never covers the list or the search field. */}
      <MenuPopup
        side="right"
        align="end"
        sideOffset={6}
        anchor={() => pickerFrameOf(triggerRef.current) ?? triggerRef.current}
        {...composerFloatingLayerProps}
      >
        <ComposerPermissionsSection
          runtimeMode={props.runtimeMode}
          runtimeModeOptions={props.options}
          onRuntimeModeChange={props.onChange}
        />
      </MenuPopup>
    </Menu>
  );
}

/** The model picker's footer holds Permissions where no other control on screen does. */
export function ComposerPickerFooter(props: {
  runtimeMode: RuntimeMode;
  runtimeModeOptions: ReadonlyArray<RuntimeModeOption>;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  return (
    <div className="flex items-center border-t border-border bg-(--field) px-2 py-1">
      <PermissionsMenu
        runtimeMode={props.runtimeMode}
        options={props.runtimeModeOptions}
        onChange={props.onRuntimeModeChange}
      />
    </div>
  );
}
