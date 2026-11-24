import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
} from "@houston-app/contracts";

/** The provider accepted a run's request when any attempt of the run has a provider turn. */
export function providerAcceptedRun(
  run: Pick<OrchestrationV2Run, "id">,
  records: {
    readonly attempts: ReadonlyArray<Pick<OrchestrationV2RunAttempt, "id" | "runId">>;
    readonly providerTurns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "runAttemptId">>;
  },
): boolean {
  const attemptIds = new Set(
    records.attempts.filter((attempt) => attempt.runId === run.id).map((attempt) => attempt.id),
  );
  return records.providerTurns.some(
    (turn) => turn.runAttemptId !== null && attemptIds.has(turn.runAttemptId),
  );
}
