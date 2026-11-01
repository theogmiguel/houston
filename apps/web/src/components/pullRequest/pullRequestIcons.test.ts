import type {
  PullRequestCheckStatus,
  PullRequestChecksState,
  PullRequestReviewDecision,
  PullRequestState,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { PullRequestReviewOutcome } from "./pullRequestDetail.logic";
import {
  PULL_REQUEST_PRESENTATION,
  pullRequestCheckStatusPresentation,
  pullRequestChecksStatePresentation,
  pullRequestReviewDecisionPresentation,
  pullRequestReviewOutcomePresentation,
} from "./pullRequestIcons";

const PALETTE_CLASS =
  /(?:^|\s)(?:text|bg|border|ring|fill|stroke)-(?:red|green|emerald|amber|yellow|orange|sky|blue|indigo|violet|purple|pink|rose|teal|cyan|lime|zinc|slate|gray|neutral|stone)-/u;

const PR_STATE_TONES = [
  ["open", "text-success-foreground"],
  ["draft", "text-muted-foreground"],
  ["merged", "text-merged-foreground"],
  ["closed", "text-error-foreground"],
] as const satisfies ReadonlyArray<readonly [PullRequestState | "draft", string]>;

const CHECK_STATUS_TONES = [
  ["pending", "text-warning-foreground"],
  ["action-required", "text-warning-foreground"],
  ["success", "text-success-foreground"],
  ["failure", "text-error-foreground"],
  ["cancelled", "text-error-foreground"],
  ["skipped", "text-muted-foreground"],
  ["neutral", "text-muted-foreground"],
] as const satisfies ReadonlyArray<readonly [PullRequestCheckStatus, string]>;

const CHECKS_STATE_TONES = [
  ["passing", "text-success-foreground"],
  ["failing", "text-error-foreground"],
  ["pending", "text-warning-foreground"],
] as const satisfies ReadonlyArray<readonly [PullRequestChecksState, string]>;

const REVIEW_DECISION_TONES = [
  ["approved", "text-success-foreground"],
  ["changes-requested", "text-warning-foreground"],
  ["review-required", "text-muted-foreground"],
] as const satisfies ReadonlyArray<readonly [PullRequestReviewDecision, string]>;

const REVIEW_OUTCOME_TONES = [
  ["approved", "text-success-foreground"],
  ["changes-requested", "text-error-foreground"],
  ["dismissed", "text-muted-foreground"],
] as const satisfies ReadonlyArray<readonly [PullRequestReviewOutcome, string]>;

describe("pull request presentation", () => {
  it.each(PR_STATE_TONES)("maps %s to %s", (state, tone) => {
    expect(PULL_REQUEST_PRESENTATION[state].toneClassName).toBe(tone);
  });

  it.each(CHECK_STATUS_TONES)("maps check status %s to %s", (status, tone) => {
    expect(pullRequestCheckStatusPresentation(status).toneClassName).toBe(tone);
  });

  it.each(CHECKS_STATE_TONES)("maps checks state %s to %s", (state, tone) => {
    expect(pullRequestChecksStatePresentation(state).toneClassName).toBe(tone);
  });

  it.each(REVIEW_DECISION_TONES)("maps review decision %s to %s", (decision, tone) => {
    expect(pullRequestReviewDecisionPresentation(decision).toneClassName).toBe(tone);
  });

  it.each(REVIEW_OUTCOME_TONES)("maps review outcome %s to %s", (outcome, tone) => {
    expect(pullRequestReviewOutcomePresentation(outcome).toneClassName).toBe(tone);
  });

  it("uses design tokens, never the Tailwind palette", () => {
    for (const [key, entry] of Object.entries(PULL_REQUEST_PRESENTATION)) {
      for (const [field, value] of Object.entries(entry)) {
        if (typeof value === "string") {
          expect(value, `${key}.${field}`).not.toMatch(PALETTE_CLASS);
        }
      }
    }
  });
});
