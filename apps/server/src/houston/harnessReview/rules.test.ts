import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  DAY_MS,
  findingPhase,
  parseFindings,
  readAnswer,
  reviewPrompt,
  reviewSummary,
  reviewWindow,
  type LinkedTask,
  type PhaseInput,
} from "./rules.ts";

const NOW = Date.parse("2026-10-30T09:00:00.000Z");
const daysAgo = (days: number) => DateTime.formatIso(DateTime.makeUnsafe(NOW - days * DAY_MS));

describe("the review window", () => {
  it("the window is a fortnight first then seven to thirty days", () => {
    const rows: ReadonlyArray<
      readonly [string, Parameters<typeof reviewWindow>[1], number, string | null]
    > = [
      ["first review", [], 14, null],
      [
        "previous end 2 days ago",
        [{ status: "published", windowUntil: daysAgo(2) }],
        7,
        daysAgo(2),
      ],
      [
        "previous end 10 days ago",
        [{ status: "published", windowUntil: daysAgo(10) }],
        10,
        daysAgo(10),
      ],
      [
        "previous end 45 days ago",
        [{ status: "published", windowUntil: daysAgo(45) }],
        30,
        daysAgo(45),
      ],
      [
        "only failed reviews before",
        [
          { status: "failed", windowUntil: daysAgo(3) },
          { status: "failed", windowUntil: null },
        ],
        14,
        null,
      ],
      [
        "the newest published end counts, not a later failure",
        [
          { status: "published", windowUntil: daysAgo(20) },
          { status: "failed", windowUntil: daysAgo(1) },
          { status: "published", windowUntil: daysAgo(12) },
        ],
        12,
        daysAgo(12),
      ],
    ];
    for (const [name, earlier, days, previousEnd] of rows) {
      const window = reviewWindow(NOW, earlier);
      expect(window.untilMs, name).toBe(NOW);
      expect((window.untilMs - window.sinceMs) / DAY_MS, name).toBe(days);
      expect(window.previousEnd, name).toBe(previousEnd);
    }
  });
});

describe("the review prompt", () => {
  it("the review prompt states what is sent and the answer shape", () => {
    const prompt = reviewPrompt({ reviewId: 12, runDir: ".houston/harness/review-12" });
    expect(prompt.startsWith("What this run sends")).toBe(true);
    for (const file of ["inventory.json", "digest.jsonl", "digest-meta.json", "decisions.json"]) {
      expect(prompt).toContain(`.houston/harness/review-12/${file}`);
    }
    expect(prompt).toMatch(/cannot edit files/);
    expect(prompt).toContain("~/.claude");
    expect(prompt).toContain("~/.codex");
    expect(prompt).toMatch(/must not read/);
    expect(prompt).toContain("```json");
    expect(prompt).toContain('"schema": 1');
    expect(prompt).toMatch(/report[\s\S]*then[\s\S]*one fenced `json` block/i);
    expect(prompt).not.toContain("hs-harness");
    expect(prompt).not.toContain("harness_publish");
  });
});

const finding = (key: string, overrides: Record<string, unknown> = {}) => ({
  id: "F1",
  key,
  category: "permissions",
  title: "Denied git push",
  evidence: { sessions: ["abc", "def"], count: 2, quotes: ["why denied"] },
  recommendation: {
    kind: "settings-allow",
    target: ".claude/settings.json",
    summary: "Allow git push to the fork",
    apply_prompt: "Add the rule",
  },
  confidence: "high",
  ...overrides,
});

const file = (findings: ReadonlyArray<unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    schema: 1,
    summary: "One finding",
    run: { window: ["2026-10-16", "2026-10-30"], threads: 12, prompts: 80, cost_usd: 4.5 },
    findings,
    verifications: [],
    ...extra,
  });

const NO_LINKS: ReadonlyMap<string, ReadonlyArray<LinkedTask>> = new Map();

const refusal = (body: string, links = NO_LINKS) => {
  const parsed = parseFindings(body, links);
  if (parsed.ok) throw new Error(`accepted: ${body.slice(0, 80)}`);
  return parsed.error;
};

describe("the findings parser", () => {
  it("a refusal quotes at most 2 KB of the offending value", () => {
    for (const body of [
      JSON.stringify({ schema: "x".repeat(100_000), findings: [] }),
      file([finding("k".repeat(1_000_000))]),
    ]) {
      expect(refusal(body).length).toBeLessThan(2_048 + 300);
    }
    expect(refusal(JSON.stringify({ schema: "x".repeat(100_000), findings: [] }))).toContain(
      "… (100002 characters)",
    );
    expect(refusal('{"schema":2,"findings":[]}')).toContain("schema must be 1; got 2");
  });

  it("the findings parser refuses a wrong shape by path and caps every field", () => {
    expect(refusal("{not json")).toMatch(/not valid JSON/);
    expect(refusal('{"schema":2,"findings":[]}')).toContain("schema must be 1; got 2");
    expect(refusal('{"schema":1,"findings":{}}')).toContain("findings must be an array");
    const many = Array.from({ length: 101 }, (_, index) => finding(`k${index}`));
    expect(refusal(file(many))).toContain("101 findings, over the 100 cap");
    expect(refusal(file([finding("Bad Key")]))).toContain('findings[0].key is "Bad Key"');
    expect(refusal(file([finding("x".repeat(81))]))).toContain("findings[0].key");
    expect(refusal(file([finding("a"), finding("a")]))).toContain(
      'findings[1].key repeats the key "a"',
    );
    expect(refusal(file([finding("a", { title: "" })]))).toContain("findings[0].title is required");

    const long = parseFindings(
      file([
        finding("a", {
          title: "t".repeat(500),
          evidence: {
            sessions: Array.from({ length: 70 }, () => "s".repeat(200)),
            quotes: Array.from({ length: 20 }, () => "q".repeat(1_000)),
          },
          recommendation: {
            kind: "claude-md",
            target: "CLAUDE.md",
            summary: "r".repeat(5_000),
            apply_prompt: "p".repeat(20_000),
          },
        }),
      ]),
      NO_LINKS,
    );
    if (!long.ok) throw new Error(long.error);
    const [capped] = long.value.findings;
    expect(capped!.title).toBe(`${"t".repeat(200)}…`);
    expect(capped!.recommendation).toBe(`${"r".repeat(2_000)}…`);
    expect(capped!.applyPrompt).toBe(`${"p".repeat(8_000)}…`);
    expect(capped!.quotes).toHaveLength(5);
    expect(capped!.quotes[0]).toBe(`${"q".repeat(300)}…`);
    expect(capped!.sessions).toHaveLength(50);
    expect(capped!.sessions[0]).toBe(`${"s".repeat(80)}…`);
    expect(capped!.count).toBe(50);

    const plain = parseFindings(file([finding("denied-push")]), NO_LINKS);
    if (!plain.ok) throw new Error(plain.error);
    expect(plain.value.findings[0]).toMatchObject({
      key: "denied-push",
      title: "Denied git push",
      sessions: ["abc", "def"],
      count: 2,
      quotes: ["why denied"],
      recommendationKind: "settings-allow",
      target: ".claude/settings.json",
      recommendation: "Allow git push to the fork",
      applyPrompt: "Add the rule",
    });
    expect(plain.value).toMatchObject({ threads: 12, prompts: 80, costUsd: 4.5 });
    expect(plain.value.summary).toBe("One finding");
  });

  it("verifications must name a linked task and enough sessions", () => {
    const verification = (overrides: Record<string, unknown> = {}) => ({
      key: "fix-key",
      task: "HOU-12",
      verdict: "gone",
      sessions_after: 3,
      quotes: ["new evidence"],
      ...overrides,
    });
    const links = (sessionsAfter: number): ReadonlyMap<string, ReadonlyArray<LinkedTask>> =>
      new Map([["fix-key", [{ task: "HOU-12", taskId: 12, sessionsAfter }]]]);
    const withVerifications = (
      items: ReadonlyArray<unknown>,
      findings: ReadonlyArray<unknown> = [],
    ) => file(findings, { verifications: items });

    expect(refusal(withVerifications([verification({ task: "HOU-99" })]), links(3))).toContain(
      "verifications[0].task",
    );
    expect(refusal(withVerifications([verification({ verdict: "unknown" })]), links(3))).toContain(
      "expected gone, still_present or inconclusive",
    );
    expect(refusal(withVerifications([verification({ sessions_after: 2 })]), links(3))).toContain(
      "expected 3 sessions started after the task landed",
    );
    expect(
      refusal(
        withVerifications([verification({ quotes: ["a", "b", "c", "d", "e", "f"] })]),
        links(3),
      ),
    ).toContain("expected at most 5");
    expect(
      refusal(withVerifications(Array.from({ length: 101 }, () => verification())), links(3)),
    ).toContain("over the 100 cap");
    expect(refusal(withVerifications([verification()], [finding("fix-key")]), links(3))).toContain(
      "both a finding and a gone verification",
    );

    const small = parseFindings(withVerifications([verification({ sessions_after: 2 })]), links(2));
    if (!small.ok) throw new Error(small.error);
    expect(small.value.verifications[0]).toMatchObject({
      key: "fix-key",
      taskId: 12,
      verdict: "inconclusive",
      sessionsAfter: 2,
    });
    const enough = parseFindings(withVerifications([verification()]), links(3));
    if (!enough.ok) throw new Error(enough.error);
    expect(enough.value.verifications[0]).toMatchObject({
      taskId: 12,
      verdict: "gone",
      sessionsAfter: 3,
      evidence: ["new evidence"],
    });
  });
});

describe("the final answer", () => {
  it("the last fenced json block is the findings and the rest is the report", () => {
    const answer = [
      "# Review",
      "",
      "```json",
      '{"example": true}',
      "```",
      "",
      "Findings follow.",
      "",
      "```json",
      file([finding("a")]),
      "```",
    ].join("\n");
    const read = readAnswer(answer);
    if (!read.ok) throw new Error(read.error);
    expect(JSON.parse(read.findingsJson)).toMatchObject({ schema: 1 });
    expect(read.report).toContain("# Review");
    expect(read.report).toContain('{"example": true}');
    expect(read.report).toContain("Findings follow.");
    expect(read.report).not.toContain('"schema":1');
    const missing = readAnswer("# Review\n\nNo block here.");
    expect(missing.ok).toBe(false);
  });

  it("the summary is the block's, at most 200 characters, else the finding count", () => {
    expect(reviewSummary("Two findings on pushes", 2)).toBe("Two findings on pushes");
    expect(reviewSummary(undefined, 2)).toBe("2 findings");
    expect(reviewSummary("", 1)).toBe("1 finding");
    expect(reviewSummary("s".repeat(300), 2)).toHaveLength(200);
  });
});

describe("finding phases", () => {
  it("a finding's phase follows decision, task, review and verdict in order", () => {
    const base: PhaseInput = {
      state: "open",
      reviewId: 4,
      latestPublishedReviewId: 4,
      quotes: ["original quote"],
      verification: null,
      task: null,
    };
    const verification = (
      verdict: "gone" | "still_present" | "inconclusive",
      reviewId = 4,
      reviewEndedAt = "2026-10-20T00:00:00.000Z",
    ) => ({ reviewId, verdict, reviewEndedAt, evidence: ["verification quote"] });
    const task = (status: string, createdAt = "2026-10-10T00:00:00.000Z") => ({
      status,
      createdAt,
    });
    const rows: ReadonlyArray<readonly [string, PhaseInput, string, ReadonlyArray<string>?]> = [
      ["dismissed", { ...base, state: "dismissed", task: task("todo") }, "dismissed"],
      ["resolved", { ...base, state: "resolved", task: task("todo") }, "resolved"],
      ["open linked task", { ...base, task: task("in_progress") }, "fixing"],
      [
        "open task older than the latest verification",
        {
          ...base,
          task: task("todo", "2026-10-10T00:00:00.000Z"),
          verification: verification("inconclusive"),
        },
        "awaitingVerification",
      ],
      ["later review without the key", { ...base, latestPublishedReviewId: 6 }, "notSeen"],
      ["gone", { ...base, task: task("done"), verification: verification("gone") }, "resolved"],
      [
        "still present",
        { ...base, task: task("done"), verification: verification("still_present") },
        "open",
        ["verification quote"],
      ],
      [
        "inconclusive",
        { ...base, task: task("done"), verification: verification("inconclusive") },
        "awaitingVerification",
      ],
      ["task done", { ...base, task: task("done") }, "awaitingVerification"],
      [
        "task canceled with a later review",
        { ...base, latestPublishedReviewId: 5, reviewId: 4, task: task("canceled") },
        "notSeen",
      ],
      ["task canceled without", { ...base, task: task("canceled") }, "open"],
      ["no task, no later review", base, "open"],
    ];
    expect(rows).toHaveLength(12);
    for (const [name, input, phase, quotes] of rows) {
      const result = findingPhase(input);
      expect(result.phase, name).toBe(phase);
      expect(result.quotes, name).toEqual(quotes ?? input.quotes);
    }
  });
});
