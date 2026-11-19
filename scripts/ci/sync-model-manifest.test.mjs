#!/usr/bin/env node
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeTest from "node:test";

import {
  formatPullRequestBody,
  summarizeModelChanges,
  translateUpstreamManifest,
  translateUpstreamText,
} from "./sync-model-manifest.mjs";

const BUNDLED_PATH = new URL("../../apps/server/src/provider/model-manifest.json", import.meta.url);

function upstreamShaped(manifest) {
  return {
    ...manifest,
    compatibility: manifest.compatibility.map((entry) =>
      Object.fromEntries(
        Object.entries(entry).map(([key, value]) => [
          key === "houstonCodeRange" ? "t3CodeRange" : key,
          value,
        ]),
      ),
    ),
  };
}

function manifest(providers, compatibility = []) {
  return {
    version: 1,
    updatedAt: "2026-11-14T15:58:47Z",
    compatibility,
    currentModels: {},
    providers: Object.fromEntries(
      Object.entries(providers).map(([provider, slugs]) => [
        provider,
        { profiles: {}, models: slugs.map((slug) => ({ slug, name: slug, status: "current" })) },
      ]),
    ),
  };
}

NodeTest.test(
  "an upstream copy of the bundled manifest translates back to it, key order included",
  () => {
    const bundled = JSON.parse(NodeFS.readFileSync(BUNDLED_PATH, "utf8"));
    const translated = translateUpstreamManifest(upstreamShaped(bundled));
    NodeAssert.equal(JSON.stringify(translated), JSON.stringify(bundled));
  },
);

NodeTest.test("an upstream copy of the bundled file translates back to it byte for byte", () => {
  const bundled = NodeFS.readFileSync(BUNDLED_PATH, "utf8");
  const upstream = bundled.replaceAll('"houstonCodeRange":', '"t3CodeRange":');
  NodeAssert.notEqual(upstream, bundled);
  NodeAssert.equal(translateUpstreamText(upstream).text, bundled);
});

NodeTest.test("a t3CodeRange key outside compatibility entries is refused", () => {
  const upstream = manifest({ codex: ["gpt-6"] });
  upstream.providers.codex.models[0].name = '"t3CodeRange": x';
  upstream.providers.codex.profiles = { t3CodeRange: ">=0.0.1" };
  NodeAssert.throws(
    () => translateUpstreamText(JSON.stringify(upstream, null, 2)),
    /\$\.providers\.codex\.profiles\.t3CodeRange/,
  );
});

NodeTest.test("the upstream code range becomes the Houston code range in place", () => {
  const translated = translateUpstreamManifest(
    manifest({}, [{ driver: "codex", t3CodeRange: ">=0.0.46", ranges: [] }]),
  );
  NodeAssert.deepEqual(Object.keys(translated.compatibility[0]), [
    "driver",
    "houstonCodeRange",
    "ranges",
  ]);
  NodeAssert.equal(translated.compatibility[0].houstonCodeRange, ">=0.0.46");
});

NodeTest.test(
  "a compatibility entry without an upstream code range is refused with its index",
  () => {
    NodeAssert.throws(
      () => translateUpstreamManifest(manifest({}, [{ driver: "codex", ranges: [] }])),
      /compatibility\[0\] \(driver "codex"\) has no string t3CodeRange/,
    );
  },
);

NodeTest.test("an unknown top-level key is refused by name", () => {
  NodeAssert.throws(
    () => translateUpstreamManifest({ ...manifest({}), channels: {} }),
    /top-level key "channels"; expected only version, updatedAt, compatibility, currentModels, providers/,
  );
});

NodeTest.test("any other upstream-specific key is refused with its path", () => {
  const upstream = manifest({ codex: ["gpt-6"] });
  upstream.providers.codex.models[0].adapter = { codex: { t3MinVersion: "0.0.50" } };
  NodeAssert.throws(
    () => translateUpstreamManifest(upstream),
    /\$\.providers\.codex\.models\[0\]\.adapter\.codex\.t3MinVersion/,
  );
});

NodeTest.test("model changes list added and removed slugs per provider", () => {
  const before = manifest({ antigravity: ["gemini-3.8-flash-high"], codex: ["gpt-6"] });
  const after = manifest({
    antigravity: ["gemini-4-carbon", "gemini-3.8-flash-high"],
    grok: ["grok-5"],
  });
  NodeAssert.deepEqual(summarizeModelChanges(before, after), [
    { provider: "antigravity", added: ["gemini-4-carbon"], removed: [] },
    { provider: "codex", added: [], removed: ["gpt-6"] },
    { provider: "grok", added: ["grok-5"], removed: [] },
  ]);
});

NodeTest.test("the pull request body puts every upstream value in a code span", () => {
  const body = formatPullRequestBody({
    upstreamSha: "0123456789abcdef0123456789abcdef01234567",
    changes: [{ provider: "antigravity", added: ["gemini-4-carbon"], removed: ["gemini-3"] }],
  });
  NodeAssert.match(body, /- `antigravity`: added `gemini-4-carbon`; removed `gemini-3`/);
  NodeAssert.match(
    body,
    /https:\/\/github\.com\/pingdotgg\/t3code\/blob\/0123456789abcdef0123456789abcdef01234567\/apps\/server\/src\/provider\/model-manifest\.json/,
  );
  NodeAssert.match(body, /## Release notes\n\nNone/);
});

NodeTest.test("a body without model changes says only compatibility or metadata changed", () => {
  const body = formatPullRequestBody({
    upstreamSha: "0123456789abcdef0123456789abcdef01234567",
    changes: [],
  });
  NodeAssert.match(body, /No model was added or removed/);
});

NodeTest.test("a slug that could mention, link or break a code span is refused", () => {
  for (const slug of ["@team", "gpt`6", "a b", "x".repeat(129)]) {
    NodeAssert.throws(
      () =>
        formatPullRequestBody({
          upstreamSha: "0123456789abcdef0123456789abcdef01234567",
          changes: [{ provider: "codex", added: [slug], removed: [] }],
        }),
      /expected 1-128 characters of letters, digits and \._:\/\[\]-/,
    );
  }
});

NodeTest.test("an upstream commit that is not a full SHA is refused", () => {
  NodeAssert.throws(
    () => formatPullRequestBody({ upstreamSha: "main", changes: [] }),
    /upstream commit "main"; expected a 40-character hex SHA/,
  );
});
