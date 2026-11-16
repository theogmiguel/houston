import { assert, describe, it } from "@effect/vitest";

import {
  isLauncherEnvMarker,
  launcherEnvMarkersIn,
  launcherEnvPatch,
  scrubLauncherEnv,
} from "./DesktopEnvHygiene.ts";

describe("launcher environment hygiene", () => {
  it("drops session, multiplexer and Electron launcher markers but keeps agent settings", () => {
    const env = {
      PATH: "/usr/bin",
      CLAUDECODE: "1",
      CLAUDE_CODE_CHILD_SESSION: "x",
      CLAUDE_CODE_SESSION_ID: "x",
      CLAUDE_CONFIG_DIR: "/home/theo/.claude",
      ANTHROPIC_API_KEY: "secret",
      HOUSTON_CHANNEL: "dev",
      HOUSTON_SESSION: "abc",
      HOUSTON_WORKSPACE: "/repo",
      TMUX: "/tmp/tmux",
      ZELLIJ: "0",
      ELECTRON_RUN_AS_NODE: "1",
      ZCODE_HOUSTON_MCP_URL_DEV: "http://127.0.0.1:1",
    };
    assert.deepStrictEqual(launcherEnvMarkersIn(Object.keys(env)), [
      "CLAUDECODE",
      "CLAUDE_CODE_CHILD_SESSION",
      "CLAUDE_CODE_SESSION_ID",
      "ELECTRON_RUN_AS_NODE",
      "HOUSTON_WORKSPACE",
      "TMUX",
      "ZCODE_HOUSTON_MCP_URL_DEV",
      "ZELLIJ",
    ]);
  });

  it("matches ZCode's channel-suffixed MCP URL by prefix", () => {
    assert.isTrue(isLauncherEnvMarker("ZCODE_HOUSTON_MCP_URL"));
    assert.isTrue(isLauncherEnvMarker("ZCODE_HOUSTON_MCP_URL_PR_42"));
    assert.isFalse(isLauncherEnvMarker("HOUSTON_MCP_URL_EXTRA"));
  });

  it("scrubs the child environment without touching unrelated variables", () => {
    const scrubbed = scrubLauncherEnv({
      PATH: "/usr/bin",
      HOUSTON_CHANNEL: "dev",
      HOUSTON_SESSION: "abc",
      CLAUDE_CONFIG_DIR: "/home/theo/.claude",
      ELECTRON_RUN_AS_NODE: "1",
      TMUX_PANE: "%1",
    });
    assert.deepStrictEqual(scrubbed, {
      PATH: "/usr/bin",
      HOUSTON_CHANNEL: "dev",
      HOUSTON_SESSION: "abc",
      CLAUDE_CONFIG_DIR: "/home/theo/.claude",
    });
  });

  it("builds an undefined-valued patch for extendEnv children", () => {
    assert.deepStrictEqual(
      launcherEnvPatch({ PATH: "/usr/bin", CLAUDECODE: "1", TMUX: "/tmp/tmux" }),
      { CLAUDECODE: undefined, TMUX: undefined },
    );
  });
});
