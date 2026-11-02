import { type ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";
import { memo } from "react";
import { CheckIcon, StarIcon } from "lucide-react";
import { getDisplayModelName } from "./providerIconUtils";
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
  /** In Favorites every row is starred, so the star shows only on hover. */
  favoriteStarOnHover?: boolean;
  isSelected: boolean;
<<<<<<< 57f5b2527b386f5e6f3426d989d40921b2199f5b
  showProvider: boolean;
  multiple?: boolean;
=======
  /** Marks this instance apart from another of the same provider. */
  showInstanceBadge: boolean;
>>>>>>> e6e2ab05cceb3f8245e87f8499d4891f27de33cb
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
<<<<<<< 57f5b2527b386f5e6f3426d989d40921b2199f5b
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
=======
>>>>>>> e6e2ab05cceb3f8245e87f8499d4891f27de33cb

  const row = (
    <ComboboxItem
      hideIndicator
      selectedFill={false}
      index={props.index}
      value={modelPickerModelKey(props.instanceId, props.slug)}
      disabled={Boolean(props.disabledReason)}
      className={cn(
        "group relative w-full !min-w-0 max-w-full cursor-pointer",
        props.disabledReason &&
          "data-disabled:pointer-events-auto data-disabled:cursor-not-allowed",
      )}
    >
<<<<<<< 57f5b2527b386f5e6f3426d989d40921b2199f5b
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
=======
      {/* One row shape in every tab: the logo names the provider, so Favorites needs no second line. */}
      <ProviderInstanceIcon
        driverKind={props.driverKind}
        displayName={props.providerDisplayName}
        accentColor={props.providerAccentColor}
        acpRegistryAgentId={props.acpRegistryAgentId}
        acpRegistryIconUrl={props.acpRegistryIconUrl}
        showBadge={props.showInstanceBadge}
        className="size-4"
        iconClassName="size-4"
        indicatorBackground="var(--popover)"
        badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 px-0.5 text-5xs"
      />
      <div className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <div
          className="min-w-0 truncate text-sm font-normal leading-snug"
          // Names the row in full on hover only when it is cut off.
          onPointerEnter={(event) => {
            const name = event.currentTarget;
            name.title = name.scrollWidth > name.clientWidth ? getDisplayModelName(model) : "";
          }}
        >
          {getDisplayModelName(model)}
          {/* The logo is decorative, so name the provider for screen readers. */}
          <span className="sr-only">, {props.providerDisplayName}</span>
        </div>
        {props.subProvider ? (
          <span className="min-w-0 shrink truncate text-xs text-muted-foreground/70">
            {props.subProvider}
          </span>
        ) : null}
        {props.showNewBadge ? (
          <span
            className="shrink-0 rounded border border-update/35 bg-update/15 px-0.5 py-px text-3xs font-bold uppercase leading-none tracking-wide text-update-foreground"
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

      <div className="flex shrink-0 items-center gap-1.5">
        {props.jumpLabel ? <Kbd>{props.jumpLabel}</Kbd> : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                className="-mr-1 shrink-0"
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
                <StarIcon
                  className={cn(
                    "size-3.5 sm:size-3",
                    props.isFavorite && "fill-current text-warning",
                    (!props.isFavorite || props.favoriteStarOnHover) &&
                      "opacity-0 group-hover:opacity-100 group-data-highlighted:opacity-100 in-focus-visible:opacity-100 pointer-coarse:opacity-100",
                  )}
                />
              </Button>
            }
          />
          <TooltipPopup side="top" align="center">
            {props.isFavorite ? "Remove from favorites" : "Add to favorites"}
          </TooltipPopup>
        </Tooltip>
        {/* Last, and always reserved, so stars and the check keep fixed columns. */}
        <CheckIcon
          className={cn("size-3.5", !props.isSelected && "invisible")}
          aria-hidden="true"
        />
>>>>>>> e6e2ab05cceb3f8245e87f8499d4891f27de33cb
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
