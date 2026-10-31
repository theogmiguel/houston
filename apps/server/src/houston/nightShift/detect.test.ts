// @effect-diagnostics nodeBuiltinImport:off - fixtures are written to a temporary directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { detect } from "./detect.ts";

const roots: string[] = [];
const fixture = (files: Record<string, string>) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "night-detect-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const file = NodePath.join(root, name);
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, content);
  }
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

const CI = `
name: CI
on: [push]
jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: cargo test
      - run: pnpm test
      - run: |
          pnpm lint
          pnpm fmt
`;

describe("night shift detection", () => {
  it("detection lists runnable checks and the start command with sources", () => {
    const root = fixture({
      ".github/workflows/ci.yml": CI,
      "package.json": JSON.stringify({
        scripts: { typecheck: "tsc --noEmit", dev: "vite", test: "vitest", build: "vite build" },
      }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "AGENTS.md": "Run `cargo fmt --check` and `pnpm run typecheck` before a push.\n",
    });
    const onlyPnpm = (program: string) => program === "pnpm";
    expect(detect(root, onlyPnpm)).toEqual({
      checks: [
        { command: "pnpm lint", source: "ci.yml · checks" },
        { command: "pnpm run typecheck", source: "package.json" },
      ],
      startCommand: { command: "pnpm run dev", source: "package.json" },
    });

    // With cargo on PATH the AGENTS.md check is listed; a test suite never is.
    const withCargo = detect(root, (program) => program === "pnpm" || program === "cargo");
    expect(withCargo.checks).toContainEqual({ command: "cargo fmt --check", source: "AGENTS.md" });
    expect(withCargo.checks.map((check) => check.command)).not.toContain("cargo test");
    expect(withCargo.checks.map((check) => check.command)).not.toContain("pnpm test");

    // Nothing runnable: nothing listed.
    expect(detect(root, () => false).checks).toEqual([]);
  });

  it("detection lists runnable checks and the start command with sources, at most 20", () => {
    const jobs = Array.from(
      { length: 25 },
      (_, index) =>
        `  job${index}:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bash scripts/check-${index}.sh\n`,
    ).join("");
    const root = fixture({ ".github/workflows/ci.yml": `on: [push]\njobs:\n${jobs}` });
    const found = detect(root, () => true);
    expect(found.checks).toHaveLength(20);
    expect(found.checks[0]).toEqual({
      command: "bash scripts/check-0.sh",
      source: "ci.yml · job0",
    });
    expect(found.checks[19]?.command).toBe("bash scripts/check-19.sh");
    expect(found.startCommand).toBeNull();
  });
});
