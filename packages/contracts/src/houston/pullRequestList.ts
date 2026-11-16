import * as Schema from "effect/Schema";

/** Which pull requests a listing asks for; `linked` reads threads' saved links, not the host. */
export const PullRequestListInvolvement = Schema.Literals([
  "all",
  "reviewing",
  "authored",
  "linked",
]);
export type PullRequestListInvolvement = typeof PullRequestListInvolvement.Type;
