import { useAtomValue } from "@effect/atom-react";
import type { KeybindingCommand } from "@houston-app/contracts";
import { ChevronDownIcon, Columns3Icon, LayoutGridIcon, Rows3Icon } from "lucide-react";
import type { ReactNode } from "react";

import { type GridRecord, useGridStore } from "../../grid/gridStore";
import { preorderThreads, type TidyShape } from "../../grid/tree";
import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Button } from "../ui/button";
import { Group } from "../ui/group";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const TIDY_OPTIONS: ReadonlyArray<{
  readonly shape: TidyShape;
  readonly label: string;
  readonly command: KeybindingCommand;
  readonly icon: ReactNode;
}> = [
  {
    shape: "grid",
    label: "Balanced grid",
    command: "grid.tidy",
    icon: <LayoutGridIcon className="size-4" />,
  },
  {
    shape: "row",
    label: "One row",
    command: "grid.tidyRow",
    icon: <Columns3Icon className="size-4" />,
  },
  {
    shape: "column",
    label: "One column",
    command: "grid.tidyColumn",
    icon: <Rows3Icon className="size-4" />,
  },
];

const DISABLED_REASON = "Open a second pane to tidy the grid";

/** The top-bar Tidy control: a click rebuilds the grid as balanced; the menu picks another shape. */
export function GridLayoutMenu({
  grid,
  onArrange,
}: {
  grid: GridRecord | null;
  /** Runs after the grid is rearranged, e.g. to leave a maximized pane. */
  onArrange?: () => void;
}) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const tidyGrid = useGridStore((store) => store.tidyGrid);
  const count = grid === null || grid.tree === null ? 0 : preorderThreads(grid.tree).length;
  const canTidy = grid !== null && count > 1;

  const tidy = (shape: TidyShape) => {
    if (grid === null || !canTidy) return;
    onArrange?.();
    tidyGrid(grid.id, shape);
  };

  return (
    <Group className="[-webkit-app-region:no-drag]">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label="Tidy panes"
              aria-disabled={!canTidy}
              onClick={() => tidy("grid")}
            />
          }
        >
          <LayoutGridIcon className="size-4" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {canTidy ? "Tidy panes into a balanced grid" : DISABLED_REASON}
        </TooltipPopup>
      </Tooltip>
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Choose tidy layout"
              disabled={!canTidy}
            />
          }
        >
          <ChevronDownIcon className="size-3 text-secondary-label" />
        </MenuTrigger>
        <MenuPopup side="bottom" align="end">
          {TIDY_OPTIONS.map((option) => {
            const shortcut = shortcutLabelForCommand(keybindings, option.command);
            return (
              <MenuItem key={option.shape} onClick={() => tidy(option.shape)}>
                {option.icon}
                {option.label}
                {shortcut === null ? null : <MenuShortcut>{shortcut}</MenuShortcut>}
              </MenuItem>
            );
          })}
        </MenuPopup>
      </Menu>
    </Group>
  );
}
