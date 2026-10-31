// Task sources over the Tasks store and the source store. `adapters` provides the GitHub client
// and the Notion client: the server passes the real ones, tests pass fakes. The outbox itself is
// provided below the Tasks store, which hands it each write's transitions.
import type * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as Layer from "effect/Layer";

import type { NotionClient } from "./NotionClient.ts";
import * as Outbox from "./Outbox.ts";
import * as Poller from "./Poller.ts";
import * as SourceService from "./SourceService.ts";
import * as Sync from "./Sync.ts";
import * as V1Import from "./V1Import.ts";

export const layerTaskSources = <E, R>(
  adapters: Layer.Layer<GitHubRest.GitHubRest | NotionClient, E, R>,
) =>
  Layer.mergeAll(SourceService.layer, V1Import.layer, Outbox.layerDrain).pipe(
    Layer.provideMerge(Poller.layer),
    Layer.provideMerge(Sync.layer),
    Layer.provideMerge(adapters),
  );
