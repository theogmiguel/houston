import { Spinner } from "~/components/ui/spinner";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import type { ServerProvider } from "@houston-app/contracts";
import { CircleCheckIcon, DownloadIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import { primaryServerProvidersAtom } from "../../state/server";
import {
  getProviderUpdateSidebarPillView,
  type ProviderUpdateSidebarPillView,
} from "../ProviderUpdateLaunchNotification.logic";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const PROVIDER_UPDATE_ROW_STYLES = {
  loading: "bg-sidebar-control-surface text-sidebar-foreground",
  success: "bg-sidebar-control-surface text-sidebar-foreground",
  warning: "bg-warning/12 text-warning",
  error: "bg-destructive/12 text-destructive",
} as const;

function latestProviderCheckedAt(
  providers: ReadonlyArray<Pick<ServerProvider, "checkedAt">>,
): string | undefined {
  return providers.reduce<string | undefined>(
    (latest, provider) =>
      latest === undefined || provider.checkedAt > latest ? provider.checkedAt : latest,
    undefined,
  );
}

/**
 * What the agent providers' updates have to say: one in-progress, failed, outdated or finished
 * notice at a time. A dismissed notice stays gone until its status changes, and a finished one
 * leaves on its own after `dismissAfterVisibleMs`.
 */
export function useSidebarProviderUpdate() {
  const providers = useAtomValue(primaryServerProvidersAtom);
  const [dismissedKeys, setDismissedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [visibleAfterIso, setVisibleAfterIso] = useState<string | undefined>();
  const effectiveVisibleAfterIso = visibleAfterIso ?? latestProviderCheckedAt(providers);
  const view = getProviderUpdateSidebarPillView(providers, {
    ...(effectiveVisibleAfterIso !== undefined
      ? { visibleAfterIso: effectiveVisibleAfterIso }
      : {}),
    dismissedKeys,
  });
  if (visibleAfterIso === undefined && effectiveVisibleAfterIso !== undefined) {
    setVisibleAfterIso(effectiveVisibleAfterIso);
  }

  const dismiss = (key: string) => setDismissedKeys((previous) => new Set(previous).add(key));
  const dismissAfterVisible = useEffectEvent(dismiss);
  const dismissAfterVisibleMs = view?.dismissAfterVisibleMs;
  const viewKey = view?.key ?? null;
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- timer that dismisses a finished notice after it has been visible for dismissAfterVisibleMs
  useEffect(() => {
    if (!dismissAfterVisibleMs || viewKey === null) return;
    const timeoutId = window.setTimeout(() => dismissAfterVisible(viewKey), dismissAfterVisibleMs);
    return () => window.clearTimeout(timeoutId);
  }, [dismissAfterVisibleMs, viewKey]);

  return { view, dismiss } as const;
}

export type SidebarProviderUpdateModel = ReturnType<typeof useSidebarProviderUpdate>;

/** The agent providers' row in the updates popover. */
export function SidebarProviderUpdateRow({
  model,
  onNavigate,
}: {
  readonly model: SidebarProviderUpdateModel;
  /** Called after the row opens provider settings, so the popover can close. */
  readonly onNavigate?: () => void;
}) {
  const navigate = useNavigate();
  const { view } = model;
  if (view === null) return null;
  return (
    <div
      className={cn(
        "relative flex min-h-7 w-full shrink-0 items-center overflow-hidden rounded-md text-2xs leading-4 font-medium",
        PROVIDER_UPDATE_ROW_STYLES[view.tone],
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={view.description}
              data-provider-update-main
              className="relative z-[1] flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onClick={() => {
                void navigate({ to: "/settings/providers" });
                onNavigate?.();
              }}
            >
              <ProviderUpdateGlyph view={view} />
              <span className="min-w-0 wrap-break-word">{view.title}</span>
            </button>
          }
        />
        <TooltipPopup side="top">{view.description}</TooltipPopup>
      </Tooltip>
      {view.dismissible && (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Dismiss provider update notice"
                className="relative z-[1] mr-1 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md opacity-70 outline-none hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                onClick={() => model.dismiss(view.key)}
              >
                <XIcon className="size-3.5 shrink-0" />
              </button>
            }
          />
          <TooltipPopup side="top">Dismiss until provider status changes</TooltipPopup>
        </Tooltip>
      )}
    </div>
  );
}

function ProviderUpdateGlyph({ view }: { readonly view: ProviderUpdateSidebarPillView }) {
  if (view.tone === "loading") return <Spinner size="sm" className="shrink-0" />;
  if (view.tone === "success") return <CircleCheckIcon className="size-3.5 shrink-0" />;
  if (view.tone === "error") return <TriangleAlertIcon className="size-3.5 shrink-0" />;
  return <DownloadIcon className="size-3.5 shrink-0" />;
}
