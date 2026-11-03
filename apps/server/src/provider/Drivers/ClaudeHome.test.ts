import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  readClaudeInChromeDefault,
  resolveClaudeGlobalConfigPath,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("uses inherited CLAUDE_CONFIG_DIR when homePath is empty", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const inherited = path.resolve("/tmp/claude-inherited");
        const environment = { CLAUDE_CONFIG_DIR: inherited };

        expect(yield* resolveClaudeHomePath({ homePath: "" }, environment)).toBe(inherited);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" }, environment)).toBe(
          `claude:home:${inherited}`,
        );

        const explicit = path.resolve(NodeOS.homedir(), ".claude-work");
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude-work" }, environment)).toBe(
          explicit,
        );
      }),
    );

    it.effect("resolves the global config inside a configured Claude home", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const home = path.resolve(NodeOS.homedir(), ".claude-work");
        expect(yield* resolveClaudeGlobalConfigPath({ homePath: "~/.claude-work" })).toBe(
          path.join(home, ".claude.json"),
        );
        expect(yield* resolveClaudeGlobalConfigPath({ homePath: "" })).toBe(
          path.join(NodeOS.homedir(), ".claude.json"),
        );
        expect(
          yield* resolveClaudeGlobalConfigPath(
            { homePath: "" },
            {
              CLAUDE_CONFIG_DIR: home,
            },
          ),
        ).toBe(path.join(home, ".claude.json"));
      }),
    );

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );
  });

  describe("Claude in Chrome default", () => {
    it.effect("reads the CLI's default and falls back to off", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "houston-claude-chrome-",
        });
        const configPath = path.join(directory, ".claude.json");

        expect(yield* readClaudeInChromeDefault(configPath)).toBe(false);

        yield* fs.writeFileString(
          configPath,
          JSON.stringify({ claudeInChromeDefaultEnabled: true }),
        );
        expect(yield* readClaudeInChromeDefault(configPath)).toBe(true);

        yield* fs.writeFileString(
          configPath,
          JSON.stringify({ claudeInChromeDefaultEnabled: false }),
        );
        expect(yield* readClaudeInChromeDefault(configPath)).toBe(false);
      }),
    );

    it.effect("treats a malformed file as off", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "houston-claude-chrome-bad-",
        });
        const configPath = path.join(directory, ".claude.json");
        yield* fs.writeFileString(configPath, "{ claudeInChromeDefaultEnabled: ");
        expect(yield* readClaudeInChromeDefault(configPath)).toBe(false);
      }),
    );
  });
});
