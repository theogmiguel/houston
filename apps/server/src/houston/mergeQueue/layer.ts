// The merge queue over its store. `adapters` provides GitHub's client, upstream's pull request
// reads and the project's threads: the server passes the real ones, tests the in-process fakes.
// One slot, reader and runner.
import type * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as Layer from "effect/Layer";

import type * as PullRequestService from "../../pullRequest/PullRequestService.ts";
import * as BuildSlot from "./BuildSlot.ts";
import * as GitHubQueueClient from "./GitHubQueueClient.ts";
import * as Landing from "./Landing.ts";
import * as Outcomes from "./Outcomes.ts";
import * as Project from "./Project.ts";
import * as Reader from "./Reader.ts";
import * as Runner from "./Runner.ts";
import * as Service from "./Service.ts";
import type * as Threads from "./Threads.ts";
import * as Verifier from "./Verifier.ts";

export const layerMergeQueue = <E, R>(
  adapters: Layer.Layer<
    | GitHubRest.GitHubRest
    | PullRequestService.PullRequestService
    | Threads.HoustonMergeQueueThreads,
    E,
    R
  >,
  options: { readonly loops: boolean } = { loops: true },
) =>
  Service.layer.pipe(
    Layer.provideMerge(Runner.layer(options)),
    Layer.provideMerge(Landing.layer),
    Layer.provideMerge(Reader.layer(options)),
    Layer.provideMerge(Outcomes.layer),
    Layer.provideMerge(GitHubQueueClient.layer),
    Layer.provideMerge(Project.layer),
    Layer.provideMerge(Verifier.layer),
    Layer.provideMerge(BuildSlot.layer),
    Layer.provideMerge(adapters),
  );
