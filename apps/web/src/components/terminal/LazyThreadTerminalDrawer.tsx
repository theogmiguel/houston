import { useLayoutEffect, useRef, type ComponentProps, type ReactNode } from "react";

import { LazySurfaceBoundary, lazySurface } from "../LazySurface";
import type ThreadTerminalDrawer from "../ThreadTerminalDrawer";
import {
  chatColumnOf,
  clampDrawerHeight,
  readDrawerLayout,
  resolveTerminalDrawerMaxHeight,
} from "./drawerHeight";

type ThreadTerminalDrawerProps = ComponentProps<typeof ThreadTerminalDrawer>;

// The terminal code (about 110 KB) loads after the thread paints instead of before it.
const drawer = lazySurface<ThreadTerminalDrawerProps>(() =>
  import("../ThreadTerminalDrawer").then((module) => module.default),
);

/** Holds the height the drawer will take, measured the way the drawer measures it. */
function DrawerPlaceholder({
  height,
  composerHeight = 0,
  children,
}: {
  readonly height: number;
  readonly composerHeight: number | undefined;
  readonly children: ReactNode;
}) {
  const placeholderRef = useRef<HTMLDivElement | null>(null);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- sizes the placeholder node from the chat column before paint, as the drawer sizes itself
  useLayoutEffect(() => {
    const placeholder = placeholderRef.current;
    if (!placeholder) return;
    const layout = readDrawerLayout(chatColumnOf(placeholder));
    const maxHeight = resolveTerminalDrawerMaxHeight({ ...layout, composerHeight });
    placeholder.style.height = `${clampDrawerHeight(height, maxHeight)}px`;
  });
  return (
    <div
      ref={placeholderRef}
      data-thread-terminal-drawer-placeholder
      className="relative flex shrink-0 flex-col overflow-hidden border-t border-border/80 bg-background"
      style={{
        height: `${clampDrawerHeight(height, resolveTerminalDrawerMaxHeight(readDrawerLayout(null)))}px`,
      }}
    >
      {children}
    </div>
  );
}

export function LazyThreadTerminalDrawer(props: ThreadTerminalDrawerProps) {
  return (
    <LazySurfaceBoundary
      surface={drawer}
      props={props}
      label="terminal"
      renderFrame={(content) =>
        props.mode === "panel" ? (
          content
        ) : (
          <DrawerPlaceholder height={props.height} composerHeight={props.composerHeight}>
            {content}
          </DrawerPlaceholder>
        )
      }
    />
  );
}
