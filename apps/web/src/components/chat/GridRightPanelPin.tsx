import { PinIcon, PinOffIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { PANEL_PIN_OWNER_CLS, panelPinRevealCls } from "../ui/panel-pin-recipes";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * A grid's right panel header controls: the owning thread's title in muted ink, pinned or not, and
 * the toggle that keeps the panel on that thread whichever cell is focused.
 */
export function GridRightPanelPin({
  threadTitle,
  pinned,
  onPinnedChange,
}: {
  threadTitle: string;
  pinned: boolean;
  onPinnedChange: (pinned: boolean) => void;
}) {
  const Icon = pinned ? PinOffIcon : PinIcon;
  return (
    <div className="flex min-w-0 shrink items-center gap-1" data-grid-right-panel-pin="">
      <Tooltip>
        <TooltipTrigger
          render={
            <span data-grid-right-panel-owner="" className={PANEL_PIN_OWNER_CLS}>
              {threadTitle}
            </span>
          }
        />
        <TooltipPopup side="bottom">{threadTitle}</TooltipPopup>
      </Tooltip>
      <span
        data-grid-right-panel-pin-reveal=""
        className={cn("flex shrink-0", panelPinRevealCls(pinned))}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0"
                pressed={pinned}
                onPressedChange={onPinnedChange}
                aria-label={`Pin to ${threadTitle}`}
                variant="ghost"
                size="sm"
              >
                <Icon className="size-4" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {pinned
              ? `Unpin the panel from ${threadTitle}`
              : `Keep this panel on ${threadTitle} when another pane is focused`}
          </TooltipPopup>
        </Tooltip>
      </span>
    </div>
  );
}
