import { lazy, Suspense } from "react";

import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { validatePullRequestsSearch } from "../components/pullRequest/pullRequestsSearch";
import { validateTasksSearch } from "../components/tasks/tasksSearch";
import type { LayoutPageContent } from "./layoutModel";
import {
  LayoutPageLocationContext,
  parseLayoutPageLocation,
  useOpenLayoutPage,
} from "./pageNavigation";

const PullRequestsPage = lazy(() =>
  import("../components/pullRequest/PullRequestsPage").then((module) => ({
    default: module.PullRequestsPage,
  })),
);

const TasksPage = lazy(() =>
  import("../components/tasks/TasksPage").then((module) => ({ default: module.TasksPage })),
);

/**
 * A page opened as a tab. Pull requests and Tasks render in the pane against the tab's own URL;
 * Settings is a card over the layout, so its tab offers the way in.
 */
export function LayoutPageTab({ content }: { readonly content: LayoutPageContent }) {
  const openPage = useOpenLayoutPage();
  const parsed = parseLayoutPageLocation(content);
  // The route validates its own search, so the tab sees the same shape the routed page does.
  const location =
    content.kind === "pull-requests"
      ? {
          ...parsed,
          search: validatePullRequestsSearch(parsed.search),
        }
      : content.kind === "tasks"
        ? { ...parsed, search: validateTasksSearch(parsed.search) }
        : parsed;
  return (
    <LayoutPageLocationContext value={location}>
      <div
        data-layout-page-tab={content.kind}
        className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
        {content.kind === "settings" ? (
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <Button variant="ghost" onClick={() => void openPage("settings")}>
              Open settings
            </Button>
          </div>
        ) : (
          <Suspense
            fallback={
              <div className="flex flex-1 items-center justify-center">
                <Spinner size="md" tone="muted" />
              </div>
            }
          >
            {content.kind === "pull-requests" ? <PullRequestsPage /> : <TasksPage />}
          </Suspense>
        )}
      </div>
    </LayoutPageLocationContext>
  );
}
