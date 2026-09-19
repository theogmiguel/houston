import { useEffect, useRef, useState } from "react";
import {
  RAIL_COLLAPSE_AT,
  RAIL_DEFAULT,
  RAIL_MAX,
  RAIL_MIN,
  clampRailWidth,
} from "../railWidth";

export function RailResizeHandle({
  width,
  collapsed,
  onChange,
  onCollapse,
}: {
  width: number;
  collapsed: boolean;
  onChange: (next: number) => void;
  onCollapse: () => void;
}): React.JSX.Element | null {
  const [dragging, setDragging] = useState(false);
  const pointerId = useRef<number | null>(null);
  const pendingX = useRef<number | null>(null);
  const frame = useRef<number | null>(null);

  const apply = (x: number): void => {
    if (x < RAIL_COLLAPSE_AT) {
      onCollapse();
      return;
    }
    onChange(clampRailWidth(x));
  };

  const flush = (): void => {
    frame.current = null;
    const x = pendingX.current;
    pendingX.current = null;
    if (x !== null) apply(x);
  };

  useEffect(
    () => () => {
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    },
    [],
  );

  const endDrag = (
    e: React.PointerEvent<HTMLDivElement>,
    commit: boolean,
  ): void => {
    if (pointerId.current !== e.pointerId) return;
    pointerId.current = null;
    if (frame.current !== null) {
      window.cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    if (commit) flush();
    else pendingX.current = null;
    setDragging(false);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  if (collapsed) return null;

  return (
    <div
      data-testid="rail-resize-handle"
      data-dragging={dragging ? "true" : undefined}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={RAIL_MIN}
      aria-valuemax={RAIL_MAX}
      aria-valuenow={width}
      className="absolute inset-y-0 left-[var(--w-rail)] z-[var(--z-sticky)] w-2 -translate-x-1 cursor-col-resize touch-none bg-transparent after:content-[''] after:absolute after:inset-0 after:w-px after:mx-auto after:bg-transparent motion-safe:after:[transition:background-color_0.1s_ease-out] data-[dragging]:after:bg-[var(--text-faint)]"
      onPointerDown={(e) => {
        e.preventDefault();
        pointerId.current = e.pointerId;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (pointerId.current !== e.pointerId) return;
        pendingX.current = e.clientX;
        if (frame.current !== null) return;
        frame.current = window.requestAnimationFrame(flush);
      }}
      onPointerUp={(e) => endDrag(e, true)}
      onPointerCancel={(e) => endDrag(e, false)}
      onDoubleClick={() => onChange(RAIL_DEFAULT)}
    />
  );
}
