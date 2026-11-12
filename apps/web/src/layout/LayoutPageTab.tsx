import { lazy, Suspense } from "react";

import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { validatePullRequestsSearch } from "../components/pullRequest/pullRequestsSearch";
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

/**
 * A page opened as a tab. Pull requests render in the pane against the tab's own URL; Settings
 * and Usage are modals over the layout, so their tab offers the way in.
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
      : parsed;
  return (
    <LayoutPageLocationContext value={location}>
      <div
        data-layout-page-tab={content.kind}
        className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
        {content.kind === "pull-requests" ? (
          <Suspense
            fallback={
              <div className="flex flex-1 items-center justify-center">
                <Spinner size="md" tone="muted" />
              </div>
            }
          >
            <PullRequestsPage />
          </Suspense>
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <Button variant="ghost" onClick={() => void openPage(content.kind)}>
              {content.kind === "settings" ? "Open settings" : "Open usage"}
            </Button>
          </div>
        )}
      </div>
    </LayoutPageLocationContext>
  );
}
