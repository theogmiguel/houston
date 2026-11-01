// @effect-diagnostics nodeBuiltinImport:off - the defect key is a SHA-256 prefix, as in Houston 1.
// The rules of a suspected defect as pure functions: report bounds, the key, its decision, the
// issue's title, body and search words, and the repository a project defect files into.
import * as NodeCrypto from "node:crypto";

import {
  HOUSTON_DEFECT_LIMITS,
  type HoustonHarnessDecisionState,
  type HoustonHarnessDefectDestination,
} from "@t3tools/contracts/houston/harnessReview";
import * as DateTime from "effect/DateTime";

import { findingDecision } from "../rules.ts";

export const RECORDED_NOTE = "Stored as a suspected defect; nothing is sent anywhere.";
export const GITHUB_ONLY = "filing issues supports github.com only";

const chars = (text: string) => Array.from(text).length;

export interface ReportInput {
  readonly title: string;
  readonly description?: string | undefined;
  readonly evidence?: ReadonlyArray<string> | undefined;
  readonly destination: string;
}

/** Why a report is refused, naming the field, its limit and the value; null when it is in bounds. */
export function checkReport(input: ReportInput): { readonly message: string } | null {
  const { titleChars, evidence, evidenceChars } = HOUSTON_DEFECT_LIMITS;
  const title = chars(input.title.trim());
  if (title === 0 || title > titleChars) {
    return { message: `title has ${title} characters; expected 1 to ${titleChars}` };
  }
  const items = input.evidence ?? [];
  if (items.length > evidence) {
    return { message: `evidence has ${items.length} items; expected at most ${evidence}` };
  }
  for (const [index, item] of items.entries()) {
    const length = chars(item);
    if (length > evidenceChars) {
      return {
        message: `evidence[${index}] has ${length} characters; expected at most ${evidenceChars}`,
      };
    }
  }
  if (input.destination !== "houston" && input.destination !== "project") {
    return {
      message: `destination must be houston or project; got ${JSON.stringify(input.destination.slice(0, 80))}`,
    };
  }
  return null;
}

/** `defect-agent-<8 hex>` over the destination and the lowercased, whitespace-collapsed title. */
export function defectKey(destination: HoustonHarnessDefectDestination, title: string): string {
  const normalized = title.split(/\s+/).filter(Boolean).join(" ").toLowerCase();
  const digest = NodeCrypto.createHash("sha256")
    .update(`${destination}|${normalized}`)
    .digest("hex");
  return `defect-agent-${digest.slice(0, 8)}`;
}

/** New evidence after the stored items, without repeats, up to the cap. */
export function mergeEvidence(
  stored: ReadonlyArray<string>,
  added: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const merged = [...stored];
  for (const item of added) {
    if (merged.length >= HOUSTON_DEFECT_LIMITS.evidence) break;
    if (!merged.includes(item)) merged.push(item);
  }
  return merged;
}

/** A defect's state: a decision older than its last report reads open, recurred. */
export const defectState = (
  decision: { readonly state: HoustonHarnessDecisionState; readonly decidedAt: string } | null,
  lastSeenAt: string,
) => findingDecision(decision, lastSeenAt);

const CONVENTIONAL =
  /^(?:feat|fix|chore|docs|refactor|test|perf|build|ci|revert)(?:\([^)]*\))?!?:/i;

const clip = (text: string, max: number) => {
  const all = Array.from(text);
  return all.length <= max ? text : `${all.slice(0, max - 1).join("")}…`;
};

/** The issue title: the defect title, conventional once, at most 256 characters. */
export function issueTitle(title: string, scope = "harness"): string {
  const raw = title.trim();
  return clip(
    CONVENTIONAL.test(raw) ? raw : `fix(${scope}): ${raw}`,
    HOUSTON_DEFECT_LIMITS.issueTitleChars,
  );
}

/** "YYYY-MM-DD HH:MM UTC". */
export const utcMinute = (iso: string) =>
  `${DateTime.formatIso(DateTime.makeUnsafe(iso)).slice(0, 16).replace("T", " ")} UTC`;

export interface IssueBodyInput {
  readonly source: "agent" | "detector";
  readonly detector: string | null;
  readonly title: string;
  readonly description: string;
  readonly evidence: ReadonlyArray<string>;
  readonly count: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

/** The issue body, at most 60,000 characters; the caller redacts it. */
export function issueBody(row: IssueBodyInput): string {
  const provenance =
    row.source === "detector" && row.detector !== null
      ? `Detected by Houston 1's \`${row.detector}\` detector.`
      : "Reported by an agent thread through `houston_defect_report`.";
  const description = row.description.trim() === "" ? row.title : row.description;
  const evidence =
    row.evidence.length === 0
      ? "- none recorded"
      : row.evidence.map((item) => `- ${item}`).join("\n");
  const body = [
    description,
    "",
    "## Evidence",
    evidence,
    "",
    `${provenance} Seen ${row.count} time${row.count === 1 ? "" : "s"}; first seen ${utcMinute(row.firstSeenAt)} and last seen ${utcMinute(row.lastSeenAt)}.`,
    "",
    "---",
    "Filed from Houston's suspected defects with a redacted draft.",
    "",
  ].join("\n");
  return clip(body, HOUSTON_DEFECT_LIMITS.issueBodyChars);
}

/** At most six words of four or more characters from the title's subject, for the duplicate search. */
export function searchWords(title: string): string {
  const trimmed = title.trim();
  const colon = trimmed.indexOf(":");
  const open = trimmed.indexOf("(");
  const subject =
    colon !== -1 && ((open !== -1 && open < colon) || colon < 20)
      ? trimmed.slice(colon + 1).trim()
      : trimmed;
  const words = subject
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((word) => Array.from(word).length >= 4)
    .slice(0, HOUSTON_DEFECT_LIMITS.searchWords);
  return words.length > 0 ? words.join(" ") : subject.split(/\s+/).slice(0, 3).join(" ");
}

/** `owner/name` with both parts in GitHub's character set, or null. */
export function parseRepository(text: string): string | null {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(text.trim());
  return match === null ? null : `${match[1]}/${match[2]}`;
}

/** The `owner/name` of a github.com remote URL in the https, ssh or scp form, or null. */
export function githubRepositoryOf(url: string): string | null {
  const trimmed = url.trim();
  const scp = /^[^@/:]+@github\.com:(.+)$/i.exec(trimmed);
  let path: string | null = scp?.[1] ?? null;
  if (path === null) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.hostname.toLowerCase() !== "github.com") return null;
      path = parsed.pathname;
    } catch {
      return null;
    }
  }
  return parseRepository(
    path
      .replace(/^\/+/, "")
      .replace(/\/+$/, "")
      .replace(/\.git$/i, ""),
  );
}
