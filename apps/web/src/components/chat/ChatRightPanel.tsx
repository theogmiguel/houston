import { ArrowLeftIcon } from "lucide-react";
import { useEffect } from "react";

import { useIsPhone } from "../../mobile/usePhone";
import { usePreviewPanelInlineSize } from "../../hooks/usePreviewPanelInlineSize";
import type { RightPanelSurface } from "../../rightPanelStore";
import { Button } from "../ui/button";
import { RightPanelSheet } from "../RightPanelSheet";
import { RightPanelTabs, type RightPanelTabsProps } from "../RightPanelTabs";

type ChatRightPanelProps = Omit<RightPanelTabsProps, "mode" | "inlineSize" | "maximized"> & {
  readonly sheet: boolean;
  readonly maximized: boolean;
  readonly workspaceLayoutElement: HTMLElement | null;
  readonly widthStorageKey: string;
  readonly onCloseSheet: () => void;
};

// The phone has no terminal or browser surface: neither can be created there, and a tab
// restored from another device must not open a desktop-only surface.
function hiddenOnPhone(surface: RightPanelSurface): boolean {
  return surface.kind === "terminal" || surface.kind === "preview";
}

/**
 * The right panel, inline beside the chat column or as a sheet on narrow
 * layouts. Its width follows a resize drag every frame, so the width state
 * lives here rather than in ChatView.
 */
export function ChatRightPanel(props: ChatRightPanelProps) {
  const {
    sheet,
    workspaceLayoutElement,
    widthStorageKey,
    onCloseSheet,
    maximized,
    layoutControls,
    ...tabs
  } = props;
  const inlineSize = usePreviewPanelInlineSize({
    container: workspaceLayoutElement,
    widthStorageKey,
  });
  const isPhone = useIsPhone();
  const {
    activeSurfaceId: storedActiveSurfaceId,
    surfaces: allSurfaces,
    onActivate: activateSurface,
  } = tabs;
  const surfaces = isPhone ? allSurfaces.filter((surface) => !hiddenOnPhone(surface)) : allSurfaces;
  const activeSurfaceId =
    storedActiveSurfaceId !== null &&
    surfaces.some((surface) => surface.id === storedActiveSurfaceId)
      ? storedActiveSurfaceId
      : null;
  // A restored desktop tab can be active while its surface is hidden here.
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- activates a visible surface when the stored active one is desktop-only
  useEffect(() => {
    if (!isPhone || storedActiveSurfaceId === null) return;
    if (
      allSurfaces.some((surface) => surface.id === storedActiveSurfaceId && !hiddenOnPhone(surface))
    )
      return;
    const first = allSurfaces.find((surface) => !hiddenOnPhone(surface));
    if (first !== undefined) activateSurface(first);
  }, [isPhone, storedActiveSurfaceId, allSurfaces, activateSurface]);
  if (!sheet && !isPhone) {
    return (
      <RightPanelTabs
        {...tabs}
        layoutControls={layoutControls}
        mode="inline"
        maximized={maximized}
        inlineSize={inlineSize}
      />
    );
  }
  return (
    <RightPanelSheet open={tabs.open === true} onClose={onCloseSheet} phone={isPhone}>
      <RightPanelTabs
        {...tabs}
        surfaces={surfaces}
        activeSurfaceId={activeSurfaceId}
        mode="sheet"
        inlineSize={inlineSize}
        layoutControls={isPhone ? null : layoutControls}
        leadingControl={
          isPhone ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-11"
              aria-label="Back to thread"
              onClick={onCloseSheet}
            >
              <ArrowLeftIcon className="size-4" />
            </Button>
          ) : undefined
        }
        phone={isPhone}
      />
    </RightPanelSheet>
  );
}
