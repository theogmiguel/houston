import type { CSSProperties } from "react";

import { isTauriHost, startResizeDragging, type WindowResizeDirection } from "~/lib/desktopWindow";

import { WindowResizeGrip } from "./ui/window-control";

const EDGE = 6;
const CORNER = EDGE * 2;

interface Grip {
  direction: WindowResizeDirection;
  cursor: string;
  style: CSSProperties;
}

const GRIPS: Grip[] = [
  { direction: "north", cursor: "ns-resize", style: { top: 0, left: 0, right: 0, height: EDGE } },
  {
    direction: "south",
    cursor: "ns-resize",
    style: { bottom: 0, left: 0, right: 0, height: EDGE },
  },
  { direction: "west", cursor: "ew-resize", style: { top: 0, bottom: 0, left: 0, width: EDGE } },
  { direction: "east", cursor: "ew-resize", style: { top: 0, bottom: 0, right: 0, width: EDGE } },
  {
    direction: "north-west",
    cursor: "nwse-resize",
    style: { top: 0, left: 0, width: CORNER, height: CORNER },
  },
  {
    direction: "north-east",
    cursor: "nesw-resize",
    style: { top: 0, right: 0, width: CORNER, height: CORNER },
  },
  {
    direction: "south-west",
    cursor: "nesw-resize",
    style: { bottom: 0, left: 0, width: CORNER, height: CORNER },
  },
  {
    direction: "south-east",
    cursor: "nwse-resize",
    style: { bottom: 0, right: 0, width: CORNER, height: CORNER },
  },
];

// A frameless window has no WM border, and the native resize region WebKitGTK
// installs is consumed by the webview before it fires. These grips start the
// Tauri resize drag from the page instead.
export function WindowResizeGrips() {
  if (!isTauriHost()) return null;

  return (
    <>
      {GRIPS.map((grip) => (
        <WindowResizeGrip
          key={grip.direction}
          data-testid={`resize-grip-${grip.direction}`}
          style={{ ...grip.style, cursor: grip.cursor }}
          onMouseDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            void startResizeDragging(grip.direction).catch((error: unknown) => {
              console.warn("houston: startResizeDragging failed", grip.direction, error);
            });
          }}
        />
      ))}
    </>
  );
}
