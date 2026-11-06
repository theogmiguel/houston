/** "Claude Code ready", "Claude Code and Codex ready", "A, B and C ready"; null when none are. */
export function formatReadyProviders(labels: ReadonlyArray<string>): string | null {
  if (labels.length === 0) return null;
  if (labels.length === 1) return `${labels[0]} ready`;
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]} ready`;
}

/** The disclosure's label for providers that are not ready; "more" only when some are ready. */
export function formatProvidersToSet(input: { pending: number; ready: number }): string {
  const noun = input.pending === 1 ? "provider" : "providers";
  return input.ready > 0
    ? `${input.pending} more ${noun} to set up`
    : `${input.pending} ${noun} to set up`;
}
