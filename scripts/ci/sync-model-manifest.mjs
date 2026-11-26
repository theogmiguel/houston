#!/usr/bin/env node
// Translates the upstream model manifest into Houston's shape for the scheduled sync
// workflow. Anything the translation does not understand fails the run instead of
// reaching clients, which read the committed file from `main`.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const UPSTREAM_REPOSITORY = "pingdotgg/t3code";
const MANIFEST_PATH = "apps/server/src/provider/model-manifest.json";
const TOP_LEVEL_KEYS = ["version", "updatedAt", "compatibility", "currentModels", "providers"];
const UPSTREAM_KEY = /t3/i;
// Every slug shipped so far fits; the bound keeps an upstream value from flooding the PR body.
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/;
const SHA = /^[0-9a-f]{40}$/;
/**
 * Compatibility entries Houston keeps instead of upstream's, with the reason shown in the pull
 * request. Remove a driver once Houston has ported the code its upstream ranges depend on.
 */
export const HELD_COMPATIBILITY = new Map([
  [
    "antigravity",
    "Houston installs and launches the pinned ACP server from antigravityRelease.ts; upstream's 1.5 ranges need the native `agy acp` CLI launch (pingdotgg/t3code#35409), which Houston has not ported.",
  ],
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUpstreamKeys(value, path) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectUpstreamKeys(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (UPSTREAM_KEY.test(key)) {
      throw new Error(
        `Upstream manifest has key ${childPath}; expected no upstream-specific key outside compatibility[].t3CodeRange. Teach scripts/ci/sync-model-manifest.mjs its Houston equivalent.`,
      );
    }
    rejectUpstreamKeys(child, childPath);
  }
}

export function translateUpstreamManifest(upstream) {
  if (!isRecord(upstream)) {
    throw new Error(`Upstream manifest is ${JSON.stringify(upstream)}; expected a JSON object`);
  }
  for (const key of Object.keys(upstream)) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      throw new Error(
        `Upstream manifest has top-level key "${key}"; expected only ${TOP_LEVEL_KEYS.join(", ")}`,
      );
    }
  }
  if (!Array.isArray(upstream.compatibility) || !isRecord(upstream.providers)) {
    throw new Error(
      "Upstream manifest lacks a compatibility array or a providers object; expected both",
    );
  }
  const compatibility = upstream.compatibility.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.t3CodeRange !== "string") {
      throw new Error(
        `Upstream manifest compatibility[${index}] (driver ${JSON.stringify(entry?.driver)}) has no string t3CodeRange; expected one per entry`,
      );
    }
    // Houston versions run ahead of upstream's, so every upstream range Houston has
    // ported applies as written; the reviewer drops one whose code was not ported.
    return Object.fromEntries(
      Object.entries(entry).map(([key, value]) => [
        key === "t3CodeRange" ? "houstonCodeRange" : key,
        value,
      ]),
    );
  });
  const translated = { ...upstream, compatibility };
  rejectUpstreamKeys(translated, "$");
  return translated;
}

/** Start and end offsets of each top-level object in the manifest's compatibility array. */
function compatibilitySpans(text) {
  const key = text.indexOf('"compatibility"');
  const start = key === -1 ? -1 : text.indexOf("[", key);
  if (start === -1) {
    throw new Error("Manifest text has no compatibility array; expected one");
  }
  const spans = [];
  let depth = 0;
  let inString = false;
  let objectStart = -1;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index++;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "[" || char === "{") {
      if (depth === 1 && char === "{") objectStart = index;
      depth++;
    } else if (char === "]" || char === "}") {
      depth--;
      if (depth === 1 && char === "}") spans.push([objectStart, index + 1]);
      if (depth === 0) return spans;
    }
  }
  throw new Error("Manifest compatibility array is not closed; expected valid JSON");
}

/** Indexes into `spans` of the compatibility entries for `driver`. */
function driverSpanIndexes(text, spans, driver) {
  return spans.flatMap(([start, end], index) =>
    JSON.parse(text.slice(start, end)).driver === driver ? [index] : [],
  );
}

/**
 * Renames keys in the upstream text rather than re-serialising the object, so the
 * formatter's layout survives and the pull request diff shows only real changes. Each held
 * driver's upstream entries, however many, become Houston's one entry from `currentText`,
 * the committed file, at the position of upstream's first.
 */
export function translateUpstreamText(text, currentText) {
  const translated = translateUpstreamManifest(JSON.parse(text));
  let output = text.replaceAll('"t3CodeRange":', '"houstonCodeRange":');
  if (!output.endsWith("\n")) output = `${output}\n`;
  const expected = { ...translated, compatibility: [...translated.compatibility] };
  for (const driver of currentText === undefined ? [] : HELD_COMPATIBILITY.keys()) {
    const currentSpans = compatibilitySpans(currentText);
    const heldIndexes = driverSpanIndexes(currentText, currentSpans, driver);
    if (heldIndexes.length !== 1) {
      throw new Error(
        `Houston manifest has ${heldIndexes.length} compatibility entries for held driver "${driver}"; expected exactly 1`,
      );
    }
    const spans = compatibilitySpans(output);
    const indexes = driverSpanIndexes(output, spans, driver);
    if (indexes.length === 0) {
      throw new Error(
        `Upstream manifest has 0 compatibility entries for held driver "${driver}"; expected at least 1`,
      );
    }
    const [heldStart, heldEnd] = currentSpans[heldIndexes[0]];
    const held = currentText.slice(heldStart, heldEnd);
    // Later entries go first, each with the separator before it, so earlier offsets stay valid.
    for (const index of indexes.slice(1).toReversed()) {
      output = `${output.slice(0, spans[index - 1][1])}${output.slice(spans[index][1])}`;
    }
    const [start, end] = spans[indexes[0]];
    output = `${output.slice(0, start)}${held}${output.slice(end)}`;
    const first = expected.compatibility.findIndex((entry) => entry.driver === driver);
    expected.compatibility = expected.compatibility.flatMap((entry, index) =>
      index === first ? [JSON.parse(held)] : entry.driver === driver ? [] : [entry],
    );
  }
  if (JSON.stringify(JSON.parse(output)) !== JSON.stringify(expected)) {
    throw new Error(
      'Renaming "t3CodeRange" in the upstream text changed more than the compatibility entries; expected the key only there',
    );
  }
  return { manifest: expected, text: output };
}

function modelSlugs(manifest, provider) {
  const models = manifest.providers?.[provider]?.models;
  return Array.isArray(models) ? models.map((model) => model.slug) : [];
}

export function summarizeModelChanges(before, after) {
  const providers = [
    ...new Set([...Object.keys(before.providers ?? {}), ...Object.keys(after.providers ?? {})]),
  ].toSorted();
  return providers.flatMap((provider) => {
    const was = modelSlugs(before, provider);
    const is = modelSlugs(after, provider);
    const added = is.filter((slug) => !was.includes(slug));
    const removed = was.filter((slug) => !is.includes(slug));
    return added.length === 0 && removed.length === 0 ? [] : [{ provider, added, removed }];
  });
}

function code(value) {
  if (typeof value !== "string" || !SLUG.test(value)) {
    throw new Error(
      `Upstream value ${JSON.stringify(value)} cannot go into the pull request body; expected 1-128 characters of letters, digits and ._:/[]-`,
    );
  }
  return `\`${value}\``;
}

export function formatPullRequestBody({ upstreamSha, changes, held = [] }) {
  if (!SHA.test(upstreamSha)) {
    throw new Error(`Got upstream commit "${upstreamSha}"; expected a 40-character hex SHA`);
  }
  const source = `https://github.com/${UPSTREAM_REPOSITORY}/blob/${upstreamSha}/${MANIFEST_PATH}`;
  const lines = changes.map(({ provider, added, removed }) => {
    const parts = [];
    if (added.length > 0) parts.push(`added ${added.map(code).join(", ")}`);
    if (removed.length > 0) parts.push(`removed ${removed.map(code).join(", ")}`);
    return `- ${code(provider)}: ${parts.join("; ")}`;
  });
  return [
    "## What changed",
    "",
    `Syncs \`${MANIFEST_PATH}\` with the [upstream manifest](${source}). The only translation renames each compatibility entry's \`t3CodeRange\` to \`houstonCodeRange\`.`,
    "",
    ...(lines.length > 0
      ? lines
      : ["No model was added or removed; compatibility ranges or model metadata changed."]),
    ...(held.length > 0
      ? [
          "",
          "Kept Houston's compatibility entry instead of upstream's for:",
          "",
          ...held.map((driver) => `- ${code(driver)}: ${HELD_COMPATIBILITY.get(driver)}`),
        ]
      : []),
    "",
    "## Why",
    "",
    "Clients read this file from `main` within an hour of a merge, so the model picker follows upstream without a release.",
    "",
    "## Review",
    "",
    "- A model or compatibility range upstream added may depend on adapter code Houston has not ported. Check the upstream history of the file before merging and drop entries Houston cannot serve.",
    "- Merging publishes the change to every client.",
    "",
    "## Release notes",
    "",
    "None",
    "",
  ].join("\n");
}

function main() {
  const { values } = NodeUtil.parseArgs({
    options: {
      upstream: { type: "string" },
      target: { type: "string" },
      "upstream-sha": { type: "string" },
      body: { type: "string" },
    },
  });
  for (const name of ["upstream", "target", "upstream-sha", "body"]) {
    if (values[name] === undefined) {
      throw new Error(
        `Missing --${name}; expected --upstream <file> --target <file> --upstream-sha <sha> --body <file>`,
      );
    }
  }
  const currentText = NodeFS.readFileSync(values.target, "utf8");
  const { manifest: after, text } = translateUpstreamText(
    NodeFS.readFileSync(values.upstream, "utf8"),
    currentText,
  );
  const body = formatPullRequestBody({
    upstreamSha: values["upstream-sha"],
    changes: summarizeModelChanges(JSON.parse(currentText), after),
    held: [...HELD_COMPATIBILITY.keys()],
  });
  NodeFS.writeFileSync(values.target, text);
  NodeFS.writeFileSync(values.body, body);
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) main();
