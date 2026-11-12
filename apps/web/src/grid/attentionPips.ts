import { scopedThreadKey, scopeThreadRef } from "@houston-app/client-runtime/environment";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";

import { resolveThreadRowState } from "../threads/sidebarModel";
import { threadStatusKind } from "../threads/statusWord";

/** The attention families a heading counts: warning, failed, then back. */
export type AttentionGroup = "needs" | "failed" | "back";

export interface AttentionPip {
  readonly group: AttentionGroup;
  readonly count: number;
  /** The rail row of the first thread in the family, for a pip's jump. */
  readonly firstThreadKey: string;
}

/**
 * What a project or grid heading says about the rows inside it: how many wait for
 * the user, how many failed and how many came back unseen. A thread counted twice
 * (listed in two grids) counts once.
 */
export function attentionPips(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  nowIso: string,
): ReadonlyArray<AttentionPip> {
  const counts: Record<AttentionGroup, number> = { needs: 0, failed: 0, back: 0 };
  const first: Record<AttentionGroup, string | null> = { needs: null, failed: null, back: null };
  const seen = new Set<string>();
  for (const thread of threads) {
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = threadStatusKind(thread, resolveThreadRowState(thread, nowIso));
    const group: AttentionGroup | null =
      kind === "failed"
        ? "failed"
        : kind === "back"
          ? "back"
          : kind === "approval" ||
              kind === "input" ||
              kind === "request" ||
              kind === "needs" ||
              kind === "limited"
            ? "needs"
            : null;
    if (group === null) continue;
    counts[group] += 1;
    first[group] ??= key;
  }
  const pips: AttentionPip[] = [];
  if (counts.failed > 0 && first.failed !== null) {
    pips.push({ group: "failed", count: counts.failed, firstThreadKey: first.failed });
  }
  if (counts.needs > 0 && first.needs !== null) {
    pips.push({ group: "needs", count: counts.needs, firstThreadKey: first.needs });
  }
  if (counts.back > 0 && first.back !== null) {
    pips.push({ group: "back", count: counts.back, firstThreadKey: first.back });
  }
  return pips;
}
