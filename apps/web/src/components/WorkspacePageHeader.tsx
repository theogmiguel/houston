import type { ComponentPropsWithoutRef } from "react";

import { cn } from "../lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";

export function WorkspacePageHeader({
  desktop = false,
  reserveNativeControls = desktop,
  besidePanel = false,
  className,
  ...props
}: ComponentPropsWithoutRef<"header"> & {
  readonly desktop?: boolean;
  readonly reserveNativeControls?: boolean;
  /** A panel's divider follows the header, so its controls keep a small inset from it. */
  readonly besidePanel?: boolean;
}) {
  return (
    <header
      data-drag-region="deep"
      className={cn(
        "flex h-[var(--workspace-topbar-height)]! min-h-[var(--workspace-topbar-height)]! max-h-[var(--workspace-topbar-height)]! shrink-0 items-center gap-3 pl-(--workspace-gutter-start) pr-(--workspace-gutter-end)",
        desktop && "drag-region",
        reserveNativeControls &&
          "wco:pr-(--workspace-native-controls-inset) custom-chrome:pr-(--workspace-native-controls-inset)",
        COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        besidePanel && "pr-2",
        className,
      )}
      {...props}
    />
  );
}
