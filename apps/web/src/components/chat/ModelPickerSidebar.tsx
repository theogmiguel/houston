import { Toolbar } from "@base-ui/react/toolbar";
import type { TimestampFormat } from "@houston-app/contracts/settings";
import { type ProviderInstanceId } from "@houston-app/contracts";
import { memo, useState } from "react";
import { StarIcon } from "lucide-react";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import {
  MODEL_PICKER_SIDEBAR_CLS,
  MODEL_PICKER_SIDEBAR_PHONE_CLS,
  MODEL_PICKER_SIDEBAR_PHONE_ROW_CLS,
  MODEL_PICKER_SIDEBAR_PHONE_TRACK_CLS,
  MODEL_PICKER_SIDEBAR_SCROLL_CLS,
  MODEL_PICKER_SIDEBAR_FAVORITES_CLS,
  MODEL_PICKER_SIDEBAR_LABEL_CLS,
  MODEL_PICKER_SIDEBAR_ROW_CLS,
  MODEL_PICKER_SIDEBAR_ROW_DISABLED_CLS,
  MODEL_PICKER_SIDEBAR_NAME_CLS,
  MODEL_PICKER_SIDEBAR_REASON_CLS,
} from "../ui/model-picker-sidebar-recipes";
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

/** The short reason the row shows beneath an unavailable provider's name. */
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

const PICKER_TOOLTIP_SIDE = "left" as const;
const PICKER_TOOLTIP_SIDE_OFFSET = 8;

export const ModelPickerSidebar = memo(function ModelPickerSidebar(props: {
  selectedInstanceId: ProviderInstanceId | "favorites";
  onSelectInstance: (instanceId: ProviderInstanceId | "favorites") => void;
  onFocusSearch: () => void;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  showFavorites?: boolean;
  disabledInstanceIds?: ReadonlySet<ProviderInstanceId>;
  selectableUnavailableInstanceIds?: ReadonlySet<ProviderInstanceId>;
  getDisabledInstanceTooltip?: (entry: ProviderInstanceEntry) => string;
  /** Lays the providers out as one scrolling row with 44px chips (the phone sheet). */
  phone?: boolean;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const handleSelect = (instanceId: ProviderInstanceId | "favorites") => {
    props.onSelectInstance(instanceId);
  };
  const showFavorites = props.showFavorites ?? true;
  const [hoveredInstanceId, setHoveredInstanceId] = useState<ProviderInstanceId | null>(null);

  return (
    <Toolbar.Root
      className={props.phone ? MODEL_PICKER_SIDEBAR_PHONE_CLS : MODEL_PICKER_SIDEBAR_CLS}
      data-model-picker-sidebar="true"
      aria-label="Providers"
      orientation={props.phone ? "horizontal" : "vertical"}
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.key === "ArrowRight") {
          event.preventDefault();
          props.onFocusSearch();
          return;
        }
      }}
    >
      <div
        className={cn(
          MODEL_PICKER_SIDEBAR_SCROLL_CLS,
          props.phone && "overflow-x-auto overflow-y-hidden",
        )}
      >
        <div
          className={
            props.phone
              ? MODEL_PICKER_SIDEBAR_PHONE_TRACK_CLS
              : "relative flex min-h-full flex-col gap-px p-1.5"
          }
        >
          {showFavorites ? (
            <>
              <div
                className={cn("relative", props.phone ? "shrink-0" : "w-full")}
                data-model-picker-provider="favorites"
              >
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Toolbar.Button
                        className={cn(
                          MODEL_PICKER_SIDEBAR_FAVORITES_CLS,
                          props.phone && MODEL_PICKER_SIDEBAR_PHONE_ROW_CLS,
                        )}
                        onClick={() => handleSelect("favorites")}
                        type="button"
                        aria-label="Favorites"
                        aria-pressed={props.selectedInstanceId === "favorites"}
                      >
                        <StarIcon className="size-3.5 shrink-0" aria-hidden />
                        <span className={MODEL_PICKER_SIDEBAR_LABEL_CLS}>Favorites</span>
                      </Toolbar.Button>
                    }
                  />
                  <TooltipPopup
                    side={PICKER_TOOLTIP_SIDE}
                    sideOffset={PICKER_TOOLTIP_SIDE_OFFSET}
                    align="center"
                  >
                    Favorites
                  </TooltipPopup>
                </Tooltip>
              </div>
            </>
          ) : null}

          {props.instanceEntries.map((entry) => {
            const isUnavailable = !isProviderInstancePickerReady(entry);
            const isContextDisabled = props.disabledInstanceIds?.has(entry.instanceId) ?? false;
            const unavailableSelectionIsReachable =
              props.selectableUnavailableInstanceIds?.has(entry.instanceId) ?? false;
            const isDisabled =
              (isUnavailable && !unavailableSelectionIsReachable) || isContextDisabled;
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
                  MODEL_PICKER_SIDEBAR_ROW_CLS,
                  props.phone
                    ? MODEL_PICKER_SIDEBAR_PHONE_ROW_CLS
                    : reason === null
                      ? "h-7"
                      : "items-start py-1",
                  isDisabled && MODEL_PICKER_SIDEBAR_ROW_DISABLED_CLS,
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
                  className={cn("z-30 shrink-0", reason === null ? "size-3.5" : "size-3.5 mt-0.5")}
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
                <span className={MODEL_PICKER_SIDEBAR_NAME_CLS}>
                  <span className="truncate">{entry.displayName}</span>
                  {reason !== null ? (
                    <small
                      className={MODEL_PICKER_SIDEBAR_REASON_CLS}
                      data-model-picker-provider-reason="true"
                    >
                      {reason}
                    </small>
                  ) : null}
                </span>
              </Toolbar.Button>
            );

            const trigger = isDisabled ? (
              <span className="relative block w-full">{button}</span>
            ) : (
              button
            );

            return (
              <div
                key={entry.instanceId}
                className={cn("relative", props.phone ? "shrink-0" : "w-full")}
                data-model-picker-provider={entry.instanceId}
              >
                <Tooltip>
                  <TooltipTrigger render={trigger} />
                  <TooltipPopup
                    side={PICKER_TOOLTIP_SIDE}
                    sideOffset={PICKER_TOOLTIP_SIDE_OFFSET}
                    align="center"
                  >
                    {tooltip}
                  </TooltipPopup>
                </Tooltip>
              </div>
            );
          })}
        </div>
      </div>
    </Toolbar.Root>
  );
});
