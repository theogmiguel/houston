/**
 * The server's `IssueTrackerHost`: standalone tracker credentials out of the secret store, one
 * per tracker kind. The name is stable across releases so a saved key survives upgrades. A Notion
 * token saved for the retired task source is moved to that name once, at the first read.
 *
 * @module issue/IssueTrackerHostLive
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import type { IssueTrackerKind } from "@houston-app/contracts";
import { IssueTrackerError } from "@houston-app/source-control-core/server/IssueTracker";
import * as IssueTrackerHost from "@houston-app/source-control-core/server/IssueTrackerHost";

import * as HoustonSecrets from "../houston/secrets/HoustonSecrets.ts";

/** A tracker kind is a lowercase slug, so the name is valid for the secret store as it stands. */
export function issueTrackerSecretName(tracker: IssueTrackerKind): string {
  return `issue-tracker-${tracker}-token`;
}

/** Where the Notion task source kept one project's token before it was retired. */
export function legacyNotionSecretName(projectId: string): string {
  return `houston-tracker-notion-${Buffer.from(projectId, "utf8").toString("base64url")}-integration-token`;
}

const failure = (tracker: IssueTrackerKind, detail: string, cause?: unknown) =>
  new IssueTrackerError({
    tracker,
    operation: "adoptLegacyCredential",
    reason: "failed",
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

const make = Effect.gen(function* () {
  const secrets = yield* HoustonSecrets.HoustonSecrets;
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);

  /** The task source's token, moved to the tracker's one name; absent when there is none. */
  const adoptLegacy = Effect.fn("IssueTrackerHostLive.adoptLegacy")(function* (
    tracker: IssueTrackerKind,
  ) {
    if (Option.isNone(sql)) return;
    const client = sql.value;
    const rows = (yield* client<{ readonly project_id: string }>`
        SELECT project_id FROM houston_issue_tracker_token_adoption WHERE tracker = ${tracker}
      `.pipe(Effect.orElseSucceed((): ReadonlyArray<unknown> => []))) as ReadonlyArray<{
      readonly project_id: string;
    }>;
    const [row] = rows;
    if (row === undefined) return;
    const legacy = yield* secrets
      .get(legacyNotionSecretName(row.project_id))
      .pipe(
        Effect.mapError((cause) =>
          failure(tracker, "The stored task-source token could not be read.", cause),
        ),
      );
    if (Option.isSome(legacy)) {
      yield* secrets
        .set(issueTrackerSecretName(tracker), legacy.value)
        .pipe(
          Effect.mapError((cause) =>
            failure(tracker, "The task-source token could not be moved.", cause),
          ),
        );
      yield* secrets
        .remove(legacyNotionSecretName(row.project_id))
        .pipe(Effect.orElseSucceed(() => undefined));
    }
    yield* client`DELETE FROM houston_issue_tracker_token_adoption WHERE tracker = ${tracker}`.pipe(
      Effect.orDie,
    );
  });

  return IssueTrackerHost.IssueTrackerHost.of({
    credentials: {
      get: (tracker) =>
        secrets.get(issueTrackerSecretName(tracker)).pipe(
          Effect.mapError(
            (cause) =>
              new IssueTrackerError({
                tracker,
                operation: "readCredential",
                reason: "failed",
                detail: "The stored credential could not be read.",
                cause,
              }),
          ),
          Effect.flatMap((stored) =>
            Option.isSome(stored)
              ? Effect.succeed(Option.map(stored, Redacted.value))
              : adoptLegacy(tracker).pipe(
                  Effect.flatMap(() => secrets.get(issueTrackerSecretName(tracker))),
                  Effect.map(Option.map(Redacted.value)),
                  Effect.mapError(
                    (cause) =>
                      new IssueTrackerError({
                        tracker,
                        operation: "readCredential",
                        reason: "failed",
                        detail: "The stored credential could not be read.",
                        cause,
                      }),
                  ),
                ),
          ),
        ),
    },
  });
});

export const layer = Layer.effect(IssueTrackerHost.IssueTrackerHost, make);
