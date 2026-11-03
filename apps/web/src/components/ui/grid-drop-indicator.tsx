import { THREAD_DROP_REFUSAL_LABEL, type ThreadDropRefusal } from "../../grid/projectMove";
import { cn } from "../../lib/utils";

export type GridDropSide = "center" | "left" | "right" | "top" | "bottom";

/**
 * The tint or edge bar that shows where a dragged thread would land, or the
 * refusal zone that says why it will not.
 */
export function GridDropIndicator({
  side,
  refusal = null,
}: {
  side?: GridDropSide | undefined;
  refusal?: ThreadDropRefusal | null;
}) {
  if (refusal !== null) {
    return (
      <div
        data-drop-indicator="refusal"
        data-refusal={refusal}
        className="pointer-events-none absolute inset-0 z-30 grid place-items-center rounded-(--r-group) border-[1.5px] border-dashed border-(--danger-fill) bg-(--danger-wash)"
      >
        <span className="rounded-(--r-selection) border border-(--divider) bg-(--pane-head) px-2.5 py-1 text-xs font-semibold text-(--danger-fill)">
          {THREAD_DROP_REFUSAL_LABEL[refusal]}
        </span>
      </div>
    );
  }
  if (side === "center") {
    return (
      <div
        data-drop-indicator="swap"
        className="pointer-events-none absolute inset-0 z-30 bg-(--accent-muted) ring-1 ring-(--accent-ink) ring-inset"
      />
    );
  }
  if (side === undefined) return null;
  const wash =
    side === "left"
      ? "inset-y-0 left-0 w-1/4"
      : side === "right"
        ? "inset-y-0 right-0 w-1/4"
        : side === "top"
          ? "inset-x-0 top-0 h-1/4"
          : "inset-x-0 bottom-0 h-1/4";
  const bar =
    side === "left"
      ? "inset-y-0 left-0 w-[3px]"
      : side === "right"
        ? "inset-y-0 right-0 w-[3px]"
        : side === "top"
          ? "inset-x-0 top-0 h-[3px]"
          : "inset-x-0 bottom-0 h-[3px]";
  return (
    <div data-drop-indicator={side} className="pointer-events-none absolute inset-0 z-30">
      <div className={cn("absolute bg-(--accent-muted)", wash)} />
      <div className={cn("absolute bg-(--accent-ink)", bar)} />
    </div>
  );
}
