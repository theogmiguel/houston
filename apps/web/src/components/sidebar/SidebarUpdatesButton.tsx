import { CircleArrowUpIcon } from "lucide-react";
import { memo, useEffect, useState } from "react";

import { isDesktopHost } from "../../env";
import { CornerDot } from "../ui/corner-dot";
import { dismissVersionMismatch, isVersionMismatchDismissed } from "../../versionSkew";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { DesktopUpdateStatusIcon } from "./DesktopUpdateStatusIcon";
import { SidebarProviderUpdateRow, useSidebarProviderUpdate } from "./SidebarProviderUpdatePill";
import { SidebarUpdateRow, useSidebarUpdate } from "./SidebarUpdatePill";

type UpdatesTone = "failed" | "ready" | "downloading" | "available";

const TONE_PRIORITY: ReadonlyArray<UpdatesTone> = ["failed", "ready", "downloading", "available"];

const PROVIDER_TONES = {
  loading: "downloading",
  success: "available",
  warning: "failed",
  error: "failed",
} as const satisfies Record<string, UpdatesTone>;

/** Remembers the app versions already announced, in the store other per-version dismissals use. */
const announcedKey = (version: string) => `desktop-update:${version}`;

/**
 * One footer icon for everything that can be updated: the app and the agent providers. It shows
 * only while one of them has something to say, names the status in words, and opens a popover
 * with a row per source. Opening it never starts an update; each action sits in its row.
 */
export const SidebarUpdatesButton = memo(function SidebarUpdatesButton() {
  const app = useSidebarUpdate();
  const providers = useSidebarProviderUpdate();
  const [open, setOpen] = useState(false);

  const availableVersion =
    isDesktopHost && app.state?.status === "available" ? app.state.availableVersion : null;
  // A quiet icon is easy to miss, so a new app version is announced once.
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- raises a one-time toast when a new app version first appears
  useEffect(() => {
    if (availableVersion === null) return;
    const key = announcedKey(availableVersion);
    if (isVersionMismatchDismissed(key)) return;
    dismissVersionMismatch(key);
    toastManager.add(
      stackedThreadToast({
        type: "info",
        title: `Houston ${availableVersion} is available`,
        description: "Open the update button in the sidebar footer to download it.",
        actionProps: { children: "View", onClick: () => setOpen(true) },
      }),
    );
  }, [availableVersion]);

  const appVisible = app.visible;
  const providerView = providers.view;
  if (!appVisible && providerView === null) return null;

  const tones: UpdatesTone[] = [
    ...(appVisible ? [app.tone] : []),
    ...(providerView === null ? [] : [PROVIDER_TONES[providerView.tone]]),
  ];
  const tone = TONE_PRIORITY.find((candidate) => tones.includes(candidate)) ?? "available";
  const parts = [
    ...(appVisible && app.summary !== null ? [app.summary] : []),
    ...(providerView === null ? [] : [providerView.title]),
  ];
  const label = parts.length > 1 ? `Updates: ${parts.join("; ")}` : (parts[0] ?? "Updates");
  const appDownloading = appVisible && app.tone === "downloading" && app.run === null;

  return (
    <>
      <SidebarMenuItem className="shrink-0">
        <Popover open={open} onOpenChange={setOpen}>
          <Tooltip>
            <TooltipTrigger
              render={
                <PopoverTrigger
                  render={
                    <SidebarMenuButton
                      aria-label={label}
                      data-sidebar-updates=""
                      data-update-status={tone}
                      size="icon"
                      className="relative size-7 [&_svg]:size-[15px]"
                    />
                  }
                />
              }
            >
              {tone === "downloading" ? (
                <DesktopUpdateStatusIcon
                  status="downloading"
                  downloadPercent={appDownloading ? (app.state?.downloadPercent ?? null) : null}
                />
              ) : (
                <CircleArrowUpIcon />
              )}
              {tone === "downloading" ? null : <CornerDot tone={tone} />}
            </TooltipTrigger>
            <TooltipPopup side="top">{label}</TooltipPopup>
          </Tooltip>
          <PopoverPopup side="top" align="end" aria-label="Updates" width="lg">
            <div className="flex min-w-0 flex-col gap-3 py-3">
              <SidebarUpdateRow model={app} onClose={() => setOpen(false)} />
              <SidebarProviderUpdateRow model={providers} onNavigate={() => setOpen(false)} />
            </div>
          </PopoverPopup>
        </Popover>
      </SidebarMenuItem>
      {app.confirmDialog}
    </>
  );
});
