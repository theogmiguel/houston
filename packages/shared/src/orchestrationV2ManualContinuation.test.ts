import { RunAttemptId, RunId } from "@houston-app/contracts";
import { describe, expect, it } from "vite-plus/test";

import { providerAcceptedRun } from "./orchestrationV2ManualContinuation.ts";

const run = { id: RunId.make("run:stopped") };
const otherRun = RunId.make("run:other");
const attempt = (id: string, runId = run.id) => ({ id: RunAttemptId.make(id), runId });
const turn = (attemptId: string | null) => ({
  runAttemptId: attemptId === null ? null : RunAttemptId.make(attemptId),
});

describe("providerAcceptedRun", () => {
  it("is false for a run with no attempt", () => {
    expect(
      providerAcceptedRun(run, {
        attempts: [attempt("attempt:other", otherRun)],
        providerTurns: [],
      }),
    ).toBe(false);
  });

  it("follows the provider turn of a single attempt", () => {
    const attempts = [attempt("attempt:1")];
    expect(providerAcceptedRun(run, { attempts, providerTurns: [] })).toBe(false);
    expect(providerAcceptedRun(run, { attempts, providerTurns: [turn(null)] })).toBe(false);
    expect(providerAcceptedRun(run, { attempts, providerTurns: [turn("attempt:1")] })).toBe(true);
  });

  it("is true when any of several attempts has a provider turn", () => {
    const attempts = [attempt("attempt:1"), attempt("attempt:2"), attempt("attempt:3", otherRun)];
    expect(providerAcceptedRun(run, { attempts, providerTurns: [turn("attempt:1")] })).toBe(true);
    expect(providerAcceptedRun(run, { attempts, providerTurns: [turn("attempt:2")] })).toBe(true);
    expect(providerAcceptedRun(run, { attempts, providerTurns: [turn("attempt:3")] })).toBe(false);
  });
});
