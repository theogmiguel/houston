import { Toolbar } from "@base-ui/react/toolbar";
import { type ProviderInstanceId } from "@houston-app/contracts";
import type { TimestampFormat } from "@houston-app/contracts/settings";
import { memo, useState } from "react";
import { StarIcon } from "lucide-react";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import {
  isProviderInstancePickerReady,
  providerInstanceReadinessReason,
  shouldShowInstanceBadge,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { formatReadinessReset } from "../settings/providerStatus";

/** A usage window's reset time, appended to the shared readiness label when it has one. */
function readinessReason(
  entry: ProviderInstanceEntry,
  timestampFormat: TimestampFormat,
): string | null {
  const reason = providerInstanceReadinessReason(entry);
  const readiness = entry.snapshot.readiness;
  if (reason === null || readiness?.state !== "outOfUsage" || readiness.resetsAt === null) {
    return reason;
  }
  return `${reason} · ${formatReadinessReset(readiness.resetsAt, timestampFormat)}`;
}

function describeUnavailableInstance(
  entry: ProviderInstanceEntry,
  timestampFormat: TimestampFormat,
): string {
  const label = entry.displayName;
  // An unavailable instance (a driver this build lacks or the policy leaves out) says why instead.
  if ((!entry.enabled && entry.isAvailable) || entry.status === "disabled") {
    return `${label}: Disabled in settings.`;
  }
  const readiness = readinessReason(entry, timestampFormat);
  if (readiness !== null) {
    return `${label}: ${readiness}.`;
  }
  if (entry.status === "ready" && entry.isAvailable) {
    return label;
  }
  const kind =
    entry.status === "error" ? "Unavailable" : entry.status === "warning" ? "Limited" : "Not ready";
  const msg = entry.snapshot.message?.trim();
  return msg ? `${label}: ${kind}. ${msg}` : `${label}: ${kind}.`;
}

/** The short reason an unavailable provider's tooltip carries. */
function unavailableInstanceReason(
  entry: ProviderInstanceEntry,
  timestampFormat: TimestampFormat,
): string | null {
  if (!entry.enabled || entry.status === "disabled") {
    return "Disabled";
  }
  const readiness = readinessReason(entry, timestampFormat);
  if (readiness !== null) {
    return readiness;
  }
  if (entry.status === "ready" && entry.isAvailable) {
    return null;
  }
  return entry.snapshot.message?.trim() || (entry.status === "error" ? "Unavailable" : "Not ready");
}

const PICKER_TOOLTIP_SIDE = "bottom" as const;
const PICKER_TOOLTIP_SIDE_OFFSET = 8;

/**
 * The model picker's provider choice: one horizontal segmented row under the search field.
 * Every provider stays reachable by Tab and arrows; an unavailable one names its reason in the
 * tooltip and the accessible name.
 */
export const ModelPickerSidebar = memo(function ModelPickerSidebar(props: {
  selectedInstanceId: ProviderInstanceId | "favorites";
  onSelectInstance: (instanceId: ProviderInstanceId | "favorites") => void;
  onFocusSearch: () => void;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  showFavorites?: boolean;
  /** Kept for callers that used the icon rail; the row sizes itself. */
  compact?: boolean;
  disabledInstanceIds?: ReadonlySet<ProviderInstanceId>;
  selectableUnavailableInstanceIds?: ReadonlySet<ProviderInstanceId>;
  getDisabledInstanceTooltip?: (entry: ProviderInstanceEntry) => string;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const handleSelect = (instanceId: ProviderInstanceId | "favorites") => {
    props.onSelectInstance(instanceId);
  };
  const showFavorites = props.showFavorites ?? true;
  const [hoveredInstanceId, setHoveredInstanceId] = useState<ProviderInstanceId | null>(null);

  return (
    <Toolbar.Root
      className="flex shrink-0 items-center gap-0.5 overflow-x-auto overscroll-x-contain border-border/70 border-b px-1.5 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      data-model-picker-sidebar="true"
      aria-label="Providers"
      orientation="horizontal"
    >
      {showFavorites ? (
        <div className="relative shrink-0" data-model-picker-provider="favorites">
          <Tooltip>
            <TooltipTrigger
              render={
                <Toolbar.Button
                  className="relative isolate flex h-7 cursor-pointer items-center gap-1.5 rounded-(--r-ctl) px-2 text-(--t2) text-xs transition-colors hover:bg-(--hover) hover:text-(--t1) focus-visible:bg-(--hover) focus-visible:text-(--t1) focus-visible:outline-none aria-pressed:bg-(--sel) aria-pressed:text-(--t1)"
                  onClick={() => handleSelect("favorites")}
                  type="button"
                  aria-label="Favorites"
                  aria-pressed={props.selectedInstanceId === "favorites"}
                />
              }
            >
              <StarIcon className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate leading-tight">Favorites</span>
            </TooltipTrigger>
            <TooltipPopup side={PICKER_TOOLTIP_SIDE} sideOffset={PICKER_TOOLTIP_SIDE_OFFSET}>
              Favorites
            </TooltipPopup>
          </Tooltip>
        </div>
      ) : null}

      {props.instanceEntries.map((entry) => {
        const isUnavailable = !isProviderInstancePickerReady(entry);
        const isContextDisabled = props.disabledInstanceIds?.has(entry.instanceId) ?? false;
        const unavailableSelectionIsReachable =
          props.selectableUnavailableInstanceIds?.has(entry.instanceId) ?? false;
        const isDisabled = (isUnavailable && !unavailableSelectionIsReachable) || isContextDisabled;
        const isSelected = props.selectedInstanceId === entry.instanceId;
        const isHovered = hoveredInstanceId === entry.instanceId;
        const showInstanceBadge = shouldShowInstanceBadge(entry, props.instanceEntries);
        const reason =
          unavailableInstanceReason(entry, timestampFormat) ??
          (isContextDisabled ? "Unavailable in this thread" : null);

        const tooltip = isUnavailable
          ? describeUnavailableInstance(entry, timestampFormat)
          : isContextDisabled
            ? (props.getDisabledInstanceTooltip?.(entry) ?? entry.displayName)
            : entry.displayName;

        const button = (
          <Toolbar.Button
            className={cn(
              "relative isolate flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-(--r-ctl) px-2 text-left text-(--t2) text-xs transition-colors hover:bg-(--hover) hover:text-(--t1) focus-visible:bg-(--hover) focus-visible:text-(--t1) focus-visible:outline-none aria-pressed:bg-(--sel) aria-pressed:text-(--t1)",
              isDisabled && "cursor-not-allowed text-(--houston) hover:bg-transparent",
            )}
            data-provider-accent-color={entry.accentColor}
            onClick={() => !isDisabled && handleSelect(entry.instanceId)}
            onMouseEnter={() => setHoveredInstanceId(entry.instanceId)}
            onMouseLeave={() =>
              setHoveredInstanceId((current) => (current === entry.instanceId ? null : current))
            }
            onFocus={() => setHoveredInstanceId(entry.instanceId)}
            onBlur={() =>
              setHoveredInstanceId((current) => (current === entry.instanceId ? null : current))
            }
            disabled={isDisabled}
            focusableWhenDisabled={!isDisabled}
            aria-pressed={isSelected}
            type="button"
            aria-label={isUnavailable || isContextDisabled ? tooltip : entry.displayName}
          >
            <ProviderInstanceIcon
              driverKind={entry.driverKind}
              displayName={entry.displayName}
              accentColor={entry.accentColor}
              acpRegistryAgentId={entry.acpRegistryAgentId}
              acpRegistryIconUrl={entry.acpRegistryIconUrl}
              showBadge={showInstanceBadge}
              className="z-30 shrink-0"
              iconClassName="size-3.5"
              indicatorBackground={
                isHovered && !isDisabled
                  ? "var(--muted)"
                  : isSelected
                    ? "var(--background)"
                    : "color-mix(in oklab, var(--muted) 30%, transparent)"
              }
              {...(entry.accentColor ? { badgeClassName: "h-3 min-w-3 px-0.5 text-5xs" } : {})}
            />
            <span className="max-w-24 truncate leading-tight">{entry.displayName}</span>
            {reason !== null ? (
              <span className="sr-only" data-model-picker-provider-reason="true">
                {reason}
              </span>
            ) : null}
          </Toolbar.Button>
        );

        const trigger = isDisabled ? (
          <span className="relative block shrink-0">{button}</span>
        ) : (
          button
        );

        return (
          <div
            key={entry.instanceId}
            className="relative shrink-0"
            data-model-picker-provider={entry.instanceId}
          >
            <Tooltip>
              <TooltipTrigger render={trigger} />
              <TooltipPopup side={PICKER_TOOLTIP_SIDE} sideOffset={PICKER_TOOLTIP_SIDE_OFFSET}>
                {tooltip}
              </TooltipPopup>
            </Tooltip>
          </div>
        );
      })}
    </Toolbar.Root>
  );
});
