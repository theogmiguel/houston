import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";

import { getDisplayModelName } from "../components/chat/providerIconUtils";
import type { ProviderInstanceEntry } from "../providerInstances";

/**
 * Longest error text the hover card quotes. The card is a narrow tooltip; the thread's own view
 * holds the full text, so the card keeps the cause legible without growing past the screen.
 */
export const HOVER_ERROR_MAX_CHARS = 160;
/** Pull requests listed on the card; the rest are counted. */
export const HOVER_PULL_REQUEST_LIMIT = 3;

type ThreadFields = Pick<
  EnvironmentThreadShell,
  | "branch"
  | "worktreePath"
  | "pullRequests"
  | "providerInstanceId"
  | "providerInstanceHistory"
  | "modelSelection"
  | "runtime"
>;

export interface ThreadHoverDetails {
  /** The environment's name, only when threads run on more than one. */
  readonly environment: string | null;
  readonly checkout: "worktree" | "local";
  readonly branch: string | null;
  /** Set when the project's checkout is on a different branch than the thread's own. */
  readonly branchWarning: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  /** Providers the thread has run on, oldest first, when it has moved between them. */
  readonly handoffs: ReadonlyArray<string>;
  readonly terminalCount: number;
  readonly problem:
    | { readonly kind: "limit"; readonly resetAt: string }
    | { readonly kind: "error"; readonly text: string }
    | null;
  readonly pullRequests: ReadonlyArray<{
    readonly number: number;
    readonly title: string | null;
    readonly state: string | null;
  }>;
  readonly morePullRequests: number;
}

export function threadHoverDetails(input: {
  readonly thread: ThreadFields;
  readonly providerEntries: ReadonlyMap<
    string,
    Pick<ProviderInstanceEntry, "displayName" | "models">
  >;
  /** The branch the project's checkout is on, when the thread uses it rather than a worktree. */
  readonly checkoutBranch: string | null;
  readonly environmentLabel: string | null;
  readonly terminalCount: number;
  readonly nowMs: number;
}): ThreadHoverDetails {
  const { thread, providerEntries } = input;
  const entry = providerEntries.get(thread.providerInstanceId);
  const slug = thread.modelSelection?.model ?? null;
  const model =
    slug === null ? null : (entry?.models.find((candidate) => candidate.slug === slug) ?? null);
  const nameOf = (instanceId: string) => providerEntries.get(instanceId)?.displayName ?? instanceId;
  const history = thread.providerInstanceHistory ?? [];
  const runtime = thread.runtime;

  const usesCheckout = thread.worktreePath === null;
  const branchWarning =
    usesCheckout &&
    thread.branch !== null &&
    input.checkoutBranch !== null &&
    input.checkoutBranch !== thread.branch
      ? `Checkout is on ${input.checkoutBranch}, not ${thread.branch}`
      : null;

  const resetAt = runtime?.usageLimitResetAt ?? null;
  const problem: ThreadHoverDetails["problem"] =
    resetAt !== null && Date.parse(resetAt) > input.nowMs
      ? { kind: "limit", resetAt }
      : runtime?.lastError
        ? { kind: "error", text: truncate(runtime.lastError, HOVER_ERROR_MAX_CHARS) }
        : null;

  return {
    environment: input.environmentLabel,
    checkout: usesCheckout ? "local" : "worktree",
    branch: thread.branch,
    branchWarning,
    provider: entry?.displayName ?? null,
    model: slug === null ? null : model === null ? slug : getDisplayModelName(model),
    handoffs: history.length > 1 ? history.map(nameOf) : [],
    terminalCount: input.terminalCount,
    problem,
    pullRequests: thread.pullRequests.slice(0, HOVER_PULL_REQUEST_LIMIT).map((link) => ({
      number: link.number,
      title: link.snapshot?.title ?? null,
      state: link.snapshot?.state ?? null,
    })),
    morePullRequests: Math.max(0, thread.pullRequests.length - HOVER_PULL_REQUEST_LIMIT),
  };
}

const WHITESPACE_RUN = /\s+/g;

function truncate(text: string, max: number): string {
  const single = text.replace(WHITESPACE_RUN, " ").trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}
