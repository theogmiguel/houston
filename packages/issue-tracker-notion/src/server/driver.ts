import * as Effect from "effect/Effect";

import * as NotionApi from "./NotionApi.ts";
import * as NotionIssueTracker from "./NotionIssueTracker.ts";

/**
 * The Notion tracker over its own API client. Needs the platform HttpClient and the server's
 * `IssueTrackerHost` for the integration token saved in Settings.
 */
export const make = NotionIssueTracker.make.pipe(
  Effect.provideServiceEffect(NotionApi.NotionApi, NotionApi.make({ origin: NotionApi.NOTION_ORIGIN })),
);
