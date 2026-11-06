import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";

import { resolveGridThreadState } from "./sidebar";
import { gridThreadStatusKind } from "./statusWord";

export interface AttentionPips {
  /** Threads whose run failed. */
  readonly failed: number;
  /** Threads waiting for the user: an approval, an input, a request or a usage limit. */
  readonly needsYou: number;
}

/**
 * What a project or grid heading says about the rows inside it: how many failed and how many wait
 * for the user. A thread counted twice (listed in two grids) counts once.
 */
export function attentionPips(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  nowIso: string,
): AttentionPips {
  let failed = 0;
  let needsYou = 0;
  const seen = new Set<string>();
  for (const thread of threads) {
    const key = `${thread.environmentId}:${thread.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = gridThreadStatusKind(thread, resolveGridThreadState(thread, nowIso));
    if (kind === "failed") failed += 1;
    else if (
      kind === "approval" ||
      kind === "input" ||
      kind === "request" ||
      kind === "needs" ||
      kind === "limited"
    ) {
      needsYou += 1;
    }
  }
  return { failed, needsYou };
}
