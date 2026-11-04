import type { ComponentPropsWithoutRef } from "react";

import { cn } from "../lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";

export function WorkspacePageHeader({
  desktop = false,
  reserveNativeControls = desktop,
  className,
  ...props
}: ComponentPropsWithoutRef<"header"> & {
  readonly desktop?: boolean;
  readonly reserveNativeControls?: boolean;
}) {
  return (
    <header
      data-tauri-drag-region="deep"
      className={cn(
        "flex h-[var(--workspace-topbar-height)]! min-h-[var(--workspace-topbar-height)]! max-h-[var(--workspace-topbar-height)]! shrink-0 items-center gap-3 pl-(--workspace-gutter-start) pr-(--workspace-gutter-end) [[data-panel-animations=true]_&]:motion-safe:transition-[padding-left,padding-right] [[data-panel-animations=true]_&]:motion-safe:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:motion-safe:ease-out",
        desktop && "drag-region",
        reserveNativeControls &&
          "wco:pr-(--workspace-native-controls-inset) custom-chrome:pr-(--workspace-native-controls-inset)",
        COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        className,
      )}
      {...props}
    />
  );
}
