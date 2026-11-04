#!/usr/bin/env node
// Classifies changed paths for the CI path filter. Fails closed: an empty diff,
// a non-PR event, a workflow change, or any path the rules do not understand
// turns every job on, so a new path can never quietly skip CI.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

export const OUTPUTS = ["web", "server", "packages", "native", "workflows", "deps", "docs_only"];

// Fail-closed runs every job, so docs_only stays false: it is a skip marker,
// not a job. Setting it here would defeat the fail-closed rule.
const ALL = Object.freeze({
  ...Object.fromEntries(OUTPUTS.map((key) => [key, true])),
  docs_only: false,
});
const NONE = Object.freeze(Object.fromEntries(OUTPUTS.map((key) => [key, false])));

const WORKFLOW_PATHS = [/^\.github\/workflows\//, /^\.github\/actions\//, /^scripts\/ci\//];
const DOCS_PATHS = [/^docs\//, /\.md$/i, /^LICENSE$/i, /^\.gitignore$/i, /^\.gitattributes$/i];
const DEP_PATHS = [
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^\.pnpmfile\.cjs$/,
  /^\.npmrc$/,
  /^patches\//,
  /(^|\/)package\.json$/,
  /^tsconfig\.base\.json$/,
];
const SERVER_PATHS = [
  /^apps\/server\//,
  /^packages\//,
  /^scripts\//,
  /^oxlint-plugin-houston\//,
  /^vite\.config\.ts$/,
];
const WEB_PATHS = [
  /^apps\/web\//,
  /^packages\//,
  /^scripts\//,
  /^oxlint-plugin-houston\//,
  /^vite\.config\.ts$/,
];
const PACKAGE_PATHS = [
  /^packages\//,
  /^apps\/desktop\//,
  /^scripts\//,
  /^oxlint-plugin-houston\//,
  /^vite\.config\.ts$/,
];
const NATIVE_PATHS = [
  /^native\//,
  /^apps\/desktop\/native\//,
  /^assets\//,
  /^apps\/web\/public\//,
  /^\.cargo\//,
];

const matches = (path, patterns) => patterns.some((pattern) => pattern.test(path));

const normalize = (path) => path.trim().replaceAll("\\", "/");

/**
 * Classify a list of repository-relative paths into CI job outputs.
 * Returns every output true when the input cannot be classified.
 */
export function decide(paths) {
  const normalized = paths.map(normalize).filter((path) => path.length > 0);
  if (normalized.length === 0) return { ...ALL };
  if (normalized.some((path) => matches(path, WORKFLOW_PATHS))) return { ...ALL };

  const outputs = { ...NONE };
  let allDocs = true;
  let unmatched = false;

  for (const path of normalized) {
    if (matches(path, DOCS_PATHS)) continue;
    allDocs = false;
    let known = false;

    if (matches(path, DEP_PATHS)) {
      outputs.deps = true;
      outputs.server = true;
      outputs.web = true;
      outputs.packages = true;
      known = true;
    }
    if (matches(path, SERVER_PATHS)) {
      outputs.server = true;
      known = true;
    }
    if (matches(path, WEB_PATHS)) {
      outputs.web = true;
      known = true;
    }
    if (matches(path, PACKAGE_PATHS)) {
      outputs.packages = true;
      known = true;
    }
    if (matches(path, NATIVE_PATHS)) {
      outputs.native = true;
      known = true;
    }
    if (!known) unmatched = true;
  }

  if (unmatched) return { ...ALL };
  if (allDocs) outputs.docs_only = true;
  return outputs;
}

export function formatOutputs(outputs) {
  return `${OUTPUTS.map((key) => `${key}=${outputs[key] ? "true" : "false"}`).join("\n")}\n`;
}

function main() {
  const args = new Set(process.argv.slice(2));
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  if (args.has("--all") || (eventName.length > 0 && eventName !== "pull_request")) {
    process.stdout.write(formatOutputs(ALL));
    return;
  }
  const paths = NodeFS.readFileSync(0, "utf8").split("\n");
  process.stdout.write(formatOutputs(decide(paths)));
}

if (process.argv[1] && NodeURL.pathToFileURL(process.argv[1]).href === import.meta.url) main();
