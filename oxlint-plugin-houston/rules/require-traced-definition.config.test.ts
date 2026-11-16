// @effect-diagnostics nodeBuiltinImport:off - reads the repository lint config with Node path globs.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, describe, it } from "@effect/vitest";

const RULE = "houston/require-traced-definition";

interface Override {
  readonly files: ReadonlyArray<string>;
  readonly excludeFiles?: ReadonlyArray<string>;
  readonly rules?: Readonly<Record<string, unknown>>;
}

// Loaded by path: the root config is outside this package's TypeScript project.
const config: unknown = (
  await import(
    NodeURL.pathToFileURL(NodePath.join(import.meta.dirname, "../../vite.config.ts")).href
  )
).default;

const lint = (
  config as {
    readonly lint: {
      readonly rules: Record<string, unknown>;
      readonly overrides: ReadonlyArray<Override>;
    };
  }
).lint;

const matches = (path: string, patterns: ReadonlyArray<string> | undefined) =>
  (patterns ?? []).some((pattern) => NodePath.matchesGlob(path, pattern));

// The rule's level for a repository path: later overrides win, as in oxlint.
const levelFor = (path: string): string => {
  let level: unknown = lint.rules[RULE] ?? "off";
  for (const override of lint.overrides) {
    if (override.rules?.[RULE] === undefined) continue;
    if (!matches(path, override.files) || matches(path, override.excludeFiles)) continue;
    level = override.rules[RULE];
  }
  return Array.isArray(level) ? String(level[0]) : String(level);
};

describe(`${RULE} configuration`, () => {
  it("is off for tests, test helpers and generated code", () => {
    for (const path of [
      "apps/server/src/houston/observability/TraceContext.test.ts",
      "apps/server/src/houston/slack/slack.testkit.ts",
      "apps/server/src/houston/mergeQueue/test/fixtures.ts",
      "apps/server/src/provider/testUtils/providerRegistryMock.ts",
      "packages/effect-codex-app-server/src/_generated/schema.gen.ts",
      "packages/provider-testing/src/harness.ts",
    ]) {
      assert.strictEqual(levelFor(path), "off", path);
    }
  });

  it("is on for converted server code and off outside the server", () => {
    assert.strictEqual(levelFor("apps/server/src/houston/observability/TraceContext.ts"), "error");
    assert.strictEqual(levelFor("apps/web/src/components/settings/DatadogExportFields.tsx"), "off");
  });
});
