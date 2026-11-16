import * as Schema from "effect/Schema";

import { AgentSessionImportSource, AgentSessionSource } from "../agentSessions.ts";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "../baseSchemas.ts";
import { ProviderInstanceId } from "../providerInstance.ts";

/** One earlier provider session offered by `/resume`. */
export const HoustonResumeSession = Schema.Struct({
  session: AgentSessionImportSource,
  provider: AgentSessionSource,
  providerInstanceId: ProviderInstanceId,
  providerSessionId: TrimmedNonEmptyString,
  /** The session's saved title, when the provider stores one. */
  title: Schema.NullOr(Schema.String),
  /** The first user prompt, used as the row title when there is no saved title. */
  firstPrompt: Schema.NullOr(Schema.String),
  folder: TrimmedNonEmptyString,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  lastActiveAt: IsoDateTime,
  /** The Houston thread that already owns this session. */
  threadId: Schema.NullOr(ThreadId),
  /** That thread is running now. */
  live: Schema.Boolean,
  /** A provider process outside Houston may be writing this session. */
  mayBeRunningElsewhere: Schema.Boolean,
});
export type HoustonResumeSession = typeof HoustonResumeSession.Type;

export const HoustonResumeSessionsInput = Schema.Struct({ projectId: ProjectId });
export type HoustonResumeSessionsInput = typeof HoustonResumeSessionsInput.Type;

export const HoustonResumeSessionsResult = Schema.Struct({
  sessions: Schema.Array(HoustonResumeSession),
  scannedAt: IsoDateTime,
  truncated: Schema.optional(Schema.Boolean),
});
export type HoustonResumeSessionsResult = typeof HoustonResumeSessionsResult.Type;

export const HoustonOpenResumeSessionInput = Schema.Struct({
  projectId: ProjectId,
  session: AgentSessionImportSource,
});
export type HoustonOpenResumeSessionInput = typeof HoustonOpenResumeSessionInput.Type;

export const HoustonOpenResumeSessionResult = Schema.Struct({ threadId: ThreadId });
export type HoustonOpenResumeSessionResult = typeof HoustonOpenResumeSessionResult.Type;

export class HoustonResumeSessionError extends Schema.TaggedError<HoustonResumeSessionError>()(
  "HoustonResumeSessionError",
  {
    reason: Schema.Literals(["project-not-found", "session-not-found", "scan-failed"]),
    projectId: ProjectId,
    providerSessionId: Schema.NullOr(TrimmedNonEmptyString),
    /** How many folder roots the picker searched, including the project root. */
    searchedRoots: NonNegativeInt,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const session =
      this.providerSessionId === null ? "" : ` for session '${this.providerSessionId}'`;
    switch (this.reason) {
      case "project-not-found":
        return `Project '${this.projectId}' does not exist; expected an existing project id before opening a session.`;
      case "session-not-found":
        return `Session${session} is missing, changed since the picker read it, or outside the ${this.searchedRoots} folder roots searched for project '${this.projectId}'; expected a recent Claude Code or Codex session for the project or one of its worktrees. Scan for sessions again.`;
      case "scan-failed":
        return `Could not scan provider sessions for project '${this.projectId}' across ${this.searchedRoots} folder roots; expected the provider session folders to be readable.`;
    }
  }
}
