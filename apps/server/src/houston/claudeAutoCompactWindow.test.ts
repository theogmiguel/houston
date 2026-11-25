import { assert, describe, it } from "@effect/vitest";

import {
  type ClaudeAutoCompactWindow,
  type ClaudeCompactSettingsLayer,
  parseClaudeAutoCompactWindowEnv,
  resolveClaudeAutoCompactWindow,
} from "./claudeAutoCompactWindow.ts";

const VARIABLE = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";

const resolve = (input: {
  readonly launch?: ClaudeCompactSettingsLayer;
  readonly files?: ReadonlyArray<ClaudeCompactSettingsLayer>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly houstonWindow?: string;
}) =>
  resolveClaudeAutoCompactWindow({
    model: "claude-opus-5-5",
    layers: [input.launch, ...(input.files ?? [])],
    environment: input.environment ?? {},
    houstonWindow: input.houstonWindow ?? "",
  });

describe("parseClaudeAutoCompactWindowEnv", () => {
  it.each([
    ["300000", 300_000],
    [" 300k ", 300_000],
    ["1.5m", 1_500_000],
    ["50000", 100_000],
    ["auto", undefined],
    ["300,000", undefined],
    ["", undefined],
    ["0", undefined],
    [undefined, undefined],
  ] as const)("reads %j as %j", (value, expected) => {
    assert.strictEqual(parseClaudeAutoCompactWindowEnv(value), expected);
  });
});

describe("resolveClaudeAutoCompactWindow", () => {
  it("takes the variable from --settings, then the files in order, then the process", () => {
    const user = { env: { [VARIABLE]: "300000" } };
    const project = { env: { [VARIABLE]: "400000" } };
    const environment = { [VARIABLE]: "500000" };
    assert.deepEqual(resolve({ environment }), { window: 500_000, source: "environment" });
    assert.deepEqual(resolve({ files: [user], environment }), {
      window: 300_000,
      source: "environment",
    });
    assert.deepEqual(resolve({ files: [project, user], environment }), {
      window: 400_000,
      source: "environment",
    });
    assert.deepEqual(
      resolve({ launch: { env: { [VARIABLE]: "350000" } }, files: [project, user] }),
      { window: 350_000, source: "environment" },
    );
  });

  it("ranks the variable above every autoCompactWindow key", () => {
    assert.deepEqual(
      resolve({
        launch: { autoCompactWindow: 600_000 },
        files: [{ modelSettings: { "claude-opus-5-5": { autoCompactWindow: 700_000 } } }],
        environment: { [VARIABLE]: "300000" },
      }),
      { window: 300_000, source: "environment" },
    );
  });

  it("ignores a variable that is not a size and falls through to the keys", () => {
    assert.deepEqual(
      resolve({ files: [{ autoCompactWindow: 500_000 }], environment: { [VARIABLE]: "auto" } }),
      { window: 500_000, source: "settings" },
    );
  });

  it("ranks a higher layer's key first and a model's key above its layer's top-level key", () => {
    assert.deepEqual(
      resolve({
        files: [
          { modelSettings: { "claude-opus-5-5": { autoCompactWindow: 450_000 } } },
          { autoCompactWindow: 500_000 },
        ],
      }),
      { window: 450_000, source: "settings" },
    );
    assert.deepEqual(
      resolve({
        files: [
          {
            autoCompactWindow: 500_000,
            modelSettings: { "claude-opus-5-5": { autoCompactWindow: 400_000 } },
          },
        ],
      }),
      { window: 400_000, source: "settings" },
    );
  });

  it("treats auto as Claude's own window, which hides lower layers' keys", () => {
    assert.deepEqual(
      resolve({
        files: [
          { modelSettings: { "claude-opus-5-5": { autoCompactWindow: "auto" } } },
          { autoCompactWindow: 500_000 },
        ],
      }),
      { window: null, source: "settings" },
    );
    assert.deepEqual(
      resolve({
        files: [
          { autoCompactWindow: "auto" },
          { modelSettings: { "claude-opus-5-5": { autoCompactWindow: 450_000 } } },
        ],
      }),
      { window: null, source: "settings" },
    );
    assert.deepEqual(
      resolve({
        files: [
          {
            autoCompactWindow: "auto",
            modelSettings: { "claude-opus-5-5": { autoCompactWindow: 400_000 } },
          },
        ],
      }),
      { window: 400_000, source: "settings" },
    );
  });

  it("ranks Houston's setting above the variable from every source and every key", () => {
    const houston: ClaudeAutoCompactWindow = { window: 300_000, source: "houston" };
    assert.deepEqual(resolve({ houstonWindow: "300000" }), houston);
    assert.deepEqual(
      resolve({ environment: { [VARIABLE]: "400000" }, houstonWindow: "300000" }),
      houston,
    );
    assert.deepEqual(
      resolve({ files: [{ env: { [VARIABLE]: "400000" } }], houstonWindow: "300000" }),
      houston,
    );
    assert.deepEqual(
      resolve({ launch: { env: { [VARIABLE]: "400000" } }, houstonWindow: "300000" }),
      houston,
    );
    assert.deepEqual(
      resolve({
        files: [
          {
            autoCompactWindow: 500_000,
            modelSettings: { "claude-opus-5-5": { autoCompactWindow: 450_000 } },
          },
        ],
        houstonWindow: "300000",
      }),
      houston,
    );
    assert.deepEqual(resolve({}), { window: null, source: "default" });
  });

  it("reports auto-compaction off from the variables or autoCompactEnabled", () => {
    const off: ClaudeAutoCompactWindow = { window: null, source: "off" };
    assert.deepEqual(resolve({ environment: { DISABLE_AUTO_COMPACT: "1" } }), off);
    assert.deepEqual(resolve({ files: [{ env: { DISABLE_COMPACT: "true" } }] }), off);
    assert.deepEqual(
      resolve({ files: [{ autoCompactEnabled: false, autoCompactWindow: 400_000 }] }),
      off,
    );
    assert.deepEqual(
      resolve({ environment: { DISABLE_COMPACT: "1" }, houstonWindow: "300000" }),
      off,
    );
    assert.deepEqual(
      resolve({ environment: { DISABLE_AUTO_COMPACT: "0" }, houstonWindow: "300000" }),
      { window: 300_000, source: "houston" },
    );
    assert.deepEqual(
      resolve({
        launch: { autoCompactEnabled: true },
        files: [{ autoCompactEnabled: false }],
        houstonWindow: "300000",
      }),
      { window: 300_000, source: "houston" },
    );
  });
});
