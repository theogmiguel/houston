// The rules that decide a harness review's outcome, as pure functions: the window, the prompt, the
// answer and its findings, a finding's decision and phase, and the seen cursor.
import {
  HOUSTON_HARNESS_LIMITS,
  type HoustonHarnessDecisionState,
  type HoustonHarnessFindingPhase,
  type HoustonHarnessReviewStatus,
} from "@t3tools/contracts/houston/harnessReview";

export const DAY_MS = 86_400_000;
/** A fortnight the first time, then from the previous review's end: never under a week (too few
 * sessions to see recurrence) nor over a month (a digest that no longer fits one reading). */
export const FIRST_REVIEW_DAYS = 14;
export const MIN_WINDOW_DAYS = 7;
export const MAX_WINDOW_DAYS = 30;

export const RUN_DIR_PARENT = ".houston/harness";
/** `review-<id>-<8 hex>`: the suffix keeps another database's review `<id>` out of this folder. */
export const runDirOf = (reviewId: number, suffix: string) =>
  `${RUN_DIR_PARENT}/review-${reviewId}-${suffix}`;
/** Run directories of a project's newest reviews kept: about 20 MiB at the 2 MiB digest cap. */
export const RUN_DIRS_KEPT = 10;
/** A run directory this server names; v1's imported `r<run>` directories are never removed. */
export const OWN_RUN_DIR = /^\.houston\/harness\/review-\d+-[0-9a-f]{8}$/;

export interface ReviewWindow {
  readonly sinceMs: number;
  readonly untilMs: number;
  /** The end of the newest published review's window, or null for a first review. */
  readonly previousEnd: string | null;
}

/** The window a review starting at `nowMs` reads, from the project's earlier reviews. */
export function reviewWindow(
  nowMs: number,
  earlier: ReadonlyArray<{
    readonly status: HoustonHarnessReviewStatus;
    readonly windowUntil: string | null;
  }>,
): ReviewWindow {
  const ends = earlier
    .filter((review) => review.status === "published" && review.windowUntil !== null)
    .map((review) => review.windowUntil!)
    .toSorted((left, right) => Date.parse(right) - Date.parse(left));
  const previousEnd = ends[0] ?? null;
  const sinceMs =
    previousEnd === null
      ? nowMs - FIRST_REVIEW_DAYS * DAY_MS
      : Math.min(
          Math.max(Date.parse(previousEnd), nowMs - MAX_WINDOW_DAYS * DAY_MS),
          nowMs - MIN_WINDOW_DAYS * DAY_MS,
        );
  return { sinceMs, untilMs: nowMs, previousEnd };
}

/** The first message of a review thread; the inputs stay in files the read-only agent reads. */
export function reviewPrompt(input: {
  readonly reviewId: number;
  readonly runDir: string;
}): string {
  const file = (name: string) => `\`${input.runDir}/${name}\``;
  return [
    `What this run sends: this is Houston harness review ${input.reviewId} of this project. You read the files Houston prepared in ${`\`${input.runDir}/\``} and the project's own files; the prompt, what you read and your answer go to this thread's provider only, as any turn of this agent does. Nothing else leaves the machine. The run started because its scheduled task fired or the user pressed Run review now; the user pauses or edits it in Scheduled tasks.`,
    "You are reviewing the agent harness of this project: its instruction files (CLAUDE.md, AGENTS.md), rules, skills, settings, hooks and MCP configuration. Find where the harness made recent threads slower, costlier or more frustrating than they needed to be, and recommend concrete changes. You recommend; you do not apply.",
    "## What you can do",
    "This run is read-only: you cannot edit files, run commands that change anything, or reach the network. You must not read `~/.claude` or `~/.codex` or any other agent's transcripts; the digest is your only view of the threads.",
    "## Steps",
    [
      `1. Read ${file("inventory.json")}: the instruction files with their headings, rules with their paths, skills (repository and user), settings with allow, deny and ask lists and hook counts, MCP servers and agents. An entry with \`error\` could not be parsed.`,
      `2. Read ${file("digest-meta.json")}: the window, the previous review's end, the threads written and those skipped or dropped, and why.`,
      `3. Read ${file("digest.jsonl")} in full. Each line is one Houston thread of this project: its prompts, the count of automatic messages (from scheduled tasks and other threads), failed commands with their input, refused or cancelled approval requests, interrupts, compactions, provider errors, subagent prompts, tool counts and the last assistant message. \`task: HOU-n\` marks a task run's thread; \`truncated\` counts entries the size cap dropped.`,
      `4. Read ${file("decisions.json")}: every finding earlier reviews raised, with the user's decision (\`open\`, \`dismissed\` or \`resolved\`) and when, and any linked fix tasks with their landing time and the threads started since. Do not raise a dismissed or resolved finding again unless this window has new evidence after that decision; when a finding recurs, keep its \`key\`. Earlier run directories under \`${RUN_DIR_PARENT}/\` hold their \`findings.json\`.`,
      "5. Cross-check the threads against the harness files themselves; open the files you cite. Is there a rule or skill for this? Does it load where the threads ran? Does it say the opposite? Is a skill never used?",
      `6. For each linked task, add one entry to \`verifications\` with its finding \`key\`, the task key exactly as listed, \`verdict\` (\`gone\`, \`still_present\` or \`inconclusive\`), \`sessions_after\` as listed and up to ${HOUSTON_HARNESS_LIMITS.quotes} short \`quotes\`. Never use the task's own thread as evidence. With fewer than \`minimum_sessions_after_landing\` threads, use \`inconclusive\`. A \`gone\` verdict and a finding with the same key cannot appear together.`,
    ].join("\n"),
    "## What counts as a finding",
    [
      "- A pain the user repeated: the same ask across threads, corrections, interrupts.",
      "- Recurring asks no skill or rule serves, or one that never loaded in those threads.",
      "- Harness friction: refused approvals, failed commands that recur (name them, so a settings rule can be proposed), MCP failures, compactions, automatic messages answered with prose.",
      "- Judgment errors the harness could have prevented, and dead or contradictory instructions.",
      "Count evidence in distinct threads; a pattern in one thread is a note, not a finding. Quote the user's words briefly; never paste secrets, credentials or personal data.",
    ].join("\n"),
    "## Your answer",
    `End your turn with the report, written in the language most prompts use, then one fenced \`json\` block holding findings.json. Houston reads the last fenced \`json\` block as the findings and everything before it as the report. The report opens with the window and the thread and prompt counts, then one section per finding by impact (the problem with its thread count; how to see it, with thread ids and short quotes; the exact target file and change, and whether it still holds against the file today), then "Already handled: re-count next run", then the findings you rejected, one line each. At most ${HOUSTON_HARNESS_LIMITS.findings} findings.`,
    [
      "```json",
      "{",
      '  "schema": 1,',
      '  "summary": "One line of at most 200 characters naming the number of findings",',
      '  "run": { "window": ["YYYY-MM-DD", "YYYY-MM-DD"], "threads": 0, "prompts": 0, "cost_usd": 0.0 },',
      '  "findings": [',
      "    {",
      '      "key": "short-stable-kebab-case-name",',
      '      "category": "communication | handoff | environment | permissions | tools | size-and-subagents | wrap-up | config",',
      '      "title": "One line",',
      '      "evidence": { "sessions": ["<thread id>"], "count": 0, "quotes": ["<short quote>"] },',
      '      "recommendation": {',
      '        "kind": "claude-md | add-rule | edit-skill | new-skill | hook | test-or-lint | settings-allow | settings-deny | mcp | docs | recount",',
      '        "target": "<path relative to the project>",',
      '        "summary": "What to change, in one or two sentences",',
      '        "apply_prompt": "A prompt another agent could follow to make exactly this change"',
      "      },",
      '      "confidence": "high | medium | low"',
      "    }",
      "  ],",
      '  "verifications": [',
      '    { "key": "short-stable-kebab-case-name", "task": "HOU-123", "verdict": "gone | still_present | inconclusive", "sessions_after": 0, "quotes": ["<short quote>"] }',
      "  ]",
      "}",
      "```",
    ].join("\n"),
    "If Houston cannot read your answer, it sends you a message naming what to fix; answer again with the whole report and block.",
  ].join("\n\n");
}

export interface FindingWrite {
  readonly key: string;
  readonly title: string;
  readonly category: string;
  readonly confidence: string;
  readonly sessions: ReadonlyArray<string>;
  readonly count: number;
  readonly quotes: ReadonlyArray<string>;
  readonly recommendationKind: string;
  readonly target: string;
  readonly recommendation: string;
  readonly applyPrompt: string;
}

export type StoredVerdict = "gone" | "still_present" | "inconclusive";

export interface VerificationWrite {
  readonly key: string;
  readonly taskId: number;
  readonly verdict: StoredVerdict;
  readonly sessionsAfter: number;
  readonly evidence: ReadonlyArray<string>;
}

export interface ParsedFindings {
  readonly summary: string | undefined;
  readonly window: readonly [string, string] | null;
  readonly threads: number | null;
  readonly prompts: number | null;
  readonly costUsd: number | null;
  readonly findings: ReadonlyArray<FindingWrite>;
  readonly verifications: ReadonlyArray<VerificationWrite>;
}

/** A task linked to a finding key, with the sessions the server counts after it landed. */
export interface LinkedTask {
  readonly task: string;
  readonly taskId: number;
  readonly sessionsAfter: number;
}

export type Checked<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: string };

class Refusal extends Error {}

const refuse = (message: string): never => {
  throw new Refusal(`findings.json: ${message}`);
};

/** Characters of an offending value a refusal quotes; it reaches the correction and the stored error. */
const SHOWN_CHARS = 2_048;
const show = (value: unknown) => {
  const text = JSON.stringify(value) ?? String(value);
  return text.length <= SHOWN_CHARS
    ? text
    : `${text.slice(0, SHOWN_CHARS)}… (${text.length} characters)`;
};

const KEY = new RegExp(`^[a-z0-9-]{1,${HOUSTON_HARNESS_LIMITS.keyChars}}$`);

/** `text` cut to `max` characters with an ellipsis, trimmed. */
function cap(text: string, max: number): string {
  const characters = Array.from(text);
  return (characters.length <= max ? text : `${characters.slice(0, max).join("")}…`).trim();
}

function text(value: unknown, path: string, max: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return refuse(`${path} must be a string; got ${show(value)}`);
  return cap(value, max);
}

function required(value: unknown, path: string, max: number): string {
  const read = text(value, path, max);
  if (read.length === 0) return refuse(`${path} is required and must be a non-empty string`);
  return read;
}

function list(value: unknown, path: string, maxItems: number, maxChars: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value))
    return refuse(`${path} must be an array of strings; got ${show(value)}`);
  return value.slice(0, maxItems).map((item, index) => text(item, `${path}[${index}]`, maxChars));
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;

function key(value: unknown, path: string): string {
  const read = required(value, path, HOUSTON_HARNESS_LIMITS.keyChars + 1);
  if (!KEY.test(read)) {
    return refuse(
      `${path} is ${show(read)}; expected lowercase kebab-case of at most ${HOUSTON_HARNESS_LIMITS.keyChars} characters`,
    );
  }
  return read;
}

/** Reads findings.json schema 1, checking each verification against the server's links. */
export function parseFindings(
  body: string,
  links: ReadonlyMap<string, ReadonlyArray<LinkedTask>>,
): Checked<ParsedFindings> {
  try {
    return { ok: true, value: parse(body, links) };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, error: error.message };
    throw error;
  }
}

function parse(
  body: string,
  links: ReadonlyMap<string, ReadonlyArray<LinkedTask>>,
): ParsedFindings {
  let root: Record<string, unknown>;
  try {
    root = record(JSON.parse(body));
  } catch (error) {
    return refuse(`the block is not valid JSON: ${(error as Error).message}`);
  }
  if (root.schema !== 1) return refuse(`schema must be 1; got ${show(root.schema ?? null)}`);
  if (!Array.isArray(root.findings)) return refuse("findings must be an array");
  const items = root.findings as ReadonlyArray<unknown>;
  const limits = HOUSTON_HARNESS_LIMITS;
  if (items.length > limits.findings) {
    return refuse(
      `holds ${items.length} findings, over the ${limits.findings} cap; keep the ones with the most impact`,
    );
  }
  const findings: FindingWrite[] = [];
  const seen = new Set<string>();
  items.forEach((raw, index) => {
    const at = (field: string) => `findings[${index}].${field}`;
    const finding = record(raw);
    const findingKey = key(finding.key, at("key"));
    if (seen.has(findingKey)) refuse(`${at("key")} repeats the key ${show(findingKey)}`);
    seen.add(findingKey);
    const evidence = record(finding.evidence);
    const recommendation = record(finding.recommendation);
    const sessions = list(
      evidence.sessions,
      at("evidence.sessions"),
      limits.sessions,
      limits.sessionChars,
    );
    findings.push({
      key: findingKey,
      title: required(finding.title, at("title"), limits.titleChars),
      category: text(finding.category, at("category"), 40),
      confidence: text(finding.confidence, at("confidence"), 20),
      sessions,
      count: count(evidence.count) ?? sessions.length,
      quotes: list(evidence.quotes, at("evidence.quotes"), limits.quotes, limits.quoteChars),
      recommendationKind: text(recommendation.kind, at("recommendation.kind"), 40),
      target: text(recommendation.target, at("recommendation.target"), 500),
      recommendation: text(recommendation.summary, at("recommendation.summary"), limits.textChars),
      applyPrompt: text(
        recommendation.apply_prompt,
        at("recommendation.apply_prompt"),
        limits.applyPromptChars,
      ),
    });
  });

  const verifications: VerificationWrite[] = [];
  const raw = root.verifications;
  if (raw !== undefined && raw !== null) {
    if (!Array.isArray(raw)) {
      refuse(`verifications must be an array of verification objects; got ${show(raw)}`);
    }
    const entries = raw as ReadonlyArray<unknown>;
    if (entries.length > limits.verifications) {
      refuse(`verifications has ${entries.length} items, over the ${limits.verifications} cap`);
    }
    const repeated = new Set<string>();
    entries.forEach((rawEntry, index) => {
      const at = (field: string) => `verifications[${index}].${field}`;
      const entry = record(rawEntry);
      const verificationKey = key(entry.key, at("key"));
      const task = required(entry.task, at("task"), 32);
      const linked = (links.get(verificationKey) ?? []).find((link) => link.task === task);
      if (linked === undefined) {
        refuse(
          `${at("task")} names unlinked task ${show(task)} for key ${show(verificationKey)}; expected a linked task key`,
        );
      }
      const verdictText = required(entry.verdict, at("verdict"), 32);
      if (
        verdictText !== "gone" &&
        verdictText !== "still_present" &&
        verdictText !== "inconclusive"
      ) {
        refuse(
          `${at("verdict")} is ${show(verdictText)}; expected gone, still_present or inconclusive`,
        );
      }
      const reported = count(entry.sessions_after);
      if (reported === null) {
        refuse(
          `${at("sessions_after")} is ${show(entry.sessions_after ?? null)}; expected a non-negative integer`,
        );
      }
      if (reported !== linked!.sessionsAfter) {
        refuse(
          `${at("sessions_after")} is ${reported}; expected ${linked!.sessionsAfter} sessions started after the task landed, excluding its own session`,
        );
      }
      if (verdictText === "gone" && seen.has(verificationKey)) {
        refuse(
          `${at("key")} key ${show(verificationKey)} is both a finding and a gone verification; expected one result per key`,
        );
      }
      const pair = `${verificationKey}\u0000${linked!.taskId}`;
      if (repeated.has(pair)) {
        refuse(
          `${at("key")} repeats verification for key ${show(verificationKey)} and task ${show(task)}`,
        );
      }
      repeated.add(pair);
      if (Array.isArray(entry.quotes) && entry.quotes.length > limits.quotes) {
        refuse(
          `${at("quotes")} has ${entry.quotes.length} quotes; expected at most ${limits.quotes}`,
        );
      }
      verifications.push({
        key: verificationKey,
        taskId: linked!.taskId,
        verdict:
          linked!.sessionsAfter < limits.minimumSessionsAfterLanding
            ? "inconclusive"
            : (verdictText as StoredVerdict),
        sessionsAfter: reported!,
        evidence: list(entry.quotes, at("quotes"), limits.quotes, limits.quoteChars),
      });
    });
  }

  const run = record(root.run);
  const window =
    Array.isArray(run.window) &&
    run.window.length === 2 &&
    run.window.every((day) => typeof day === "string")
      ? ([cap(run.window[0] as string, 10), cap(run.window[1] as string, 10)] as const)
      : null;
  const cost = run.cost_usd;
  return {
    summary: typeof root.summary === "string" ? root.summary : undefined,
    window,
    threads: count(run.threads),
    prompts: count(run.prompts),
    costUsd: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null,
    findings,
    verifications,
  };
}

const FENCE = /^```json[^\n]*\n([\s\S]*?)\n```[ \t]*$/gm;

/** The answer's last fenced `json` block and the text outside it. */
export function readAnswer(answer: string):
  | { readonly ok: true; readonly report: string; readonly findingsJson: string }
  | {
      readonly ok: false;
      readonly error: string;
    } {
  const blocks = Array.from(answer.matchAll(FENCE));
  const last = blocks.at(-1);
  if (last === undefined || last.index === undefined) {
    return { ok: false, error: "the answer has no fenced `json` block holding findings.json" };
  }
  const report =
    `${answer.slice(0, last.index)}${answer.slice(last.index + last[0].length)}`.trim();
  return { ok: true, report: `${report}\n`, findingsJson: last[1]! };
}

/** The review's one-line summary: the block's, capped, or the number of findings. */
export function reviewSummary(summary: string | undefined, findingCount: number): string {
  const given = summary?.trim() ?? "";
  if (given.length > 0)
    return Array.from(given).slice(0, HOUSTON_HARNESS_LIMITS.summaryChars).join("");
  return `${findingCount} ${findingCount === 1 ? "finding" : "findings"}`;
}

/** The message that asks the review thread to answer again. */
export function correctionMessage(error: string): string {
  return [
    `Houston could not read your answer: ${error}.`,
    'Answer again with the whole report, then one fenced `json` block holding findings.json with `"schema": 1`, as the first message of this thread specifies. Houston reads the last fenced `json` block as the findings and the text before it as the report.',
  ].join("\n\n");
}

/** A finding's decision as it reads against the review that raised it. */
export function findingDecision(
  decision: { readonly state: HoustonHarnessDecisionState; readonly decidedAt: string } | null,
  reviewEndedAt: string,
): {
  readonly state: HoustonHarnessDecisionState;
  readonly decidedAt: string | null;
  readonly recurred: boolean;
} {
  if (decision === null) return { state: "open", decidedAt: null, recurred: false };
  if (Date.parse(decision.decidedAt) >= Date.parse(reviewEndedAt)) {
    return { state: decision.state, decidedAt: decision.decidedAt, recurred: false };
  }
  return { state: "open", decidedAt: null, recurred: decision.state !== "open" };
}

export interface PhaseInput {
  readonly state: HoustonHarnessDecisionState;
  /** The newest published review that raised the finding. */
  readonly reviewId: number;
  readonly latestPublishedReviewId: number;
  readonly quotes: ReadonlyArray<string>;
  readonly verification: {
    readonly reviewId: number;
    readonly verdict: StoredVerdict;
    readonly reviewEndedAt: string;
    readonly evidence: ReadonlyArray<string>;
  } | null;
  readonly task: { readonly status: string; readonly createdAt: string } | null;
}

const closedTask = (status: string) => status === "done" || status === "canceled";

/** A finding's phase, in v1's order, and the quotes it shows. */
export function findingPhase(input: PhaseInput): {
  readonly phase: HoustonHarnessFindingPhase;
  readonly quotes: ReadonlyArray<string>;
} {
  const { verification, task } = input;
  const quotes = verification?.verdict === "still_present" ? verification.evidence : input.quotes;
  const phase = ((): HoustonHarnessFindingPhase => {
    if (input.state === "resolved") return "resolved";
    if (input.state === "dismissed") return "dismissed";
    const newerOpenTask =
      task !== null &&
      !closedTask(task.status) &&
      (verification === null ||
        Date.parse(task.createdAt) > Date.parse(verification.reviewEndedAt));
    if (newerOpenTask) return "fixing";
    const notRaisedSince =
      input.latestPublishedReviewId > input.reviewId &&
      (verification === null || input.latestPublishedReviewId > verification.reviewId);
    if (notRaisedSince) return "notSeen";
    if (verification !== null) {
      if (verification.verdict === "gone") return "resolved";
      if (verification.verdict === "still_present") return "open";
      return "awaitingVerification";
    }
    if (task !== null) {
      if (task.status === "done") return "awaitingVerification";
      if (task.status !== "canceled") return "fixing";
    }
    return Math.max(input.latestPublishedReviewId, input.reviewId) > input.reviewId
      ? "notSeen"
      : "open";
  })();
  return { phase, quotes };
}

/** The seen cursor after marking `requested`: never past the latest published review, never back. */
export function nextSeenReviewId(
  current: number,
  requested: number,
  latestPublished: number,
): number {
  return Math.max(current, Math.min(requested, latestPublished));
}
