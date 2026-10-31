// @effect-diagnostics nodeBuiltinImport:off - reads the pids the fixture writes and resolves the mock ACP agent script.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { GrokSettings } from "@t3tools/provider-grok/settings";

import { checkGrokProviderStatus } from "@t3tools/provider-grok/testing";
import { execScriptSource, writeFakeCli } from "@t3tools/provider-testing/fakeCli";

const decodeGrokSettings = Schema.decodeSync(GrokSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.resolve(__dirname, "../../scripts/acp-mock-agent.ts");

const LOGGED_IN_MODELS_OUTPUT = [
  "You are logged in with grok.com.",
  "",
  "Default model: grok-4.6",
  "",
  "Available models:",
  "  * grok-4.6 (default)",
  "  - grok-4.5",
  "",
].join("\n");

// The status probe's own bound is 20 s; teardown of the ACP child gets the rest.
const STATUS_BOUND_MS = 30_000;

type AgentBehaviour = "answers" | "silent";

// A stand-in for the Grok CLI. `agent stdio` records its own pid, and on win32 the pid of the
// `cmd` that runs the `.cmd` shim, then serves ACP with the mock agent or reads stdin and never
// answers. Both agents stay alive until something ends them.
const writeFakeGrokCli = (agent: AgentBehaviour) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-teardown-" });
    const pidsPath = NodePath.join(dir, "agent-pids");
    const grokPath = writeFakeCli({
      directory: dir,
      name: "grok",
      source: [
        'if (process.argv[2] === "--version") {',
        '  process.stdout.write("grok 1.0.13\\n");',
        "  process.exit(0);",
        "}",
        'if (process.argv[2] === "models") {',
        `  process.stdout.write(${JSON.stringify(LOGGED_IN_MODELS_OUTPUT)});`,
        "  process.exit(0);",
        "}",
        'if (process.argv[2] !== "agent") process.exit(1);',
        'const { appendFileSync: recordAgentPid } = await import("node:fs");',
        `recordAgentPid(${JSON.stringify(pidsPath)}, process.pid + "\\n");`,
        'if (process.platform === "win32") {',
        `  recordAgentPid(${JSON.stringify(pidsPath)}, process.ppid + "\\n");`,
        "}",
        ...(agent === "answers"
          ? [execScriptSource({ scriptPath: mockAgentPath })]
          : ["process.stdin.resume();", "setInterval(() => {}, 1_000);"]),
        "",
      ].join("\n"),
    });
    return { grokPath, pidsPath };
  });

const runStatus = (agent: AgentBehaviour) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* writeFakeGrokCli(agent);
      const startedAt = yield* Clock.currentTimeMillis;
      const snapshot = yield* checkGrokProviderStatus(
        decodeGrokSettings({ enabled: true, binaryPath: fixture.grokPath }),
        { ...process.env, XAI_API_KEY: "" },
      );
      const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;
      const pids = NodeFS.existsSync(fixture.pidsPath)
        ? NodeFS.readFileSync(fixture.pidsPath, "utf8")
            .split("\n")
            .filter((line) => line.length > 0)
            .map(Number)
        : [];
      return { snapshot, elapsedMs, pids };
    }),
  ).pipe(Effect.provide(NodeServices.layer));

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

describe("checkGrokProviderStatus teardown", () => {
  it.live("ends Grok status within 30 s when the ACP agent stays alive", () =>
    Effect.gen(function* () {
      const { snapshot, elapsedMs } = yield* runStatus("answers");

      expect(elapsedMs).toBeLessThan(STATUS_BOUND_MS);
      expect(snapshot.status).toBe("ready");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["grok-4.6", "grok-mock-alt"]);
    }),
  );

  it.live("ends Grok status within 30 s when the ACP agent never answers initialize", () =>
    Effect.gen(function* () {
      const { snapshot, elapsedMs } = yield* runStatus("silent");

      expect(elapsedMs).toBeLessThan(STATUS_BOUND_MS);
      expect(snapshot.status).not.toBe("ready");
      expect(snapshot.models.map((model) => [model.slug, model.isDefault ?? false])).toEqual([
        ["grok-4.6", true],
        ["grok-4.5", false],
      ]);
    }),
  );

  it.live("leaves no Grok fixture process alive after status returns", () =>
    Effect.gen(function* () {
      for (const agent of ["answers", "silent"] as const) {
        const { pids } = yield* runStatus(agent);

        expect(pids.length, `${agent} agent recorded its pids`).toBeGreaterThan(0);
        expect(
          pids.filter(processIsAlive),
          `${agent} agent processes alive after status returned`,
        ).toEqual([]);
      }
    }),
  );
});
