/**
 * The server's `IssueTrackerHost`: standalone tracker credentials out of the secret store, one
 * per tracker kind. The name is stable across releases so a saved key survives upgrades.
 *
 * @module issue/IssueTrackerHostLive
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type { IssueTrackerKind } from "@houston-app/contracts";
import { IssueTrackerError } from "@houston-app/source-control-core/server/IssueTracker";
import * as IssueTrackerHost from "@houston-app/source-control-core/server/IssueTrackerHost";

import * as HoustonSecrets from "../houston/secrets/HoustonSecrets.ts";

/** A tracker kind is a lowercase slug, so the name is valid for the secret store as it stands. */
export function issueTrackerSecretName(tracker: IssueTrackerKind): string {
  return `issue-tracker-${tracker}-token`;
}

const make = Effect.gen(function* () {
  const secrets = yield* HoustonSecrets.HoustonSecrets;
  return IssueTrackerHost.IssueTrackerHost.of({
    credentials: {
      get: (tracker) =>
        secrets.get(issueTrackerSecretName(tracker)).pipe(
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
    },
  });
});

export const layer = Layer.effect(IssueTrackerHost.IssueTrackerHost, make);
