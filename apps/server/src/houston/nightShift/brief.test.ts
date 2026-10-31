import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { HOUSTON_NIGHT_SHIFT_LIMITS } from "@t3tools/contracts/houston/nightShift";
import { describe, expect, it } from "vite-plus/test";

import { composeBrief, type BriefInput } from "./brief.ts";
import { defaultSettings } from "./rules.ts";

const model = (instance: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instance),
  model: "m",
});

const settings = {
  ...defaultSettings({
    orchestrator: model("claudeAgent"),
    checks: [
      { command: "pnpm lint", source: "ci.yml · checks" },
      { command: "pnpm run typecheck", source: "package.json" },
    ],
    startCommand: { command: "pnpm run dev", source: "package.json" },
  }),
  direction: "Make the sync engine survive a dropped connection.",
  competitors: [{ repo: "acme/rival" }],
  workers: [model("codex"), model("claudeAgent")],
  focus: {
    reliability: "high" as const,
    performance: "off" as const,
    uiPolish: "off" as const,
    competitorGaps: "low" as const,
    docsAccuracy: "off" as const,
    testGaps: "off" as const,
  },
};

const input: BriefInput = {
  runId: 7,
  settings,
  startAt: "2026-10-30T23:30:00.000Z",
  wrapUpAt: "2026-10-31T06:45:00.000Z",
  hardStopAt: "2026-10-31T07:30:00.000Z",
  branch: "houston/night/7",
  picks: [{ number: 12, title: "Retry the upload", text: "Uploads fail on flaky Wi-Fi." }],
  digest: [],
};

describe("night shift brief", () => {
  it("the brief carries the settings the crew rules and no goal", () => {
    for (const orchestrator of ["claudeAgent", "codex", "opencode"]) {
      const { text, dropped } = composeBrief({
        ...input,
        settings: { ...settings, orchestrator: model(orchestrator) },
      });
      expect(dropped).toBe(0);
      expect(text).toContain("Houston Night shift");
      expect(text).toContain("2026-10-31T06:45:00.000Z");
      expect(text).toContain("2026-10-31T07:30:00.000Z");
      expect(text).toContain("Make the sync engine survive a dropped connection.");
      expect(text).toMatch(/priority/i);
      expect(text).toMatch(/Reliability \(high\)/);
      expect(text).toMatch(/Competitor gaps \(low\)/);
      expect(text).not.toMatch(/Performance/);
      expect(text).not.toMatch(/UI and UX polish/);
      expect(text).not.toMatch(/Documentation accuracy/);
      expect(text).not.toMatch(/Test gaps/);
      expect(text).toContain("acme/rival");
      expect(text).toContain(
        "do not push, open, merge or enqueue pull requests: record them with `houston_night_pr`",
      );
      expect(text).toContain("worktree");
      expect(text).toContain("4 live workers");
      expect(text).toContain("codex, then claudeAgent");
      expect(text).toContain("pnpm lint");
      expect(text).toContain("pnpm run typecheck");
      expect(text).toMatch(/draft pull requests/);
      expect(text).toMatch(/up to 5 related changes/);
      expect(text).toMatch(/App QA is off/);
      expect(text).toContain("HOU-12");
      expect(text).toContain("houston_task_claim");
      expect(text).toContain("houston_task_handback");
      expect(text).not.toMatch(/^\/goal/m);
      expect(text).not.toContain("/goal");
    }

    const merge = composeBrief({
      ...input,
      picks: [],
      settings: {
        ...settings,
        output: "mergeQueue",
        prSize: { kind: "one" },
        appQa: { ...settings.appQa, enabled: true },
      },
    }).text;
    expect(merge).toMatch(/merge queue/);
    expect(merge).toMatch(/one change per pull request/);
    expect(merge).toContain("pnpm run dev");
    expect(merge).not.toContain("houston_task_claim");
    expect(merge).toMatch(/No backlog tasks/);
  });

  it("the digest drops its oldest items to fit the budget", () => {
    // 300 KB of digest, newest first.
    const digest = Array.from({ length: 300 }, (_, index) => `item ${index}: ${"x".repeat(1_000)}`);
    const { text, dropped } = composeBrief({ ...input, digest });
    expect(text.length).toBeLessThanOrEqual(HOUSTON_NIGHT_SHIFT_LIMITS.briefChars);
    expect(dropped).toBeGreaterThan(0);
    expect(text).toContain("item 0:");
    expect(text).not.toContain("item 299:");
    expect(text).toContain(`${dropped} older ledger items were left out`);
    const kept = digest.filter((line) => text.includes(`${line.split(":")[0]}:`)).length;
    expect(kept + dropped).toBe(300);

    const small = composeBrief({ ...input, digest: ["item 0: a lesson", "item 1: a deferral"] });
    expect(small.dropped).toBe(0);
    expect(small.text).toContain("item 1: a deferral");
    expect(small.text).not.toMatch(/were left out/);
  });
});
