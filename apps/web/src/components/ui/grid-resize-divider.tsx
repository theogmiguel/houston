import type {
  CSSProperties,
  KeyboardEventHandler,
  MouseEventHandler,
  PointerEventHandler,
  Ref,
} from "react";

import { cn } from "../../lib/utils";

/**
 * A grid divider: an 8px gutter that steps or drags the pair beside it, with
 * the fraction badge the drag paints. All of its paint lives here, so feature
 * components keep to layout utilities.
 */
export function GridResizeDivider({
  orientation,
  valueNow,
  dragging,
  badgeRef,
  style,
  onDoubleClick,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onLostPointerCapture,
  onKeyDown,
}: {
  orientation: "vertical" | "horizontal";
  valueNow: number;
  dragging: boolean;
  badgeRef: Ref<HTMLDivElement>;
  style?: CSSProperties;
  onDoubleClick: MouseEventHandler<HTMLDivElement>;
  onPointerDown: PointerEventHandler<HTMLDivElement>;
  onPointerMove: PointerEventHandler<HTMLDivElement>;
  onPointerUp: PointerEventHandler<HTMLDivElement>;
  onPointerCancel: PointerEventHandler<HTMLDivElement>;
  onLostPointerCapture: PointerEventHandler<HTMLDivElement>;
  onKeyDown: KeyboardEventHandler<HTMLDivElement>;
}) {
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label="Resize grid cells"
      aria-valuenow={valueNow}
      tabIndex={0}
      data-grid-gutter=""
      data-dragging={dragging ? "" : undefined}
      style={style}
      className={cn(
        "group relative z-10 shrink-0 touch-none outline-none after:absolute after:rounded-full after:bg-transparent after:transition-colors after:content-[''] hover:after:bg-(--accent-ink) focus-visible:after:bg-(--accent-ink) data-[dragging]:after:bg-(--accent-ink)",
        orientation === "vertical"
          ? "cursor-col-resize after:inset-y-0 after:left-[3px] after:w-0.5"
          : "cursor-row-resize after:inset-x-0 after:top-[3px] after:h-0.5",
      )}
      onDoubleClick={onDoubleClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onLostPointerCapture}
      onKeyDown={onKeyDown}
    >
      <div
        ref={badgeRef}
        aria-hidden="true"
        data-grid-resize-badge=""
        className="pointer-events-none absolute top-1/2 left-1/2 z-40 hidden -translate-x-1/2 -translate-y-1/2 rounded-(--r-selection) border border-(--divider) bg-(--pane-head) px-2.5 py-1 text-xs font-semibold whitespace-nowrap text-foreground shadow-(--shadow-1) data-[snapped]:border-(--accent-ink) data-[snapped]:bg-(--accent-ink) data-[snapped]:text-white"
      />
    </div>
  );
}
