// The houston.taskSources.* operations: settings checked by rules.ts (and, for Notion, against
// the live schema), the Notion token kept in the OS keychain only, links, sync and subscription.
import type { ProjectId } from "@t3tools/contracts";
import {
  HOUSTON_TASK_SOURCE_LIMITS,
  type HoustonTaskSourceConflictResolveInput,
  type HoustonTaskSourceCredentialClearInput,
  type HoustonTaskSourceCredentialResult,
  type HoustonTaskSourceCredentialSetInput,
  type HoustonTaskSourceError,
  type HoustonTaskSourceLink,
  type HoustonTaskSourceLinksGetInput,
  type HoustonTaskSourceProjectInput,
  type HoustonTaskSourceSettings,
  type HoustonTaskSourceSettingsSetInput,
  type HoustonTaskSourceStreamEvent,
  type HoustonTaskSourceSyncResult,
} from "@t3tools/contracts/houston/taskSources";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { HoustonKeychain } from "../secrets/HoustonKeychain.ts";
import { HoustonTaskStore, nowIso } from "../tasks/TaskStore.ts";
import { NotionClient, fetchSchemas } from "./NotionClient.ts";
import { HoustonTaskSourcePoller } from "./Poller.ts";
import {
  TOKEN_ACCOUNT,
  checkGithubSettings,
  checkNotionSchema,
  checkNotionSettings,
  refuse,
  storedSettings,
} from "./rules.ts";
import { HoustonTaskSourceStore, encodeSettings } from "./SourceStore.ts";
import { HoustonTaskSourceSync } from "./Sync.ts";

const GITHUB_CREDENTIAL = "GitHub Issues uses the GitHub credential in Settings ▸ Source Control";

export class HoustonTaskSourceService extends Context.Service<
  HoustonTaskSourceService,
  {
    readonly getSettings: (
      input: HoustonTaskSourceProjectInput,
    ) => Effect.Effect<ReadonlyArray<HoustonTaskSourceSettings>, HoustonTaskSourceError>;
    readonly setSettings: (
      input: HoustonTaskSourceSettingsSetInput,
    ) => Effect.Effect<HoustonTaskSourceSettings, HoustonTaskSourceError>;
    readonly setCredential: (
      input: HoustonTaskSourceCredentialSetInput,
    ) => Effect.Effect<HoustonTaskSourceCredentialResult, HoustonTaskSourceError>;
    readonly clearCredential: (
      input: HoustonTaskSourceCredentialClearInput,
    ) => Effect.Effect<HoustonTaskSourceCredentialResult, HoustonTaskSourceError>;
    readonly syncNow: (
      input: HoustonTaskSourceProjectInput,
    ) => Effect.Effect<HoustonTaskSourceSyncResult, HoustonTaskSourceError>;
    readonly links: (
      input: HoustonTaskSourceLinksGetInput,
    ) => Effect.Effect<ReadonlyArray<HoustonTaskSourceLink>, HoustonTaskSourceError>;
    readonly resolve: (
      input: HoustonTaskSourceConflictResolveInput,
    ) => Effect.Effect<HoustonTaskSourceLink, HoustonTaskSourceError>;
    readonly subscribe: (
      input: HoustonTaskSourceProjectInput,
    ) => Stream.Stream<HoustonTaskSourceStreamEvent, HoustonTaskSourceError>;
  }
>()("houston/houston/taskSources/SourceService/HoustonTaskSourceService") {}

const failIf = (error: HoustonTaskSourceError | undefined) =>
  error === undefined ? Effect.void : Effect.fail(error);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const store = yield* HoustonTaskSourceStore;
  const tasks = yield* HoustonTaskStore;
  const keychain = yield* HoustonKeychain;
  const notion = yield* NotionClient;
  const poller = yield* HoustonTaskSourcePoller;
  const sync = yield* HoustonTaskSourceSync;

  const requireProject = (operation: string, projectId: ProjectId) =>
    projects.get(projectId).pipe(
      Effect.orDie,
      Effect.flatMap((project) =>
        Option.isSome(project) && project.value.deletedAt === null
          ? Effect.void
          : Effect.fail(refuse("not_found", operation, `no project ${projectId}`)),
      ),
    );

  const getSettings: HoustonTaskSourceService["Service"]["getSettings"] = (input) =>
    requireProject("houston.taskSources.settings.get", input.projectId).pipe(
      Effect.andThen(store.settingsOf(input.projectId)),
    );

  const setSettings: HoustonTaskSourceService["Service"]["setSettings"] = Effect.fn(
    "HoustonTaskSourceService.setSettings",
  )(function* (input) {
    const operation = "houston.taskSources.settings.set";
    yield* requireProject(operation, input.projectId);
    const settings = storedSettings(input.settings);
    yield* failIf(
      input.provider === "github_issues"
        ? checkGithubSettings(operation, settings)
        : checkNotionSettings(operation, settings),
    );
    if (input.provider === "notion" && settings.enabled) {
      const read = yield* Effect.result(
        keychain.get(store.tokenService(input.projectId, "notion"), TOKEN_ACCOUNT),
      );
      if (read._tag === "Failure") {
        return yield* refuse("keychain_unavailable", operation, read.failure.message);
      }
      if (Option.isNone(read.success)) {
        return yield* refuse(
          "credential_missing",
          operation,
          "connect the Notion integration token before enabling Notion",
        );
      }
      const schemas = yield* fetchSchemas(read.success.value, settings).pipe(
        Effect.provideService(NotionClient, notion),
        Effect.mapError((message) =>
          refuse("remote", operation, `reading the Notion data source schema failed: ${message}`),
        ),
      );
      const checked = checkNotionSchema(operation, settings, schemas.task, schemas.projects);
      if (!("statusType" in checked)) return yield* checked;
    }
    yield* store.write(
      Effect.gen(function* () {
        const row = yield* store.settingsRow(input.projectId, input.provider);
        const actual = row?.revision ?? 0;
        if (input.expectedRevision !== undefined && input.expectedRevision !== actual) {
          return yield* refuse(
            "conflict",
            operation,
            `${input.provider} settings of ${input.projectId} expected revision ${input.expectedRevision}, actual revision ${actual}`,
            { expected: input.expectedRevision, actual },
          );
        }
        const now = yield* nowIso;
        yield* sql`
          INSERT INTO houston_task_source_settings (
            project_id, provider, enabled, settings_json, revision, updated_at
          ) VALUES (
            ${input.projectId}, ${input.provider}, ${settings.enabled ? 1 : 0},
            ${encodeSettings(settings)}, 1, ${now}
          )
          ON CONFLICT (project_id, provider) DO UPDATE SET enabled = excluded.enabled,
            settings_json = excluded.settings_json, revision = revision + 1,
            updated_at = excluded.updated_at
        `.pipe(Effect.orDie);
        return { result: undefined, touched: [], events: [] };
      }),
    );
    const all = yield* store.settingsOf(input.projectId);
    return all.find((entry) => entry.provider === input.provider) as HoustonTaskSourceSettings;
  });

  const setCredential: HoustonTaskSourceService["Service"]["setCredential"] = Effect.fn(
    "HoustonTaskSourceService.setCredential",
  )(function* (input) {
    const operation = "houston.taskSources.credential.set";
    yield* requireProject(operation, input.projectId);
    if (input.provider === "github_issues") {
      return yield* refuse("unsupported", operation, GITHUB_CREDENTIAL);
    }
    const token = Redacted.value(input.token).trim();
    if (token.length === 0) {
      return yield* refuse("invalid", operation, "the Notion integration token is empty");
    }
    const size = Buffer.byteLength(token, "utf8");
    if (size > HOUSTON_TASK_SOURCE_LIMITS.tokenBytes) {
      return yield* refuse(
        "limit",
        operation,
        `the Notion integration token is ${size} bytes, over the limit of ${HOUSTON_TASK_SOURCE_LIMITS.tokenBytes} bytes`,
        { limit: HOUSTON_TASK_SOURCE_LIMITS.tokenBytes, actual: size },
      );
    }
    // The record commits only if the keychain write succeeds, so every entry set is on record.
    yield* store.write(
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO houston_task_source_credentials (project_id, provider)
          VALUES (${input.projectId}, 'notion') ON CONFLICT DO NOTHING
        `.pipe(Effect.orDie);
        yield* keychain
          .set(store.tokenService(input.projectId, "notion"), TOKEN_ACCOUNT, Redacted.make(token))
          .pipe(
            Effect.mapError((error) => refuse("keychain_unavailable", operation, error.message)),
          );
        return { result: undefined, touched: [], events: [] };
      }),
    );
    return { hasCredential: true };
  });

  const clearCredential: HoustonTaskSourceService["Service"]["clearCredential"] = Effect.fn(
    "HoustonTaskSourceService.clearCredential",
  )(function* (input) {
    const operation = "houston.taskSources.credential.clear";
    yield* requireProject(operation, input.projectId);
    if (input.provider === "github_issues") {
      return yield* refuse("unsupported", operation, GITHUB_CREDENTIAL);
    }
    yield* keychain
      .remove(store.tokenService(input.projectId, "notion"), TOKEN_ACCOUNT)
      .pipe(Effect.mapError((error) => refuse("keychain_unavailable", operation, error.message)));
    yield* store.forgetCredential(input.projectId, "notion");
    return { hasCredential: false };
  });

  const syncNow: HoustonTaskSourceService["Service"]["syncNow"] = Effect.fn(
    "HoustonTaskSourceService.syncNow",
  )(function* (input) {
    const operation = "houston.taskSources.syncNow";
    yield* requireProject(operation, input.projectId);
    const results: Array<HoustonTaskSourceSyncResult> = [];
    for (const provider of ["github_issues", "notion"] as const) {
      const result = yield* poller.poll(input.projectId, provider);
      if (result !== null) results.push(result);
    }
    const first = results.find((result) => result.error !== null) ?? results.at(-1);
    if (first === undefined) {
      return yield* refuse("invalid", operation, "no task source is enabled for this project");
    }
    return first;
  });

  const links: HoustonTaskSourceService["Service"]["links"] = (input) =>
    tasks.resolve("houston.taskSources.links.get", input.taskId).pipe(
      Effect.mapError(() =>
        refuse("not_found", "houston.taskSources.links.get", `no task ${input.taskId}`),
      ),
      Effect.flatMap((task) => store.linksOf(task.id)),
    );

  const subscribe: HoustonTaskSourceService["Service"]["subscribe"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* requireProject("houston.taskSources.subscribe", input.projectId);
        // Subscribing before the read keeps every event committed during it.
        const subscription = yield* PubSub.subscribe(store.events);
        const settings = yield* store.settingsOf(input.projectId);
        return Stream.concat(
          Stream.succeed<HoustonTaskSourceStreamEvent>({ snapshot: { settings } }),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((entry) => entry.projectId === input.projectId),
            Stream.map((entry) => entry.event),
          ),
        );
      }),
    );

  return HoustonTaskSourceService.of({
    getSettings,
    setSettings,
    setCredential,
    clearCredential,
    syncNow,
    links,
    resolve: sync.resolve,
    subscribe,
  });
});

export const layer = Layer.effect(HoustonTaskSourceService, make);
