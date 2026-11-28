import type { EnvironmentId, ScopedThreadRef } from "@houston-app/contracts";
import { type ThreadLink, unknownThreadLinkLabel } from "@houston-app/shared/threadLinks";

/** Shown while the environment is still being asked, so a link never claims a thread is gone. */
const pendingThreadLinkLabel = "Loading thread…";

/** The environment's answer for the link's candidate thread ids. */
export interface ThreadLinkTitlesLookup {
  readonly data: Readonly<Record<string, string>> | null;
  readonly isSuccess: boolean;
  readonly isPending: boolean;
}

export type ThreadLinkLookupResult =
  | { readonly kind: "found"; readonly ref: ScopedThreadRef; readonly title: string }
  | { readonly kind: "unavailable"; readonly label: string; readonly tooltip: string }
  | { readonly kind: "pending"; readonly label: string; readonly tooltip: string };

/** Resolves a link the shells leave out before deciding its thread is gone. */
export function resolveThreadLinkLookup(input: {
  readonly link: ThreadLink;
  readonly messageEnvironmentId: EnvironmentId;
  readonly candidates: ReadonlyArray<ScopedThreadRef>;
  readonly lookup: ThreadLinkTitlesLookup;
  readonly label: string | null;
}): ThreadLinkLookupResult {
  const titles = input.lookup.data;
  const found =
    titles === null
      ? null
      : (input.candidates.find((candidate) => Object.hasOwn(titles, candidate.threadId)) ?? null);
  if (found !== null) {
    const title = (titles?.[found.threadId] ?? "").trim() || input.label || "Untitled thread";
    return { kind: "found", ref: found, title };
  }
  const unknown = unknownThreadLinkLabel(input.link, input.messageEnvironmentId);
  if (input.lookup.isSuccess && !input.lookup.isPending) {
    return { kind: "unavailable", label: input.label ?? unknown, tooltip: unknown };
  }
  return {
    kind: "pending",
    label: input.label ?? pendingThreadLinkLabel,
    tooltip: pendingThreadLinkLabel,
  };
}
