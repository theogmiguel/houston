// The orchestrator's first message: the method, the run's settings, the crew rules, the backlog
// picks and the ledger of earlier runs, within one provider turn's input bound.
import {
  HOUSTON_NIGHT_SHIFT_LIMITS,
  type HoustonNightShiftSettings,
  type NightFocus,
} from "@t3tools/contracts/houston/nightShift";

import { NIGHT_SHIFT_METHOD } from "./method.ts";

const FOCUS: Record<keyof NightFocus, readonly [string, string]> = {
  reliability: [
    "Reliability",
    "crashes, data loss, races and error paths that leave the app in a wrong state",
  ],
  performance: ["Performance", "measured slowness, memory growth and work done more than once"],
  uiPolish: [
    "UI and UX polish",
    "visible inconsistencies, unclear states and rough interactions, judged from screenshots",
  ],
  competitorGaps: [
    "Competitor gaps",
    "features and behaviour the competitors below ship that this project lacks",
  ],
  docsAccuracy: ["Documentation accuracy", "documentation that disagrees with the code"],
  testGaps: ["Test gaps", "behaviour no test proves, starting with the riskiest"],
};

export interface BriefPick {
  readonly number: number;
  readonly title: string;
  readonly text: string;
}

export interface BriefInput {
  readonly runId: number;
  readonly settings: HoustonNightShiftSettings;
  readonly startAt: string;
  readonly wrapUpAt: string;
  readonly hardStopAt: string;
  readonly branch: string;
  readonly picks: ReadonlyArray<BriefPick>;
  /** The ledger of earlier runs, newest first, one line each. */
  readonly digest: ReadonlyArray<string>;
}

const section = (title: string, lines: ReadonlyArray<string>) =>
  [`## ${title}`, "", ...lines].join("\n");

const sizeText = (settings: HoustonNightShiftSettings) =>
  settings.prSize.kind === "one"
    ? "one change per pull request"
    : `up to ${settings.prSize.maxChanges} related changes per pull request`;

const body = (input: BriefInput) => {
  const { settings } = input;
  const focus = (Object.keys(FOCUS) as Array<keyof NightFocus>)
    .filter((area) => settings.focus[area] !== "off")
    .map((area) => {
      const [name, definition] = FOCUS[area];
      return `- ${name} (${settings.focus[area]}): ${definition}.`;
    });
  const direction =
    settings.direction.trim() === ""
      ? ["No direction was given; rank by value and risk within the focus areas."]
      : [
          `Treat this direction as the priority within the focus areas: ${settings.direction.trim()}`,
        ];
  const workers = settings.workers.map((worker) => worker.instanceId).join(", then ");
  const parts = [
    NIGHT_SHIFT_METHOD,
    section("This run", [
      `Run ${input.runId} started at ${input.startAt}. Wrap-up begins at ${input.wrapUpAt}; the hard stop is ${input.hardStopAt}.`,
      `You work in your own worktree on branch ${input.branch}.`,
    ]),
    section("Direction", direction),
    section(
      "Focus areas",
      focus.length === 0 ? ["None is selected; follow the direction."] : focus,
    ),
    section(
      "Competitors",
      settings.competitors.length === 0
        ? ["None."]
        : settings.competitors.map((competitor) => `- ${competitor.repo} (clone it read-only)`),
    ),
    section("Crew rules", [
      `- Every implementation, design, test or general task runs in its own worktree (isolation worktree); research and review may share yours. Never use the project checkout.`,
      `- At most ${settings.liveWorkers} live workers at once, plus one review and one test task; Houston refuses delegations past that.`,
      `- Workers run on ${workers}, in that order; Houston moves a task to the next one when a provider is limited.`,
      `- Start work only with delegate_task; Houston refuses other launches and schedules from this run.`,
      `- Tell every thread you start: do not push, open, merge or enqueue pull requests: record them with \`houston_night_pr\`.`,
    ]),
    section(
      "Checks Houston runs on every pull request head",
      settings.checks.length === 0
        ? ["None is configured."]
        : settings.checks.map((check) => `- \`${check.command}\` (${check.source})`),
    ),
    section("Output", [
      settings.output === "prs"
        ? "Houston opens draft pull requests; nothing is merged."
        : `Houston opens draft pull requests and enqueues those whose gates pass in the merge queue${settings.holdForQa ? ", except visible changes held for the user's QA" : ""}.`,
      `Size: ${sizeText(settings)}.`,
      settings.screenshots ? "Attach screenshots of every visible change." : "Screenshots are off.",
      `Verification depth: ${settings.verification}.`,
    ]),
    section(
      "App QA",
      settings.appQa.enabled
        ? [
            `App QA is on. Start the app with \`${settings.appQa.startCommand ?? ""}\`${settings.appQa.address === null ? "" : ` at ${settings.appQa.address}`}.`,
            ...settings.appQa.smokeFlows.map((flow) => `- ${flow}`),
          ]
        : ["App QA is off."],
    ),
    section(
      "Backlog picks",
      input.picks.length === 0
        ? ["No backlog tasks are picked for this run."]
        : [
            "Give each to one worker. The worker calls houston_task_claim with the task first and houston_task_handback when done.",
            ...input.picks.map((pick) => `- HOU-${pick.number}: ${pick.title}\n  ${pick.text}`),
          ],
    ),
  ];
  return parts.join("\n\n");
};

/** The brief and how many of the digest's oldest items it left out to fit the budget. */
export const composeBrief = (input: BriefInput): { text: string; dropped: number } => {
  const head = body(input);
  const budget = HOUSTON_NIGHT_SHIFT_LIMITS.briefChars;
  const heading = "\n\n## Ledger of earlier runs, newest first\n\n";
  const kept: string[] = [];
  let used = head.length + heading.length;
  // Reserve room for the line that counts what was left out.
  const reserve = 80;
  for (const item of input.digest) {
    const cost = item.length + 1;
    if (used + cost + reserve > budget) break;
    kept.push(item);
    used += cost;
  }
  const dropped = input.digest.length - kept.length;
  const ledger =
    input.digest.length === 0
      ? ""
      : `${heading}${kept.join("\n")}${dropped === 0 ? "" : `\n\n${dropped} older ledger items were left out to fit the brief.`}`;
  return { text: `${head}${ledger}\n`, dropped };
};
