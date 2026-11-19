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

/**
 * Renames keys in the upstream text rather than re-serialising the object, so the
 * formatter's layout survives and the pull request diff shows only real changes.
 */
export function translateUpstreamText(text) {
  const translated = translateUpstreamManifest(JSON.parse(text));
  const renamed = text.replaceAll('"t3CodeRange":', '"houstonCodeRange":');
  const output = renamed.endsWith("\n") ? renamed : `${renamed}\n`;
  if (JSON.stringify(JSON.parse(output)) !== JSON.stringify(translated)) {
    throw new Error(
      'Renaming "t3CodeRange" in the upstream text changed more than the compatibility entries; expected the key only there',
    );
  }
  return { manifest: translated, text: output };
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

export function formatPullRequestBody({ upstreamSha, changes }) {
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
  const before = JSON.parse(NodeFS.readFileSync(values.target, "utf8"));
  const { manifest: after, text } = translateUpstreamText(
    NodeFS.readFileSync(values.upstream, "utf8"),
  );
  const body = formatPullRequestBody({
    upstreamSha: values["upstream-sha"],
    changes: summarizeModelChanges(before, after),
  });
  NodeFS.writeFileSync(values.target, text);
  NodeFS.writeFileSync(values.body, body);
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) main();
