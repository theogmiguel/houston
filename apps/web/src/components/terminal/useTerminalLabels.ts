import type { ScopedThreadRef } from "@houston-app/contracts";
import { resolveTerminalSessionLabel } from "@houston-app/shared/terminalLabels";

import { useKnownTerminalSessions } from "../../state/terminalSessions";

/** The display label of each terminal session the thread owns, by terminal id. */
export function useTerminalLabels(threadRef: ScopedThreadRef | null): ReadonlyMap<string, string> {
  const sessions = useKnownTerminalSessions({
    environmentId: threadRef?.environmentId ?? null,
    threadId: threadRef?.threadId ?? null,
  });
  const labels = new Map<string, string>();
  for (const session of sessions ?? []) {
    if (session.target.threadId !== threadRef?.threadId) continue;
    labels.set(
      session.target.terminalId,
      resolveTerminalSessionLabel(session.target.terminalId, session.state.summary),
    );
  }
  return labels;
}
