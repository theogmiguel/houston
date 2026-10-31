// @effect-diagnostics nodeBuiltinImport:off - bounded synchronous reads of the project's own files.
// What setup finds in the repository so the user does not type it: the checks CI already runs and
// how the app starts. Reading is bounded; nothing here runs a command.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { HOUSTON_NIGHT_SHIFT_LIMITS, type NightCheck } from "@t3tools/contracts/houston/nightShift";
import * as YAML from "yaml";

/** A workflow, manifest or instruction file larger than this is not read. */
const FILE_MAX_BYTES = 512 * 1024;
const WORKFLOWS_MAX = 20;
/** This many safety scripts of one job become one command, so they do not crowd out the rest. */
const SCRIPT_GROUP_MIN = 3;
const CHECK_SCRIPTS = new Set([
  "typecheck",
  "lint",
  "check",
  "format:check",
  "fmt:check",
  "check:types",
]);
const RUNNERS = new Set(["bun", "npm", "pnpm", "yarn"]);

const read = (path: string): string | undefined => {
  try {
    const stat = NodeFS.statSync(path);
    if (!stat.isFile() || stat.size > FILE_MAX_BYTES) return undefined;
    return NodeFS.readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

const words = (command: string) => command.split(/\s+/).filter((word) => word !== "");

/** A safety script: `bash scripts/check-x.sh`. */
const isScript = (command: string) => {
  const w = words(command);
  if (w.length !== 2 || (w[0] !== "bash" && w[0] !== "sh")) return false;
  const file = w[1]!.split("/").pop() ?? "";
  return file.startsWith("check-") && file.endsWith(".sh");
};

/** Commands that check without changing files and finish in minutes; test suites stay in CI. */
export const isCheck = (command: string): boolean => {
  const w = words(command);
  const [first, second, third] = w;
  if (first === "cargo") {
    if (second === "fmt") return w.includes("--check");
    return second === "clippy" || second === "check";
  }
  if (first !== undefined && RUNNERS.has(first)) {
    if (second === "run") return third !== undefined && CHECK_SCRIPTS.has(third);
    return second !== undefined && CHECK_SCRIPTS.has(second);
  }
  if (first === "tsc") return w.includes("--noEmit");
  if (first === "npx" && second === "tsc") return w.includes("--noEmit");
  if ((first === "go" && second === "vet") || (first === "ruff" && second === "check")) return true;
  return isScript(command);
};

/** What makes two commands the same check, past flags and a leading `cd <dir> &&`. */
const key = (command: string) => {
  const w = words(command).filter((word) => !word.startsWith("-"));
  return w.slice(0, w[1] === "run" ? 3 : 2).join(" ");
};

const withoutCd = (command: string) => {
  const split = command.indexOf("&&");
  return split >= 0 && command.trimStart().startsWith("cd ")
    ? command.slice(split + 2).trim()
    : command;
};

/** The program a command starts, past a leading `cd <dir> &&`. */
export const program = (command: string) => words(withoutCd(command))[0] ?? "";

interface Found {
  readonly checks: NightCheck[];
  readonly add: (command: string, source: string) => void;
}

const makeFound = (runnable: (program: string) => boolean): Found => {
  const checks: NightCheck[] = [];
  const seen = new Set<string>();
  return {
    checks,
    add: (command, source) => {
      if (checks.length >= HOUSTON_NIGHT_SHIFT_LIMITS.checks) return;
      if (!runnable(program(command))) return;
      const id = key(withoutCd(command));
      if (seen.has(id)) return;
      seen.add(id);
      checks.push({ command, source });
    },
  };
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const text = (value: unknown) => (typeof value === "string" ? value : undefined);

/** One job's checks in step order, its safety scripts first; each with the scripts it groups. */
const jobChecks = (job: Record<string, unknown>) => {
  const defaultDir = text(asRecord(asRecord(job.defaults)?.run)?.["working-directory"]);
  const checks: Array<readonly [string, number]> = [];
  const scripts: string[] = [];
  const steps = Array.isArray(job.steps) ? job.steps : [];
  for (const raw of steps) {
    const step = asRecord(raw);
    const run = text(step?.run)?.trim();
    if (run === undefined || run.includes("\n") || run.includes("${{") || !isCheck(run)) continue;
    const dir = text(step?.["working-directory"]) ?? defaultDir;
    const command = dir !== undefined && dir !== "." ? `cd ${dir} && ${run}` : run;
    if (isScript(run) && dir === undefined) scripts.push(command);
    else checks.push([command, 0]);
  }
  if (scripts.length >= SCRIPT_GROUP_MIN)
    return [[scripts.join(" && "), scripts.length] as const, ...checks];
  return [...scripts.map((script) => [script, 0] as const), ...checks];
};

const workflowChecks = (root: string, found: Found) => {
  const dir = NodePath.join(root, ".github", "workflows");
  let files: string[];
  try {
    files = NodeFS.readdirSync(dir)
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .toSorted();
  } catch {
    return;
  }
  for (const name of files.slice(0, WORKFLOWS_MAX)) {
    const source = read(NodePath.join(dir, name));
    if (source === undefined) continue;
    let doc: unknown;
    try {
      doc = YAML.parse(source);
    } catch {
      continue;
    }
    const jobs = asRecord(asRecord(doc)?.jobs);
    if (jobs === undefined) continue;
    for (const [jobName, rawJob] of Object.entries(jobs)) {
      const job = asRecord(rawJob);
      if (job === undefined) continue;
      for (const [command, scripts] of jobChecks(job)) {
        found.add(
          command,
          scripts === 0 ? `${name} · ${jobName}` : `${name} · ${jobName} · ${scripts} scripts`,
        );
      }
    }
  }
};

const packageRunner = (root: string) => {
  const exists = (file: string) => NodeFS.existsSync(NodePath.join(root, file));
  if (exists("bun.lock") || exists("bun.lockb")) return "bun run";
  if (exists("pnpm-lock.yaml")) return "pnpm run";
  if (exists("yarn.lock")) return "yarn run";
  return "npm run";
};

const packageScripts = (root: string) => {
  const source = read(NodePath.join(root, "package.json"));
  if (source === undefined) return undefined;
  try {
    return asRecord(asRecord(JSON.parse(source))?.scripts);
  } catch {
    return undefined;
  }
};

/** Backticked one-line spans of a Markdown file. */
const backticked = (source: string) =>
  source
    .split("`")
    .filter((_, index) => index % 2 === 1)
    .map((span) => span.trim())
    .filter((span) => span !== "" && !span.includes("\n"));

const instructionChecks = (root: string, found: Found) => {
  for (const file of ["AGENTS.md", "CLAUDE.md"]) {
    const source = read(NodePath.join(root, file));
    if (source === undefined) continue;
    for (const span of backticked(source)) if (isCheck(span)) found.add(span, file);
    return;
  }
};

/** How the app starts for App QA: a screenshot harness, a package script, a dev script. */
const startCommand = (root: string): NightCheck | null => {
  for (const dir of ["ui/harness", "harness", "app/harness", "web/harness"]) {
    for (const file of ["shot.mjs", "screenshot.mjs", "shot.js"]) {
      const rel = `${dir}/${file}`;
      if (NodeFS.existsSync(NodePath.join(root, rel))) {
        return { command: `node ${rel} <story> <out.png>`, source: rel };
      }
    }
  }
  const scripts = packageScripts(root);
  const name = ["dev", "start"].find((candidate) => scripts?.[candidate] !== undefined);
  if (name !== undefined) {
    return { command: `${packageRunner(root)} ${name}`, source: "package.json" };
  }
  const agents = read(NodePath.join(root, "AGENTS.md"));
  const span =
    agents === undefined
      ? undefined
      : backticked(agents).find((candidate) =>
          (words(candidate)[0]?.split("/").pop() ?? "").startsWith("dev."),
        );
  return span === undefined ? null : { command: span, source: "AGENTS.md" };
};

/** CI workflows first, then package scripts, then the instructions; each once, at most 20. */
export const detect = (
  root: string,
  runnable: (program: string) => boolean,
): { readonly checks: ReadonlyArray<NightCheck>; readonly startCommand: NightCheck | null } => {
  const found = makeFound(runnable);
  workflowChecks(root, found);
  const scripts = packageScripts(root);
  if (scripts !== undefined) {
    const runner = packageRunner(root);
    for (const name of Object.keys(scripts)) {
      const command = `${runner} ${name}`;
      if (isCheck(command)) found.add(command, "package.json");
    }
  }
  instructionChecks(root, found);
  return { checks: found.checks, startCommand: startCommand(root) };
};

/** Whether `program` is on PATH, with PATHEXT on Windows. */
export const onPath =
  (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) =>
  (name: string): boolean => {
    if (name === "") return false;
    const dirs = (env.PATH ?? env.Path ?? "").split(NodePath.delimiter).filter((dir) => dir !== "");
    const extensions =
      platform === "win32"
        ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.toLowerCase())]
        : [""];
    return dirs.some((dir) =>
      extensions.some((ext) => {
        try {
          return NodeFS.statSync(NodePath.join(dir, `${name}${ext}`)).isFile();
        } catch {
          return false;
        }
      }),
    );
  };
