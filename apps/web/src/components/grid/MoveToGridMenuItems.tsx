import type { MoveToGridTarget } from "../../grid/moveToGrid";
import { MenuItem, MenuSeparator } from "../ui/menu";

/** The Move to grid submenu body: the project's other grids, then a new one. */
export function MoveToGridMenuItems({
  targets,
  onMove,
  onNewGrid,
}: {
  targets: ReadonlyArray<MoveToGridTarget>;
  onMove: (gridId: string) => void;
  onNewGrid: () => void;
}) {
  return (
    <>
      {targets.map((target) => (
        <MenuItem key={target.gridId} onClick={() => onMove(target.gridId)}>
          {target.name}
        </MenuItem>
      ))}
      {targets.length === 0 ? null : <MenuSeparator />}
      <MenuItem onClick={onNewGrid}>New grid</MenuItem>
    </>
  );
}
