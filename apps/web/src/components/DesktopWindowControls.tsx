import { useEffect, useState } from "react";

import {
  FALLBACK_WINDOW_BUTTON_LAYOUT,
  parseWindowButtonLayout,
  type WindowButtonLayout,
} from "~/lib/windowButtonLayout";
import {
  isTauriHost,
  windowButtonLayout,
  windowControl,
  windowIsMaximized,
} from "~/lib/desktopWindow";

import { WindowControls } from "./ui/window-control";

function reportControlFailure(action: string, error: unknown) {
  console.warn(`houston: windowControl(${action}) failed`, error);
}

export function DesktopWindowControls() {
  const [layout, setLayout] = useState<WindowButtonLayout>(FALLBACK_WINDOW_BUTTON_LAYOUT);
  const [maximized, setMaximized] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the native button layout and maximized state for this window chrome
  useEffect(() => {
    if (!isTauriHost()) return;

    let alive = true;
    void windowButtonLayout().then((raw) => {
      if (alive) setLayout(parseWindowButtonLayout(raw));
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const readMaximized = () => {
      void windowIsMaximized()
        .then((value) => {
          if (alive) setMaximized(value);
        })
        .catch((error: unknown) => {
          console.warn("houston: windowIsMaximized failed", error);
        });
    };
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(readMaximized, 80);
    };

    readMaximized();
    window.addEventListener("resize", onResize);
    return () => {
      alive = false;
      clearTimeout(timer);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  if (!isTauriHost()) return null;

  return (
    <div
      data-window-controls-dock=""
      className="pointer-events-none fixed top-(--workspace-controls-top) right-0 z-(--z-window) flex h-(--workspace-topbar-height) items-center"
    >
      <WindowControls
        className="pointer-events-auto"
        layout={layout}
        maximized={maximized}
        onClose={() =>
          void windowControl("close").catch((error) => reportControlFailure("close", error))
        }
        onMinimize={() =>
          void windowControl("minimize").catch((error) => reportControlFailure("minimize", error))
        }
        onMaximize={() =>
          void windowControl("maximize").catch((error) => reportControlFailure("maximize", error))
        }
      />
    </div>
  );
}
