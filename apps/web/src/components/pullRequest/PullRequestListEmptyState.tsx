import { RefreshIcon } from "~/components/ui/refresh-icon";
import { PlusIcon, SearchIcon } from "lucide-react";

import { openAddProjectDialog } from "../AddProjectDialog";
import { Button } from "../ui/button";
import { PhoneEmptyState } from "~/mobile/PhoneEmptyState";
import { useIsPhone } from "~/mobile/usePhone";
import { PullRequestListGhost } from "./PullRequestGhosts";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";

function BranchMark({ joined }: { joined: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 120 72"
      className="h-20 w-32 text-muted-foreground/60"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 58h100" className="text-muted-foreground/30" stroke="currentColor" />
      <circle cx="10" cy="58" r="5" fill="currentColor" fillOpacity={0.25} />
      <circle cx="110" cy="58" r="5" fill="currentColor" fillOpacity={0.25} />
      {joined ? (
        <path d="M30 58c0-18 8-26 24-26h12c16 0 24 8 24 26" />
      ) : (
        <>
          <path d="M30 58c0-18 8-26 24-26h4" />
          <path
            d="M90 58c0-18-8-26-24-26h-4"
            strokeDasharray="2 7"
            className="text-muted-foreground/50"
          />
        </>
      )}
      <circle
        cx="60"
        cy="32"
        r={joined ? 5 : 4}
        fill={joined ? "currentColor" : "none"}
        fillOpacity={0.25}
        className={joined ? undefined : "text-muted-foreground/45"}
      />
    </svg>
  );
}

const clipQuery = (query: string) => (query.length > 48 ? `${query.slice(0, 48)}…` : query);

interface PhoneCopyState {
  hasProjects: boolean;
  query: string;
  filtered: boolean;
}

function phoneTitle({ hasProjects, query, filtered }: PhoneCopyState): string {
  if (!hasProjects) return "No projects in this workspace";
  if (query.length > 0) return `Nothing matches “${clipQuery(query)}”`;
  return filtered ? "Nothing under these filters" : "No pull requests";
}

function phoneBody({ hasProjects, query, filtered }: PhoneCopyState): string {
  if (!hasProjects) return "Add a project, and the pull requests from its repository appear here.";
  if (query.length > 0) return "Try fewer words, or search by number, author or branch.";
  return filtered
    ? "Widen the state, involvement or project filter to see more."
    : "Pull requests from every project in this workspace appear here.";
}

function phoneActions({
  hasProjects,
  query,
  canLoadMore,
  loadingMore,
  refreshing,
  onClearQuery,
  onLoadMore,
  onRefresh,
}: Pick<PhoneCopyState, "hasProjects" | "query"> & {
  canLoadMore: boolean;
  loadingMore: boolean;
  refreshing: boolean;
  onClearQuery: () => void;
  onLoadMore: () => void;
  onRefresh: () => void;
}) {
  if (!hasProjects) {
    return (
      <Button size="touch" onClick={() => openAddProjectDialog()}>
        <PlusIcon className="size-3.5" />
        Add project
      </Button>
    );
  }
  const check = (
    <Button size="touch" variant="outline" disabled={refreshing} onClick={onRefresh}>
      <RefreshIcon size="sm" refreshing={refreshing} />
      {refreshing ? "Checking…" : "Check again"}
    </Button>
  );
  if (query.length > 0) {
    return (
      <>
        <Button size="touch" variant="outline" onClick={onClearQuery}>
          <SearchIcon className="size-3.5" />
          Clear search
        </Button>
        {check}
      </>
    );
  }
  return (
    <>
      {canLoadMore ? (
        <Button size="touch" variant="outline" disabled={loadingMore} onClick={onLoadMore}>
          {loadingMore ? "Loading…" : "Load more pull requests"}
        </Button>
      ) : null}
      {check}
    </>
  );
}

export function PullRequestListEmptyState({
  query,
  filtered,
  searching,
  hasProjects,
  canLoadMore,
  loadingMore,
  refreshing,
  onClearQuery,
  onLoadMore,
  onRefresh,
}: {
  query: string;
  filtered: boolean;
  searching: boolean;
  hasProjects: boolean;
  canLoadMore: boolean;
  loadingMore: boolean;
  refreshing: boolean;
  onClearQuery: () => void;
  onLoadMore: () => void;
  onRefresh: () => void;
}) {
  const phone = useIsPhone();
  if (phone && (!hasProjects || !searching)) {
    return (
      <PhoneEmptyState
        data-pull-request-empty=""
        title={phoneTitle({ hasProjects, query, filtered })}
        action={phoneActions({
          hasProjects,
          query,
          canLoadMore,
          loadingMore,
          refreshing,
          onClearQuery,
          onLoadMore,
          onRefresh,
        })}
      >
        {phoneBody({ hasProjects, query, filtered })}
      </PhoneEmptyState>
    );
  }

  if (!hasProjects) {
    return (
      <Empty>
        <BranchMark joined={false} />
        <EmptyHeader>
          <EmptyTitle>No projects in this workspace</EmptyTitle>
          <EmptyDescription>
            Add a project, and the pull requests from its repository appear here.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" onClick={() => openAddProjectDialog()}>
            <PlusIcon className="size-3.5" />
            Add project
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  if (searching) {
    return (
      <PullRequestListGhost rows={5} caption={`Searching every host for “${clipQuery(query)}”`} />
    );
  }

  if (query.length > 0) {
    return (
      <Empty>
        <BranchMark joined={false} />
        <EmptyHeader>
          <EmptyTitle>
            Nothing matches “{query.length > 48 ? `${query.slice(0, 48)}…` : query}”
          </EmptyTitle>
          <EmptyDescription>
            The hosts were searched for it. Try fewer words, or search by number, author or branch.
          </EmptyDescription>
        </EmptyHeader>
        <div className="flex flex-wrap justify-center gap-2">
          <Button size="sm" variant="outline" onClick={onClearQuery}>
            <SearchIcon className="size-3.5" />
            Clear search
          </Button>
          <Button size="sm" variant="outline" disabled={refreshing} onClick={onRefresh}>
            <RefreshIcon size="sm" refreshing={refreshing} />
            {refreshing ? "Checking..." : "Check again"}
          </Button>
        </div>
      </Empty>
    );
  }

  return (
    <Empty>
      <BranchMark joined={false} />
      <EmptyHeader>
        <EmptyTitle>{filtered ? "Nothing under these filters" : "No pull requests"}</EmptyTitle>
        <EmptyDescription>
          {filtered
            ? "Widen the state, involvement or project filter to see more."
            : "Pull requests from every project in this workspace appear here."}
        </EmptyDescription>
      </EmptyHeader>
      <div className="flex flex-wrap justify-center gap-2">
        {canLoadMore ? (
          <Button size="sm" variant="outline" disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? "Loading..." : "Load more pull requests"}
          </Button>
        ) : null}
        <Button size="sm" variant="outline" disabled={refreshing} onClick={onRefresh}>
          <RefreshIcon size="sm" refreshing={refreshing} />
          {refreshing ? "Checking..." : "Check again"}
        </Button>
      </div>
    </Empty>
  );
}
