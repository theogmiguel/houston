import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@houston-app/contracts";
import { memo } from "react";
import { CheckIcon, StarIcon } from "lucide-react";
import { getDisplayModelName } from "./providerIconUtils";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { ComboboxItem } from "../ui/combobox";
import { Badge } from "../ui/badge";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { modelPickerModelKey } from "./modelPickerKeys";
import { formatModelPickerTraits, type ModelPickerTraits } from "./modelPickerTraits";

const REGEX_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g;

function escapeRegExp(value: string): string {
  return value.replace(REGEX_SPECIAL_CHARS, "\\$&");
}

// Each row reads this per render; the bound sits far above the number of configured providers.
const PROVIDER_PREFIX_CACHE_MAX = 64;
const providerPrefixPatterns = new Map<string, RegExp>();

function providerPrefixPattern(provider: string): RegExp {
  let pattern = providerPrefixPatterns.get(provider);
  if (pattern === undefined) {
    if (providerPrefixPatterns.size >= PROVIDER_PREFIX_CACHE_MAX) providerPrefixPatterns.clear();
    pattern = new RegExp(`^${escapeRegExp(provider)}\\s+\\S`, "i");
    providerPrefixPatterns.set(provider, pattern);
  }
  return pattern;
}

export function getProviderRowLabel(
  providerDisplayName: string,
  subProvider: string | undefined,
): string {
  const provider = providerDisplayName.trim();
  const sub = subProvider?.trim();
  if (!sub) {
    return providerDisplayName;
  }
  if (provider && providerPrefixPattern(provider).test(sub)) {
    return sub;
  }
  return `${providerDisplayName} · ${sub}`;
}

/**
 * Inside one provider's tab the rail already names the provider, so "Claude Opus 5.5" reads
 * "Opus 5.5". The instance's own name ("Claude Personal") and the driver's name ("Claude") are
 * both tried, since a renamed instance still lists its driver's models.
 */
export function stripProviderPrefix(
  name: string,
  providerNames: ReadonlyArray<string | undefined>,
): string {
  for (const candidate of providerNames) {
    const provider = candidate?.trim();
    if (!provider || !providerPrefixPattern(provider).test(name)) continue;
    return name.slice(provider.length).trimStart();
  }
  return name;
}

export const ModelListRow = memo(function ModelListRow(props: {
  index: number;
  slug: string;
  name: string;
  subProvider?: string | undefined;
  instanceId: ProviderInstanceId;
  driverKind: ProviderDriverKind;
  providerDisplayName: string;
  providerAccentColor?: string | undefined;
  acpRegistryAgentId?: string | undefined;
  acpRegistryIconUrl?: string | undefined;
  traits?: ModelPickerTraits | undefined;
  isFavorite: boolean;
  isSelected: boolean;
  showProvider: boolean;
  /** A phone row is full width with a 44px floor and the sheet's 16px gutter. */
  phone?: boolean;
  showNewBadge?: boolean;
  unavailable?: boolean;
  jumpLabel?: string | null;
  disabledReason?: string | null;
  onToggleFavorite: (instanceId: ProviderInstanceId, slug: string) => void;
}) {
  const model = {
    slug: props.slug,
    name: props.name,
    subProvider: props.subProvider,
  };
  // Every row of a provider repeats the same effort, so only the selected row states it.
  const traitsLabel = props.traits
    ? formatModelPickerTraits(props.isSelected ? props.traits : { ...props.traits, effort: null })
    : null;
  const providerLabel = props.showProvider
    ? getProviderRowLabel(props.providerDisplayName, props.subProvider)
    : null;
  const displayName = getDisplayModelName(model);
  const rowName = props.showProvider
    ? displayName
    : stripProviderPrefix(displayName, [
        props.providerDisplayName,
        PROVIDER_DISPLAY_NAMES[props.driverKind],
      ]);
  const meta = [traitsLabel, providerLabel].filter((label) => label !== null).join(" · ");

  const favoriteButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="flex size-3.5 shrink-0 cursor-pointer items-center justify-center rounded-xs text-(--houston) outline-none hover:text-(--t1) disabled:pointer-events-none disabled:opacity-64"
            onClick={(event) => {
              event.stopPropagation();
              props.onToggleFavorite(props.instanceId, props.slug);
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
            }}
            disabled={Boolean(props.disabledReason)}
            aria-label={props.isFavorite ? "Remove from favorites" : "Add to favorites"}
          >
            <StarIcon className="size-3.25" />
          </button>
        }
      />
      <TooltipPopup side="top" align="center">
        {props.isFavorite ? "Remove from favorites" : "Add to favorites"}
      </TooltipPopup>
    </Tooltip>
  );

  // The star keeps its space whether or not it shows, so a row never shifts on hover. A phone
  // row has no keycap and marks the selected model with a check at the far edge, where the star
  // takes its place on hover.
  const star = (
    <span
      className={cn(
        "flex size-3.5 shrink-0 items-center justify-center",
        !props.isFavorite && "opacity-0 group-hover:opacity-100 group-data-highlighted:opacity-100",
      )}
    >
      {favoriteButton}
    </span>
  );
  const trailing =
    props.phone && props.isSelected ? (
      <span className="relative flex size-3.5 shrink-0 items-center justify-center">
        <CheckIcon className="size-3.5 text-(--t1) group-hover:opacity-0" aria-hidden="true" />
        <span className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100">
          {favoriteButton}
        </span>
      </span>
    ) : (
      star
    );

  const row = (
    <ComboboxItem
      hideIndicator
      index={props.index}
      value={modelPickerModelKey(props.instanceId, props.slug)}
      disabled={Boolean(props.disabledReason)}
      density={props.phone ? "phone" : "default"}
      className={cn(
        "group relative w-full !min-w-0 max-w-full cursor-pointer",
        props.disabledReason &&
          "data-disabled:pointer-events-auto data-disabled:cursor-not-allowed",
      )}
    >
      <div className="flex w-full min-w-0 flex-col text-left">
        <div className="flex min-w-0 items-center gap-2">
          <ProviderInstanceIcon
            driverKind={props.driverKind}
            displayName={props.providerDisplayName}
            accentColor={props.providerAccentColor}
            acpRegistryAgentId={props.acpRegistryAgentId}
            acpRegistryIconUrl={props.acpRegistryIconUrl}
            badgeContent="none"
            size="compact"
            className="z-0"
            iconClassName="size-3.5"
          />
          <span
            className="min-w-0 truncate text-(--t1) text-headline leading-snug"
            // Names the row in full on hover only when it is cut off.
            onPointerEnter={(event) => {
              const name = event.currentTarget;
              name.title = name.scrollWidth > name.clientWidth ? displayName : "";
            }}
          >
            {rowName}
          </span>
          {props.isSelected && !props.phone ? (
            <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-(--t1)" />
          ) : null}
          {props.showNewBadge ? (
            <span
              className="shrink-0 rounded-sm border border-(--line-strong) px-1 text-3xs font-semibold leading-4 text-(--t2)"
              aria-label="New model"
            >
              New
            </span>
          ) : null}
          {props.unavailable ? (
            <Badge variant="outline" size="sm">
              Unavailable
            </Badge>
          ) : null}
          <span className="flex-1" />
          {trailing}
          {props.jumpLabel && !props.phone ? <Kbd>{props.jumpLabel}</Kbd> : null}
        </div>
        {meta ? (
          <div className="min-w-0 truncate ps-5.5 text-(--houston) text-2xs">{meta}</div>
        ) : null}
      </div>
    </ComboboxItem>
  );

  if (!props.disabledReason) {
    return row;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={row} />
      <TooltipPopup side="left" align="center">
        {props.disabledReason}
      </TooltipPopup>
    </Tooltip>
  );
});
