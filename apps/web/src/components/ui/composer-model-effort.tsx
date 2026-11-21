import {
  buildTraitsTriggerDisplay,
  getDescriptorStringValue,
  isReasoningSelect,
  selectableProviderOptionChoices,
} from "@houston-app/client-runtime/model-traits";
import type { ProviderOptionDescriptor, RuntimeMode } from "@houston-app/contracts";
import type { EffortDisplay } from "@houston-app/contracts/settings";
import { WorkflowIcon } from "lucide-react";
import { useT } from "~/i18n/useT";
import {
  createContext,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useContext,
} from "react";

import { cn } from "~/lib/utils";
import { PHONE_SHEET_SECTION_LABEL_CLS } from "./phone-recipes";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";
import type { ComposerControlSize } from "../chat/ComposerControl";
import {
  moveBetweenPermissionSegments,
  supervisedRuntimeModeOption,
  type RuntimeModeOption,
} from "../chat/ComposerFooterControls";
import {
  PICKER_CHIP_SEGMENT_CLS,
  PICKER_CHIP_TRACK_CLS,
  PICKER_SEGMENT_ACCENT_CLS,
  PICKER_SEGMENT_CLS,
  PICKER_SEGMENT_TRACK_CLS,
} from "./composer-picker-recipes";
import { getDisplayModelName } from "../chat/providerIconUtils";
import { composerFloatingLayerProps } from "../chat/composerEventScope";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "./menu";
import { EffortGlyph, FastBolt, resolveEffortGlyph } from "../chat/EffortGlyph";
import {
  getTraitsSectionVisibility,
  type TraitsSelectionInput,
  ULTRATHINK_IN_BODY_NOTE,
  useTraitsSelection,
} from "../chat/TraitsPicker";

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;
type BooleanDescriptor = Extract<ProviderOptionDescriptor, { type: "boolean" }>;

/** Codex service tiers, Claude's Fast mode, and Ultracode sit in the footer, not the column. */
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
  const ultracodeToggle = toggles.find((descriptor) => descriptor.id === "ultracode") ?? null;
  return {
    speedSelect,
    fastToggle,
    ultracodeToggle,
    columnSelects: selects.filter((descriptor) => descriptor !== speedSelect),
    columnToggles: toggles.filter(
      (descriptor) => descriptor !== fastToggle && descriptor !== ultracodeToggle,
    ),
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
 * Appearance setting), a bolt for Fast, a workflow icon for Ultracode, and other traits such as a
 * context window.
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
        {display.ultracode ? (
          <WorkflowIcon aria-hidden="true" data-composer-control-icon className="size-3" />
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
const PHONE_CHIP = "h-11 px-3 text-sm";

/** The phone sheet sizes every effort chip to a 44px tap target. */
const EffortPhoneContext = createContext(false);

/** One labelled row of options: the label on the left, the choices wrapping beside it. */
function OptionGroup(props: { label: string; children: ReactNode; note?: ReactNode }) {
  const phone = useContext(EffortPhoneContext);
  return (
    <div
      role="radiogroup"
      aria-label={props.label}
      className={cn("flex gap-1", phone ? "flex-col" : "items-start")}
    >
      <span
        aria-hidden="true"
        className={phone ? cn(PHONE_SHEET_SECTION_LABEL_CLS, "pt-1") : GROUP_LABEL}
      >
        {props.label}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {props.note}
        <div className="flex flex-wrap gap-0.5">{props.children}</div>
      </div>
    </div>
  );
}

/**
 * One setting as a header line over a full-width segmented control: the muted label on the left,
 * an optional detail (the selected model's name) on the right.
 */
function SegmentedGroup(props: {
  label: string;
  detail?: string | null | undefined;
  children: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span aria-hidden="true" className="shrink-0 text-(--houston)">
          {props.label}
        </span>
        {props.detail ? (
          <span className="min-w-0 truncate text-(--t2)" data-model-picker-effort-model="true">
            {props.detail}
          </span>
        ) : null}
      </div>
      {props.note}
      <div role="radiogroup" aria-label={props.label} className={PICKER_SEGMENT_TRACK_CLS}>
        {props.children}
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
  /** Draws the row as an equal-width segment of a segmented control instead of a wrapping chip. */
  segment?: boolean;
}) {
  const phone = useContext(EffortPhoneContext);
  const rowProps = {
    type: "button",
    role: "radio",
    "aria-checked": props.selected,
    disabled: props.disabled,
    "data-effort-row": true,
    "data-effort-level": props.level || undefined,
    // The reasoning control holds the panel's one tab stop; the arrow keys move between rows.
    tabIndex: props.selected && props.level ? 0 : -1,
    "data-checked": props.selected || undefined,
    className: props.segment
      ? cn(PICKER_SEGMENT_CLS, props.level && PICKER_SEGMENT_ACCENT_CLS)
      : phone
        ? cn(CHIP, PHONE_CHIP)
        : CHIP,
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

function EffortLevels(props: { traits: TraitsSelectionInput; phone: boolean }) {
  const t = useT();
  const traits = useTraitsSelection(props.traits);
  const selectedModel = props.traits.models.find((model) => model.slug === props.traits.model);
  const modelName = selectedModel ? getDisplayModelName(selectedModel) : null;
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
  if (!effort && others.length === 0) {
    return props.phone ? <NoEffortRow /> : <NoReasoningRow modelName={modelName} />;
  }
  const renderControl = (control: ColumnControl) => {
    const isEffort = control === effort;
    const { descriptor } = control;
    const Group = props.phone ? OptionGroup : SegmentedGroup;
    const groupLabel = props.phone || !isEffort ? descriptor.label : REASONING_LABEL;
    const groupDetail = isEffort ? modelName : null;
    if (control.kind === "boolean") {
      return (
        <Group
          key={descriptor.id}
          label={groupLabel}
          {...(props.phone ? {} : { detail: groupDetail })}
        >
          {([true, false] as const).map((value) => (
            <ColumnRow
              key={String(value)}
              label={value ? t("On") : t("Off")}
              selected={(control.descriptor.currentValue === true) === value}
              level={isEffort}
              segment={!props.phone}
              onPick={() => traits.changeBoolean(descriptor.id, value)}
            />
          ))}
        </Group>
      );
    }
    const locked =
      descriptor.id === traits.primarySelectDescriptor?.id && traits.ultrathinkInBodyText;
    const value = traits.selectValue(control.descriptor);
    return (
      <Group
        key={descriptor.id}
        label={groupLabel}
        {...(props.phone ? {} : { detail: groupDetail })}
        note={
          locked ? (
            <span className="text-(--houston) text-xs">{t(ULTRATHINK_IN_BODY_NOTE)}</span>
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
            segment={!props.phone}
            onPick={() => traits.changeSelect(control.descriptor, option.id)}
          />
        ))}
      </Group>
    );
  };
  return (
    <>
      {effort ? renderControl(effort) : null}
      {others.map(renderControl)}
    </>
  );
}

const REASONING_LABEL = "Reasoning";

/** The docked panel's reasoning header with nothing to choose beneath it. */
function NoReasoningRow(props: { modelName: string | null }) {
  const t = useT();
  return (
    <SegmentedGroup label={t(REASONING_LABEL)} detail={props.modelName}>
      <span className="flex h-7 flex-1 items-center px-2.5 text-(--houston) text-xs">
        {t("No effort levels")}
      </span>
    </SegmentedGroup>
  );
}

function NoEffortRow() {
  const t = useT();
  return (
    <div className="flex h-6 items-center ps-15 text-(--houston) text-xs">
      {t("No effort levels")}
    </div>
  );
}

/** Codex service tiers and Claude's Fast mode, as one more row of the panel. */
function SpeedGroup(props: { traits: TraitsSelectionInput }) {
  const t = useT();
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
    <OptionGroup
      label={
        speedSelect?.label !== undefined
          ? t(speedSelect.label)
          : fastToggle?.label !== undefined
            ? t(fastToggle.label)
            : t("Speed")
      }
    >
      {speedSelect
        ? selectableProviderOptionChoices(speedSelect).map((option) => (
            <ColumnRow
              key={option.id}
              label={t(option.label)}
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
                label={value ? t("Fast") : t("Standard")}
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
export function ComposerEffortPanel(props: {
  traits: TraitsSelectionInput | null;
  phone?: boolean;
}) {
  const t = useT();
  const phone = props.phone === true;
  return (
    <EffortPhoneContext value={phone}>
      <div
        className={cn("flex flex-col", phone ? "gap-1 px-4 py-2" : "gap-3 px-3 py-2.5")}
        onKeyDown={moveBetweenRows}
      >
        {props.traits ? (
          <>
            <EffortLevels traits={props.traits} phone={phone} />
            {/* Outside the phone sheet, speed is a chip in the picker's footer. */}
            {phone ? <SpeedGroup traits={props.traits} /> : null}
          </>
        ) : phone ? (
          <div className="flex items-start gap-1">
            <span className={GROUP_LABEL}>{t("Effort")}</span>
            <span className="pt-1.5 text-(--houston) text-xs">{t("No effort levels")}</span>
          </div>
        ) : (
          <NoReasoningRow modelName={null} />
        )}
      </div>
    </EffortPhoneContext>
  );
}

/** Names a footer segment on hover when it has something to say. */
function SegmentTip(props: { tip: string | undefined; children: ReactElement }) {
  if (!props.tip) return props.children;
  return (
    <Tooltip>
      <TooltipTrigger render={props.children} />
      <TooltipPopup side="top" className="max-w-56">
        {props.tip}
      </TooltipPopup>
    </Tooltip>
  );
}

/** A footer chip's segment: icon and label, sized to its content inside the chip's track. */
const FOOTER_SEGMENT = cn(PICKER_SEGMENT_CLS, PICKER_CHIP_SEGMENT_CLS);

/**
 * Standard / Fast for a model that offers Claude's Fast mode or Codex service tiers: one segment
 * per tier, a bolt on the fast ones.
 */
function SpeedControl(props: { traits: TraitsSelectionInput }) {
  const t = useT();
  const traits = useTraitsSelection(props.traits);
  const { speedSelect, fastToggle } = splitSpeed(
    props.traits.provider,
    traits.selectDescriptors,
    traits.booleanDescriptors,
  );
  if (traits.modelIsUnavailable || (!speedSelect && !fastToggle)) return null;
  const bolt = (label: string) =>
    label === "Fast" || label === "Ultrafast" ? <FastBolt ultra={label === "Ultrafast"} /> : null;
  const segments: ReadonlyArray<{
    key: string;
    label: string;
    selected: boolean;
    description?: string | undefined;
    onPick: () => void;
  }> = speedSelect
    ? selectableProviderOptionChoices(speedSelect).map((option) => ({
        key: option.id,
        label: t(option.label),
        selected: option.id === traits.selectValue(speedSelect),
        description: option.description,
        onPick: () => traits.changeSelect(speedSelect, option.id),
      }))
    : fastToggle
      ? ([false, true] as const).map((value) => ({
          key: String(value),
          label: value ? t("Fast") : t("Standard"),
          selected: (fastToggle.currentValue === true) === value,
          onPick: () => traits.changeBoolean(fastToggle.id, value),
        }))
      : [];
  return (
    <div
      role="radiogroup"
      aria-label={
        speedSelect?.label !== undefined
          ? t(speedSelect.label)
          : fastToggle?.label !== undefined
            ? t(fastToggle.label)
            : t("Speed")
      }
      className={PICKER_CHIP_TRACK_CLS}
      onKeyDown={moveBetweenPermissionSegments('[role="radio"]')}
    >
      {segments.map((segment) => (
        <SegmentTip key={segment.key} tip={segment.description}>
          <button
            type="button"
            role="radio"
            aria-checked={segment.selected}
            data-checked={segment.selected || undefined}
            // Only the checked segment is a tab stop; Left and Right reach the others.
            tabIndex={segment.selected ? 0 : -1}
            className={FOOTER_SEGMENT}
            onClick={segment.onPick}
          >
            {bolt(segment.label)}
            {segment.label}
          </button>
        </SegmentTip>
      ))}
    </div>
  );
}

function UltracodeControl(props: { traits: TraitsSelectionInput }) {
  const traits = useTraitsSelection(props.traits);
  const { ultracodeToggle } = splitSpeed(
    props.traits.provider,
    traits.selectDescriptors,
    traits.booleanDescriptors,
  );
  if (traits.modelIsUnavailable || !ultracodeToggle) return null;
  const on = ultracodeToggle.currentValue === true;
  return (
    <div className={PICKER_CHIP_TRACK_CLS}>
      <button
        type="button"
        aria-pressed={on}
        data-checked={on || undefined}
        className={FOOTER_SEGMENT}
        onClick={() => traits.changeBoolean(ultracodeToggle.id, !on)}
      >
        <WorkflowIcon aria-hidden="true" className="size-3" />
        {ultracodeToggle.label}
      </button>
    </div>
  );
}

/**
 * The permission mode as one chip: the checked mode's icon and name. It opens a menu of every
 * mode with its description; a pick applies at once and closes only that menu, leaving the
 * picker open. The chip never cycles, so one click cannot raise permissions without a named pick.
 */
function PermissionsChip(props: {
  runtimeMode: RuntimeMode;
  runtimeModeOptions: ReadonlyArray<RuntimeModeOption>;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const t = useT();
  const current =
    props.runtimeModeOptions.find((option) => option.mode === props.runtimeMode) ??
    supervisedRuntimeModeOption;
  const CurrentIcon = current.icon;
  return (
    <div data-composer-permissions className={PICKER_CHIP_TRACK_CLS}>
      <Menu>
        <MenuTrigger
          aria-label={t("Permissions: {label}", { label: t(current.label) })}
          className={FOOTER_SEGMENT}
          render={<button type="button" />}
        >
          <CurrentIcon aria-hidden="true" className="size-3.5" />
          <span data-composer-permissions-label>{t(current.label)}</span>
        </MenuTrigger>
        {/* The popup keeps the composer's layer mark but not its focus return: closing the menu
            leaves focus on the chip, inside the picker. */}
        <MenuPopup align="start" side="top" {...composerFloatingLayerProps}>
          <MenuRadioGroup
            aria-label={t("Permissions")}
            value={props.runtimeMode}
            onValueChange={(value: RuntimeMode) => {
              if (value !== props.runtimeMode) props.onRuntimeModeChange(value);
            }}
          >
            {props.runtimeModeOptions.map((option) => {
              const OptionIcon = option.icon;
              return (
                <MenuRadioItem
                  key={option.mode}
                  value={option.mode}
                  disabled={option.disabledReason !== undefined}
                  label={t(option.label)}
                  closeOnClick
                  className="min-h-10 py-1"
                >
                  <span className="flex items-center gap-2.5">
                    <OptionIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                    <span className="flex min-w-0 flex-1 flex-col leading-snug">
                      <span>{t(option.label)}</span>
                      <span className="text-muted-foreground text-xs">
                        {option.disabledReason !== undefined
                          ? t(option.disabledReason)
                          : t(option.description)}
                      </span>
                    </span>
                    <MenuRadioItemIndicator />
                  </span>
                </MenuRadioItem>
              );
            })}
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
    </div>
  );
}

/**
 * The model picker's footer: labelled chips for Fast, Ultracode and, where no other control on
 * screen does, Permissions. A chip the model does not offer is not drawn; with none it renders
 * nothing.
 */
export function ComposerPickerFooter(props: {
  traits?: TraitsSelectionInput | null;
  permissions?: {
    runtimeMode: RuntimeMode;
    runtimeModeOptions: ReadonlyArray<RuntimeModeOption>;
    onRuntimeModeChange: (mode: RuntimeMode) => void;
  };
}) {
  const { permissions } = props;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2 empty:hidden">
      {props.traits ? <SpeedControl traits={props.traits} /> : null}
      {props.traits ? <UltracodeControl traits={props.traits} /> : null}
      {permissions ? (
        <PermissionsChip
          runtimeMode={permissions.runtimeMode}
          runtimeModeOptions={permissions.runtimeModeOptions}
          onRuntimeModeChange={permissions.onRuntimeModeChange}
        />
      ) : null}
    </div>
  );
}
