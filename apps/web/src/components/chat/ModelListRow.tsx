import { type ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";
import { memo } from "react";
import { CheckIcon, StarIcon } from "lucide-react";
import { getDisplayModelName, getProviderRowLabel } from "./providerIconUtils";
import { ComboboxItem } from "../ui/combobox";
import { Badge } from "../ui/badge";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { modelPickerModelKey } from "./modelPickerKeys";
import { formatModelPickerTraits, type ModelPickerTraits } from "./modelPickerTraits";

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
  multiple?: boolean;
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
  const traitsLabel = props.traits ? formatModelPickerTraits(props.traits) : null;
  const providerLabel = props.showProvider
    ? getProviderRowLabel(props.providerDisplayName, props.subProvider)
    : null;
  const meta = [traitsLabel, providerLabel].filter((label) => label !== null).join(" · ");

  const favoriteButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="flex size-3.5 shrink-0 cursor-pointer items-center justify-center rounded-xs text-(--t3) outline-none hover:text-(--t1) disabled:pointer-events-none disabled:opacity-64"
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

  const trailing = props.multiple ? (
    props.isSelected ? (
      <span className="relative flex size-3.5 items-center justify-center">
        <CheckIcon className="size-3.5 text-(--t1) group-hover:opacity-0" aria-hidden="true" />
        <span className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100">
          {favoriteButton}
        </span>
      </span>
    ) : (
      <span
        className={cn(
          "flex size-3.5 items-center justify-center",
          !props.isFavorite && "opacity-0 group-hover:opacity-100",
        )}
      >
        {favoriteButton}
      </span>
    )
  ) : props.isSelected ? (
    <span className="relative flex size-3.5 items-center justify-center">
      <CheckIcon className="size-3.5 text-(--t1) group-hover:opacity-0" aria-hidden="true" />
      <span className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100">
        {favoriteButton}
      </span>
    </span>
  ) : (
    <span
      className={cn(
        "flex size-3.5 items-center justify-center",
        !props.isFavorite && "opacity-0 group-hover:opacity-100",
      )}
    >
      {favoriteButton}
    </span>
  );

  const row = (
    <ComboboxItem
      hideIndicator
      index={props.index}
      value={modelPickerModelKey(props.instanceId, props.slug)}
      disabled={Boolean(props.disabledReason)}
      className={cn(
        "group relative w-full !min-w-0 max-w-full cursor-pointer",
        props.disabledReason &&
          "data-disabled:pointer-events-auto data-disabled:cursor-not-allowed",
      )}
    >
      <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto_14px] items-center gap-x-2 gap-y-0.5 text-left">
        <div className="col-start-1 row-start-1 flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-(--t1) text-headline leading-snug">
            {getDisplayModelName(model)}
          </span>
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
        </div>
        {props.jumpLabel ? <Kbd className="col-start-2 row-start-1">{props.jumpLabel}</Kbd> : null}
        <div className="col-start-3 row-start-1 flex items-center justify-end">{trailing}</div>
        {meta ? (
          <div className="col-span-2 col-start-1 row-start-2 min-w-0 truncate text-(--t3) text-2xs">
            {meta}
          </div>
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
