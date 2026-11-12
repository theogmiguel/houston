import {
  ListFilterIcon,
  MoreHorizontalIcon,
  PanelBottomIcon,
  PanelRightIcon,
  SquareMenuIcon,
} from "lucide-react";
import { Maximize2, Minimize2 } from "lucide";
import { MorphIcon } from "~/components/MorphIcon";
import { memo, type RefObject } from "react";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import type { ThreadPanelPresentation } from "../../rightPanelLayout";
import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuPopup,
  MenuShortcut,
  MenuTrigger,
} from "../ui/menu";
import { PopoverCreateHandle, PopoverPanelAnchor, PopoverTrigger } from "../ui/popover";
import { SIDEBAR_MOBILE_QUERY } from "../ui/sidebar";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface PanelLayoutControlsProps {
  showThreadPanelControl?: boolean;
  showTerminalControl?: boolean;
  showRightPanelControl?: boolean;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalShortcutLabel: string | null;
  threadPanelOpen: boolean;
  threadPanelPresentation: ThreadPanelPresentation;
  threadPanelPopoverHandle?: ReturnType<typeof PopoverCreateHandle>;
  /** Anchors the popover card under this control, as wide as the card. */
  threadPanelAnchorRef?: RefObject<HTMLElement | null>;
  threadPanelShortcutLabel: string | null;
  rightPanelAvailable: boolean;
  rightPanelOpen: boolean;
  rightPanelShortcutLabel: string | null;
  rightPanelUnavailableLabel?: string;
  onToggleTerminal: () => void;
  onToggleThreadPanel: () => void;
  onToggleRightPanel: () => void;
}

export const PanelLayoutControls = memo(function PanelLayoutControls({
  showThreadPanelControl = true,
  showTerminalControl = true,
  showRightPanelControl = true,
  terminalAvailable,
  terminalOpen,
  terminalShortcutLabel,
  threadPanelOpen,
  threadPanelPresentation,
  threadPanelPopoverHandle,
  threadPanelAnchorRef,
  threadPanelShortcutLabel,
  rightPanelAvailable,
  rightPanelOpen,
  rightPanelShortcutLabel,
  rightPanelUnavailableLabel = "Right panel is unavailable",
  onToggleTerminal,
  onToggleThreadPanel,
  onToggleRightPanel,
}: PanelLayoutControlsProps) {
  // Below the sidebar's drawer breakpoint the header has room for one panel toggle: the panel
  // controls fold into a More menu. A popover-presented details card keeps its toggle in the
  // header because that toggle is the card's anchor.
  const narrow = useMediaQuery(SIDEBAR_MOBILE_QUERY);
  const detailsInMenu = narrow && showThreadPanelControl && threadPanelPresentation !== "popover";
  const terminalInMenu = narrow && showTerminalControl;
  const hasMoreMenu = detailsInMenu || terminalInMenu;
  const threadPanelToggle = (
    <Toggle
      className="relative shrink-0 [-webkit-app-region:no-drag]"
      pressed={threadPanelOpen}
      onPressedChange={threadPanelPresentation === "popover" ? undefined : onToggleThreadPanel}
      aria-label="Toggle thread details panel"
      variant="ghost"
      size="sm"
    >
      <ListFilterIcon className="size-4" />
    </Toggle>
  );
  const threadPanelControl = (
    <span className="relative flex shrink-0">
      <Tooltip>
        <TooltipTrigger render={<span className="flex shrink-0" />}>
          {threadPanelPresentation === "popover" ? (
            <PopoverTrigger handle={threadPanelPopoverHandle} render={threadPanelToggle} />
          ) : (
            threadPanelToggle
          )}
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          Toggle thread details
          {threadPanelShortcutLabel ? ` (${threadPanelShortcutLabel})` : ""}
        </TooltipPopup>
      </Tooltip>
      {threadPanelAnchorRef ? <PopoverPanelAnchor anchorRef={threadPanelAnchorRef} /> : null}
    </span>
  );

  return (
    <div
      className="flex h-full shrink-0 items-center [-webkit-app-region:no-drag]"
      data-panel-layout-controls
    >
      <div className="flex items-center gap-1">
        {hasMoreMenu ? (
          <Menu>
            <Tooltip>
              <TooltipTrigger render={<span className="flex shrink-0" />}>
                <MenuTrigger
                  render={<Button variant="ghost" size="icon" aria-label="More layout controls" />}
                >
                  <MoreHorizontalIcon className="size-4" />
                </MenuTrigger>
              </TooltipTrigger>
              <TooltipPopup side="bottom">More layout controls</TooltipPopup>
            </Tooltip>
            <MenuPopup side="bottom" align="end">
              {detailsInMenu ? (
                <MenuCheckboxItem
                  checked={threadPanelOpen}
                  onCheckedChange={() => onToggleThreadPanel()}
                >
                  <SquareMenuIcon />
                  Toggle thread details
                  {threadPanelShortcutLabel ? (
                    <MenuShortcut>{threadPanelShortcutLabel}</MenuShortcut>
                  ) : null}
                </MenuCheckboxItem>
              ) : null}
              {terminalInMenu ? (
                <MenuCheckboxItem
                  checked={terminalOpen}
                  disabled={!terminalAvailable}
                  onCheckedChange={() => onToggleTerminal()}
                >
                  <PanelBottomIcon />
                  Toggle terminal drawer
                  {terminalShortcutLabel ? (
                    <MenuShortcut>{terminalShortcutLabel}</MenuShortcut>
                  ) : null}
                </MenuCheckboxItem>
              ) : null}
            </MenuPopup>
          </Menu>
        ) : null}
        {showThreadPanelControl && !detailsInMenu ? threadPanelControl : null}
        {showTerminalControl && !terminalInMenu ? (
          <Tooltip>
            <TooltipTrigger render={<span className="flex shrink-0" />}>
              <Toggle
                className="shrink-0 [-webkit-app-region:no-drag]"
                pressed={terminalOpen}
                onPressedChange={onToggleTerminal}
                aria-label="Toggle terminal drawer"
                variant="ghost"
                size="sm"
                disabled={!terminalAvailable}
              >
                <PanelBottomIcon className="size-4" />
              </Toggle>
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {terminalAvailable
                ? `Toggle terminal drawer${terminalShortcutLabel ? ` (${terminalShortcutLabel})` : ""}`
                : "Terminal drawer is unavailable"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {showRightPanelControl ? (
          <Tooltip>
            <TooltipTrigger render={<span className="flex shrink-0" />}>
              <Toggle
                className="shrink-0 [-webkit-app-region:no-drag]"
                pressed={rightPanelOpen}
                onPressedChange={onToggleRightPanel}
                aria-label="Toggle right panel"
                data-right-panel-toggle
                variant="ghost"
                size="sm"
                disabled={!rightPanelAvailable}
              >
                <PanelRightIcon className="size-4" />
              </Toggle>
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {rightPanelAvailable
                ? `Toggle right panel${rightPanelShortcutLabel ? ` (${rightPanelShortcutLabel})` : ""}`
                : rightPanelUnavailableLabel}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
});

// Every toggle stays in the header; with the right panel open the header loses its end gutter.
export const ChatHeaderPanelControls = memo(function ChatHeaderPanelControls(
  props: PanelLayoutControlsProps,
) {
  return props.rightPanelOpen ? (
    <div className="flex h-full shrink-0 items-center pr-1">
      <PanelLayoutControls {...props} />
    </div>
  ) : (
    <PanelLayoutControls {...props} />
  );
});

export const RightPanelMaximizeControl = memo(function RightPanelMaximizeControl({
  maximized,
  onToggle,
}: {
  maximized: boolean;
  onToggle: () => void;
}) {
  const label = maximized ? "Restore panel size" : "Maximize panel";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className="shrink-0 [-webkit-app-region:no-drag]"
            pressed={maximized}
            onPressedChange={onToggle}
            aria-label={label}
            variant="ghost"
            size="sm"
          >
            <MorphIcon className="size-4" icon={maximized ? Minimize2 : Maximize2} />
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
});
