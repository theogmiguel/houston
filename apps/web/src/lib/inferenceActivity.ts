import type { ThreadId } from "@houston-app/contracts";
import type {
  InferenceServerId,
  InferenceServerSnapshot,
} from "@houston-app/contracts/houston/inference";

/** A thread's request held in Houston's gateway queue for a busy inference server. */
export interface ThreadInferenceWait {
  readonly serverId: InferenceServerId;
  readonly serverName: string;
  /** Requests the gateway will start before this one. */
  readonly ahead: number;
}

/** The thread's queued request closest to running, or null when none is waiting. */
export function threadInferenceWait(
  servers: ReadonlyArray<InferenceServerSnapshot> | null | undefined,
  threadId: ThreadId,
): ThreadInferenceWait | null {
  let best: ThreadInferenceWait | null = null;
  for (const server of servers ?? []) {
    for (const entry of server.gatewayQueue?.waiting ?? []) {
      if (entry.threadId !== threadId) continue;
      if (best === null || entry.position < best.ahead) {
        best = { serverId: server.id, serverName: server.displayName, ahead: entry.position };
      }
    }
  }
  return best;
}

export function sameThreadInferenceWait(
  a: ThreadInferenceWait | null,
  b: ThreadInferenceWait | null,
): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.serverId === b.serverId &&
      a.serverName === b.serverName &&
      a.ahead === b.ahead)
  );
}

/** "Waiting for rtx · 2 ahead"; "next" once nothing is ahead. */
export function formatThreadInferenceWait(wait: ThreadInferenceWait): string {
  return `Waiting for ${wait.serverName} · ${wait.ahead === 0 ? "next" : `${wait.ahead} ahead`}`;
}
