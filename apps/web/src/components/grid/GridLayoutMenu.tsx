import { CheckIcon, ChevronDownIcon, LayoutGridIcon } from "lucide-react";

import { arrangeThreads, preorderThreads } from "../../grid/tree";
import { type GridRecord, useGridStore } from "../../grid/gridStore";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const PRESET_COUNTS = [1, 2, 3, 4, 5, 6] as const;

export function GridLayoutMenu({ grid }: { grid: GridRecord | null }) {
  const setTree = useGridStore((store) => store.setTree);
  const count = grid?.tree === null || grid === null ? 0 : preorderThreads(grid.tree).length;
  const canArrange = grid !== null && count > 1;

  const apply = (next: ReturnType<typeof arrangeThreads>) => {
    if (grid === null || next === null) return;
    setTree(grid.id, next);
  };

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="default"
                  className="[-webkit-app-region:no-drag]"
                  aria-label="Grid layout"
                  disabled={!canArrange}
                />
              }
            />
          }
        >
          <LayoutGridIcon className="size-4" />
          <ChevronDownIcon className="size-3 text-secondary-label" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {canArrange ? "Grid layout" : "Grid layout needs two or more threads"}
        </TooltipPopup>
      </Tooltip>
      <MenuPopup side="bottom" align="end">
        <MenuItem disabled={!canArrange} onClick={() => apply(arrangeThreads(grid?.tree ?? null))}>
          Auto arrange
        </MenuItem>
        <MenuSeparator />
        {PRESET_COUNTS.map((preset) => {
          const selected = count === preset;
          return (
            <MenuItem
              key={preset}
              disabled={count !== preset}
              onClick={() => apply(arrangeThreads(grid?.tree ?? null))}
            >
              {preset} {preset === 1 ? "thread" : "threads"}
              {selected ? <CheckIcon className="ml-auto size-3" /> : null}
            </MenuItem>
          );
        })}
      </MenuPopup>
    </Menu>
  );
}
