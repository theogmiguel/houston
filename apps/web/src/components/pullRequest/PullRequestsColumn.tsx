import type { PullRequestInvolvement, PullRequestListState } from "@houston-app/contracts";
import { Plug2Icon, SearchIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { isDesktopHost } from "~/env";
import { observeIntersection } from "~/lib/observeIntersection";
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

function ExpandableSearch({
  searchInput,
  searchValue,
  open,
  onOpenChange,
  onFocusWithin,
}: {
  searchInput: ReactNode;
  searchValue: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * An unmount fires no blur, which is the point: whoever unmounted this can still see the reader
   * was mid-typing and move the focus somewhere that continues the sentence.
   */
  onFocusWithin?: (focused: boolean) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- focuses the search input DOM node when the topbar search opens
  useEffect(() => {
    if (!open) return;
    containerRef.current?.querySelector("input")?.focus();
  }, [open]);
  if (open || searchValue.length > 0) {
    return (
      <div
        ref={containerRef}
        className="w-56 min-w-24 shrink"
        onFocus={() => onFocusWithin?.(true)}
        onBlur={() => {
          onFocusWithin?.(false);
          if (searchValue.length === 0) onOpenChange(false);
        }}
      >
        {searchInput}
      </div>
    );
  }
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label="Search pull requests"
      onClick={() => onOpenChange(true)}
    >
      <SearchIcon className="size-4" />
    </Button>
  );
}

export function PullRequestsColumn({
  refreshing,
  onRefresh,
  searchValue,
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
  searchValue: string;
  involvement: PullRequestInvolvement;
  state: PullRequestListState;
  host: string | undefined;
  hostMenuOptions: ReadonlyArray<PullRequestFilterOption<string>>;
  onInvolvement: (involvement: PullRequestInvolvement) => void;
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
  const markerRef = useRef<HTMLDivElement | null>(null);
  const [condensed, setCondensed] = useState(false);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- IntersectionObserver on the scroll marker condenses the topbar
  useEffect(() => {
    const marker = markerRef.current;
    if (!marker) return;
    return observeIntersection(marker, (entry) => setCondensed(!phone && !entry.isIntersecting), {
      root: scrollRef.current,
    });
  }, [phone, scrollRef]);
  // Typing into the topbar search narrows the list, and a short enough list un-scrolls the
  // page — which dissolves the condensed topbar and unmounts the very input being typed in.
  const topbarSearchFocusedRef = useRef(false);
  const inFlowSearchRef = useRef<HTMLDivElement | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const topbarSearchRef = useRef<HTMLDivElement | null>(null);
  const searchExpanded = searchOpen || searchValue.length > 0;
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- window keydown listener focuses the visible search input on Cmd/Ctrl+F
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key.toLowerCase() !== "f" || !(event.metaKey || event.ctrlKey)) return;
      if (event.altKey || event.shiftKey) return;
      event.preventDefault();
      // A closed topbar search has no input yet; opening it mounts one that focuses itself.
      if (condensed) setSearchOpen(true);
      const input = (condensed ? topbarSearchRef : inFlowSearchRef).current?.querySelector("input");
      input?.focus();
      input?.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [condensed]);
  if (!condensed && searchOpen) setSearchOpen(false);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- moves DOM focus to the in-flow search when the topbar search it was typed in unmounts
  useEffect(() => {
    if (condensed) return;
    if (!topbarSearchFocusedRef.current) return;
    topbarSearchFocusedRef.current = false;
    const input = inFlowSearchRef.current?.querySelector("input");
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [condensed]);

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
          {condensed ? (
            <WorkspaceBreadcrumb ariaLabel="Pull request scope" className="overflow-hidden">
              <WorkspaceBreadcrumbItem current className={cn(searchExpanded && "sr-only")}>
                <h1 className="truncate">Pull requests</h1>
              </WorkspaceBreadcrumbItem>
              {searchExpanded ? null : <WorkspaceBreadcrumbSeparator />}
              {view === "requests" ? (
                <WorkspaceBreadcrumbItem className="shrink gap-1.5">
                  <PullRequestCompactFilterMenu
                    label="Filter by state"
                    value={state}
                    options={STATE_TABS}
                    onChange={onState}
                    className="shrink-0"
                  />
                  <PullRequestCompactFilterMenu
                    label="Filter by involvement"
                    value={involvement}
                    options={INVOLVEMENT_TABS}
                    onChange={onInvolvement}
                  />
                  {hostMenuOptions.length > 2 ? (
                    <PullRequestCompactFilterMenu
                      label="Filter by host"
                      value={host ?? ""}
                      options={hostMenuOptions}
                      onChange={(next) => onHost(next === "" ? undefined : next)}
                    />
                  ) : null}
                </WorkspaceBreadcrumbItem>
              ) : null}
            </WorkspaceBreadcrumb>
          ) : (
            <WorkspaceBreadcrumb ariaLabel="Pull requests breadcrumb">
              <WorkspaceBreadcrumbItem current>
                <h1 className="truncate">Pull requests</h1>
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
          )}
          {phone ? null : viewToggle}
          <div className="min-w-0 flex-1" />
          {condensed && view === "requests" ? (
            <div ref={topbarSearchRef} className="flex shrink items-center gap-1.5">
              <ExpandableSearch
                searchInput={searchInput}
                searchValue={searchValue}
                open={searchOpen}
                onOpenChange={setSearchOpen}
                onFocusWithin={(focused) => {
                  topbarSearchFocusedRef.current = focused;
                }}
              />
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
          className="min-h-full gap-4 max-phone:px-4 max-phone:pt-3"
        >
          {view === "queue" ? (
            queueBody
          ) : (
            <>
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2 max-phone:flex-nowrap">
                  <ToggleGroup
                    aria-label="Pull request involvement"
                    variant="segmented"
                    className="max-phone:w-full max-phone:*:h-11 max-phone:*:flex-1 max-phone:*:px-1 max-phone:*:leading-4 max-phone:*:whitespace-normal max-phone:*:text-balance"
                    value={[involvement]}
                    onValueChange={(next) => {
                      const value = next[0];
                      if (value) onInvolvement(value as PullRequestInvolvement);
                    }}
                  >
                    {INVOLVEMENT_TABS.map((option) => (
                      <Toggle key={option.value} value={option.value}>
                        {option.label}
                      </Toggle>
                    ))}
                  </ToggleGroup>
                  <div className="min-w-0 flex-1 max-phone:hidden" />
                  {!condensed && !phone ? (
                    <PullRequestRefreshControl refreshing={refreshing} onRefresh={onRefresh} />
                  ) : null}
                </div>
                <div ref={inFlowSearchRef} className="flex flex-wrap items-center gap-2 max-phone:gap-y-3">
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
                <div ref={markerRef} aria-hidden className="-mt-3 h-px w-full" />
              </div>

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
