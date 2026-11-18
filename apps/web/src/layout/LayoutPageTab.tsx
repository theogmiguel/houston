import { lazy, Suspense } from "react";

import { Spinner } from "../components/ui/spinner";
import { validateIssuesSearch } from "../components/issue/issuesSearch";
import { validatePullRequestsSearch } from "../components/pullRequest/pullRequestsSearch";
import { validateTasksSearch } from "../components/tasks/tasksSearch";
import type { LayoutPageContent } from "./layoutModel";
import { LayoutPageLocationContext, parseLayoutPageLocation } from "./pageNavigation";

const PullRequestsPage = lazy(() =>
  import("../components/pullRequest/PullRequestsPage").then((module) => ({
    default: module.PullRequestsPage,
  })),
);

const IssuesPage = lazy(() =>
  import("../components/issue/IssuesPage").then((module) => ({ default: module.IssuesPage })),
);

const TasksPage = lazy(() =>
  import("../components/tasks/TasksPage").then((module) => ({ default: module.TasksPage })),
);

/** A page opened as a tab, rendered in the pane against the tab's own URL. */
export function LayoutPageTab({ content }: { readonly content: LayoutPageContent }) {
  const parsed = parseLayoutPageLocation(content);
  // The route validates its own search, so the tab sees the same shape the routed page does.
  const location =
    content.kind === "pull-requests"
      ? {
          ...parsed,
          search: validatePullRequestsSearch(parsed.search),
        }
      : content.kind === "issues"
        ? { ...parsed, search: validateIssuesSearch(parsed.search) }
        : content.kind === "tasks"
          ? { ...parsed, search: validateTasksSearch(parsed.search) }
          : parsed;
  return (
    <LayoutPageLocationContext value={location}>
      <div
        data-layout-page-tab={content.kind}
        className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
        <Suspense
          fallback={
            <div className="flex flex-1 items-center justify-center">
              <Spinner size="md" tone="muted" />
            </div>
          }
        >
          {content.kind === "pull-requests" ? (
            <PullRequestsPage />
          ) : content.kind === "issues" ? (
            <IssuesPage />
          ) : (
            <TasksPage />
          )}
        </Suspense>
      </div>
    </LayoutPageLocationContext>
  );
}
