import type {
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
} from "@houston-app/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isStalePullRequestWatchWake } from "./Orchestrator.ts";
import { PULL_REQUEST_WATCH_WAKE_MESSAGE_PREFIX } from "./pullRequestWatch.ts";

const URL_7 = "https://github.com/acme/app/pull/7";
const URL_71 = "https://github.com/acme/app/pull/71";

function threadLinking(url: string, watched: boolean): OrchestrationV2AppThread {
  return {
    pullRequests: [{ url, ...(watched ? { watch: { active: true } } : {}) }],
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    settledAt: null,
    lineage: { relationshipToParent: null },
    creationSource: "user",
  } as unknown as OrchestrationV2AppThread;
}

function message(
  id: string,
  text: string,
  kind: "monitor" | "user" = "monitor",
): Pick<OrchestrationV2ConversationMessage, "id" | "text" | "notification"> {
  return { id, text, notification: { source: { kind } } } as never;
}

describe("a pull request watch wake that is stale", () => {
  it("leaves a user's own monitor notification alone even when it names a linked pull request", () => {
    expect(
      isStalePullRequestWatchWake(
        threadLinking(URL_7, false),
        message("message:monitor:build", `Build finished for ${URL_7}`),
      ),
    ).toBe(false);
  });

  it("cancels a watch wake once its watch has ended", () => {
    expect(
      isStalePullRequestWatchWake(
        threadLinking(URL_7, false),
        message(`${PULL_REQUEST_WATCH_WAKE_MESSAGE_PREFIX}wake-1`, `Checks changed on ${URL_7}`),
      ),
    ).toBe(true);
  });

  it("keeps a watch wake while its watch is live", () => {
    expect(
      isStalePullRequestWatchWake(
        threadLinking(URL_7, true),
        message(`${PULL_REQUEST_WATCH_WAKE_MESSAGE_PREFIX}wake-2`, `Checks changed on ${URL_7}`),
      ),
    ).toBe(false);
  });

  it("does not take a longer pull request number for the watched one", () => {
    expect(
      isStalePullRequestWatchWake(
        threadLinking(URL_7, true),
        message(`${PULL_REQUEST_WATCH_WAKE_MESSAGE_PREFIX}wake-3`, `Checks changed on ${URL_71}`),
      ),
    ).toBe(true);
  });
});
