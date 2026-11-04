/**
 * Variables that identify a hosting agent session, a multiplexer or a launcher
 * supervisor. A server started from a pane must not pass them to the agents it
 * starts, or those agents inherit another session's identity and endpoints.
 */
export const LAUNCHER_ENV_MARKERS: ReadonlySet<string> = new Set([
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_PID",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "HOUSTON_EXEC_GATE",
  "HOUSTON_EXEC_NONCE",
  "HOUSTON_COMMITTED_SCOPE",
  "HOUSTON_WORKSPACE",
  "HOUSTON_WORKTREE_SLUG",
  "HOUSTON_SUPERVISOR_FD",
  "HOUSTON_MCP_URL",
  "HOUSTON_MCP_TOKEN",
  "HOUSTON_MCP_CONFIG",
  "HOUSTON_TOOL_BOUNDARY_CONTEXT",
  "HOUSTON_CODEX_LAUNCHER",
  "HOUSTON_CODEX_CLI",
  "HOUSTON_CODEX_HOOK_DROP_DIR",
  "HOUSTON_USER_ZDOTDIR",
  "HOUSTON_SHELL_INTEGRATION_TOKEN_FILE",
  "HOUSTON_TASK",
  "HOUSTON_ROUTINE_RUN",
  "TMUX",
  "TMUX_PANE",
  "STY",
  "ZELLIJ",
  "ZELLIJ_SESSION_NAME",
  "ZELLIJ_PANE_ID",
  "ELECTRON_RUN_AS_NODE",
]);

const URL_ENV_PREFIX = "ZCODE_HOUSTON_MCP_URL";

/** ZCode's MCP URL carries the channel in its name, so it matches by prefix. */
export function isLauncherEnvMarker(name: string): boolean {
  return LAUNCHER_ENV_MARKERS.has(name) || name.startsWith(URL_ENV_PREFIX);
}

export function launcherEnvMarkersIn(names: Iterable<string>): ReadonlyArray<string> {
  return [...new Set([...names].filter(isLauncherEnvMarker))].sort();
}

/**
 * Variables to clear from the server child's inherited environment. An
 * `undefined` value removes the inherited entry when the child is spawned with
 * `extendEnv: true`; the caller adds back whatever the child itself needs.
 */
export function launcherEnvPatch(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, undefined> {
  return Object.fromEntries(
    launcherEnvMarkersIn(Object.keys(env)).map((name) => [name, undefined]),
  );
}

/** The scrubbed environment itself, for children spawned without `extendEnv`. */
export function scrubLauncherEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !isLauncherEnvMarker(name)));
}
