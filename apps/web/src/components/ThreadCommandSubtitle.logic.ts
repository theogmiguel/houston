export type ThreadSubtitleSegment = "project" | "branch" | "pullRequest" | "harness" | "current";

export interface ThreadSubtitleInput {
  readonly projectTitle?: string | null | undefined;
  readonly branch?: string | null | undefined;
  readonly hasPullRequest: boolean;
  readonly showHarness: boolean;
  readonly isCurrent: boolean;
}

/**
 * The segments a thread subtitle shows, in order. A segment with no content is
 * absent, so a renderer that puts one separator between neighbours can never
 * show an empty slot or two separators in a row.
 */
export function resolveThreadSubtitleSegments(
  input: ThreadSubtitleInput,
): ReadonlyArray<ThreadSubtitleSegment> {
  const segments: ThreadSubtitleSegment[] = [];
  if (input.projectTitle?.trim()) segments.push("project");
  if (input.branch?.trim()) segments.push("branch");
  if (input.hasPullRequest) segments.push("pullRequest");
  if (input.showHarness) segments.push("harness");
  if (input.isCurrent) segments.push("current");
  return segments;
}
