// The one-time move of the retired Notion task source's token into the tracker's secret.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as IssueTrackerHost from "@houston-app/source-control-core/server/IssueTrackerHost";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as HoustonSecrets from "../houston/secrets/HoustonSecrets.ts";
import * as HostLive from "./IssueTrackerHostLive.ts";

const NOTION = "notion" as never;

const layerFor = (secrets: HoustonSecrets.MemorySecrets) =>
  HostLive.layer.pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(HoustonSecrets.layerMemory(secrets)),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const seedAdoption = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO houston_issue_tracker_token_adoption (tracker, project_id)
    VALUES ('notion', 'p1')
  `;
});

describe("the retired Notion task source's token", () => {
  it.effect("moves into the tracker's secret on its first read", () => {
    const secrets = HoustonSecrets.makeMemory();
    secrets.entries.set(HostLive.legacyNotionSecretName("p1"), "ntn_task_source");
    return Effect.gen(function* () {
      yield* seedAdoption;
      const host = yield* IssueTrackerHost.IssueTrackerHost;
      const stored = yield* host.credentials.get(NOTION);
      assert.deepEqual(stored, Option.some("ntn_task_source"));
      assert.strictEqual(secrets.entries.get("issue-tracker-notion-token"), "ntn_task_source");
      assert.isFalse(secrets.entries.has(HostLive.legacyNotionSecretName("p1")));
      const sql = yield* SqlClient.SqlClient;
      assert.deepEqual(yield* sql`SELECT * FROM houston_issue_tracker_token_adoption`, []);
      assert.deepEqual(yield* host.credentials.get(NOTION), Option.some("ntn_task_source"));
    }).pipe(Effect.provide(layerFor(secrets)));
  });

  it.effect("an adoption record with no stored token leaves the tracker disconnected", () => {
    const secrets = HoustonSecrets.makeMemory();
    return Effect.gen(function* () {
      yield* seedAdoption;
      const host = yield* IssueTrackerHost.IssueTrackerHost;
      assert.isTrue(Option.isNone(yield* host.credentials.get(NOTION)));
      assert.isFalse(secrets.entries.has("issue-tracker-notion-token"));
      const sql = yield* SqlClient.SqlClient;
      assert.deepEqual(yield* sql`SELECT * FROM houston_issue_tracker_token_adoption`, []);
    }).pipe(Effect.provide(layerFor(secrets)));
  });
});
