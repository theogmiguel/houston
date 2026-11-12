import type { PullRequestListInvolvement, PullRequestListState } from "@houston-app/contracts";
import { Plug2Icon } from "lucide-react";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";

import { isDesktopHost } from "~/env";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { MERGE_QUEUE_COUNT_BADGE, MERGE_QUEUE_COUNT_BADGE_PARKED } from "../ui/merge-queue-recipes";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { PhonePageBar } from "../../mobile/PhonePageBar";
import { PullRequestCompactFilterMenu } from "./PullRequestCompactFilterMenu";
import type { PullRequestFilterOption } from "./PullRequestListFilters";
import { INVOLVEMENT_TABS, STATE_TABS } from "./pullRequestListOptions";

export function PullRequestsColumn({
  refreshing,
  onRefresh,
  involvement,
  state,
  host,
  hostMenuOptions,
  onInvolvement,
  onState,
  onHost,
  searchInput,
  sortMenu,
  filtersMenu,
  rightPanelControl,
  titlebarControls,
  rightPanelOpen,
  maximizedAway,
  view,
  onView,
  queueCount,
  queueParked,
  listBody,
  queueBody,
  scrollRef,
  phone = false,
}: {
  /** A phone swaps the desktop top bar for its own bar and stacks the controls at 44px. */
  phone?: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  involvement: PullRequestListInvolvement;
  state: PullRequestListState;
  host: string | undefined;
  hostMenuOptions: ReadonlyArray<PullRequestFilterOption<string>>;
  onInvolvement: (involvement: PullRequestListInvolvement) => void;
  onState: (state: PullRequestListState) => void;
  onHost: (host: string | undefined) => void;
  searchInput: ReactNode;
  sortMenu: ReactNode;
  filtersMenu: ReactNode;
  rightPanelControl: ReactNode;
  titlebarControls: ReactNode;
  rightPanelOpen: boolean;
  maximizedAway: boolean;
  view: "requests" | "queue";
  onView: (view: "requests" | "queue") => void;
  queueCount: number | null;
  queueParked: boolean;
  listBody: ReactNode;
  queueBody: ReactNode;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const contentArea = workspaceAreaProps("pull-requests", 1, "Pull requests");
  const searchRootRef = useRef<HTMLDivElement | null>(null);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- window keydown listener focuses the visible search input on Cmd/Ctrl+F
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key.toLowerCase() !== "f" || !(event.metaKey || event.ctrlKey)) return;
      if (event.altKey || event.shiftKey) return;
      event.preventDefault();
      const input = searchRootRef.current?.querySelector("input");
      input?.focus();
      input?.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const viewToggle = (
    <ToggleGroup
      aria-label="Pull request view"
      variant="segmented"
      className="max-phone:w-full max-phone:*:h-11 max-phone:*:flex-1"
      value={[view]}
      onValueChange={(next) => {
        const value = next[0];
        if (value === "requests" || value === "queue") onView(value);
      }}
    >
      <Toggle value="requests">Requests</Toggle>
      <Toggle value="queue">
        Merge queue
        {queueCount === null ? null : (
          <span className={queueParked ? MERGE_QUEUE_COUNT_BADGE_PARKED : MERGE_QUEUE_COUNT_BADGE}>
            {queueCount}
          </span>
        )}
      </Toggle>
    </ToggleGroup>
  );

  return (
    <div
      {...contentArea}
      inert={maximizedAway}
      className={cn(
        "@container/pr-list flex min-h-0 min-w-0 flex-col overflow-x-hidden bg-background",
        // The list takes whatever the right panel leaves; the panel's left-edge handle sets the split.
        maximizedAway ? "w-0 flex-none" : "flex-1",
      )}
    >
      {phone ? (
        <>
          <PhonePageBar title="Pull requests">
            {view === "requests" ? (
              <PullRequestRefreshControl phoneBar refreshing={refreshing} onRefresh={onRefresh} />
            ) : null}
          </PhonePageBar>
          <div className="shrink-0 px-4 pt-3">{viewToggle}</div>
        </>
      ) : (
        <WorkspacePageHeader
          desktop={isDesktopHost}
          reserveNativeControls={!rightPanelOpen}
          className="relative bg-background"
        >
          {titlebarControls}
          <WorkspaceBreadcrumb ariaLabel="Pull requests breadcrumb">
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">Pull requests</h1>
            </WorkspaceBreadcrumbItem>
            {view === "requests" ? (
              <>
                <WorkspaceBreadcrumbSeparator />
                <WorkspaceBreadcrumbItem className="shrink">
                  <PullRequestCompactFilterMenu
                    label="Filter by provider"
                    value={host ?? ""}
                    options={hostMenuOptions}
                    onChange={(next) => onHost(next === "" ? undefined : next)}
                  />
                </WorkspaceBreadcrumbItem>
              </>
            ) : null}
          </WorkspaceBreadcrumb>
          {viewToggle}
          <div className="min-w-0 flex-1" />
          {view === "requests" ? (
            <div ref={searchRootRef} className="flex shrink items-center gap-1">
              <PullRequestCompactFilterMenu
                label="Filter by state"
                value={state}
                options={STATE_TABS}
                onChange={onState}
              />
              {sortMenu}
              {filtersMenu}
              <div className="w-56 min-w-24 shrink">{searchInput}</div>
              <PullRequestRefreshControl compact refreshing={refreshing} onRefresh={onRefresh} />
            </div>
          ) : null}
          {rightPanelControl}
        </WorkspacePageHeader>
      )}

      <div
        ref={scrollRef}
        className="topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto max-phone:[scrollbar-gutter:auto]"
      >
        <WorkspacePageContainer
          width="expanded"
          className="min-h-full gap-3 max-phone:px-4 max-phone:pt-3"
        >
          {view === "queue" ? (
            queueBody
          ) : (
            <>
              {phone ? (
              <div ref={searchRootRef} className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2 max-phone:flex-nowrap max-phone:[&_[data-slot=toggle-group]>*]:px-1 max-phone:[&_[data-slot=toggle-group]>*]:leading-4 max-phone:[&_[data-slot=toggle-group]>*]:whitespace-normal max-phone:[&_[data-slot=toggle-group]>*]:text-balance">
                  <ToggleGroup
                    aria-label="Pull request involvement"
                    variant="segmented"
                    className="max-phone:w-full max-phone:*:h-11 max-phone:*:flex-1"
                    value={[involvement]}
                    onValueChange={(next) => {
                      const value = next[0];
                      if (value) onInvolvement(value as PullRequestListInvolvement);
                    }}
                  >
                    {INVOLVEMENT_TABS.map((option) => (
                      <Toggle key={option.value} value={option.value}>
                        {option.label}
                      </Toggle>
                    ))}
                  </ToggleGroup>
                  <div className="min-w-0 flex-1 max-phone:hidden" />
                </div>
                <div className="flex flex-wrap items-center gap-2 max-phone:gap-y-3">
                  <div className="min-w-0 basis-full @lg/pr-list:basis-0 @lg/pr-list:flex-1">
                    {searchInput}
                  </div>
                  {sortMenu}
                  {filtersMenu}
                  <PullRequestCompactFilterMenu
                    label="Filter by provider"
                    outlined
                    iconOnly={host !== undefined}
                    triggerIcon={<Plug2Icon aria-hidden className="size-4" />}
                    triggerLabel="All"
                    value={host ?? ""}
                    options={hostMenuOptions}
                    onChange={(next) => onHost(next === "" ? undefined : next)}
                  />
                </div>
              </div>
              ) : null}

              {listBody}
            </>
          )}
        </WorkspacePageContainer>
      </div>
    </div>
  );
}

function PullRequestRefreshControl({
  compact = false,
  phoneBar = false,
  refreshing,
  onRefresh,
}: {
  compact?: boolean;
  /** The phone bar's trailing icon: 44px, its glyph on the 16px gutter. */
  phoneBar?: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <Button
      size={compact || phoneBar ? "icon-sm" : "icon"}
      variant={compact || phoneBar ? "ghost" : "outline"}
      className={phoneBar ? "-mr-3.5 size-11" : undefined}
      aria-label="Refresh pull requests"
      onClick={onRefresh}
      disabled={refreshing}
    >
      <RefreshIcon size="md" refreshing={refreshing} />
    </Button>
  );
}
