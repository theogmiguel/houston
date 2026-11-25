// Where Claude Code compacts on its own. Houston sends its "Auto-compact after" setting as the
// variable and the key, so it ranks above every value in Claude's own configuration.

/** `environment` is CLAUDE_CODE_AUTO_COMPACT_WINDOW and `settings` an autoCompactWindow key. */
export type ClaudeAutoCompactWindowSource =
  | "off"
  | "environment"
  | "settings"
  | "houston"
  | "default";

export interface ClaudeAutoCompactWindow {
  /** Tokens Claude compacts within; null when it never compacts or picks the window itself. */
  readonly window: number | null;
  readonly source: ClaudeAutoCompactWindowSource;
}

/** One Claude settings layer as read from `--settings` or a settings file. */
export interface ClaudeCompactSettingsLayer {
  readonly env?: Readonly<Record<string, unknown>> | undefined;
  readonly autoCompactEnabled?: unknown;
  readonly autoCompactWindow?: unknown;
  readonly modelSettings?: unknown;
}

// Claude Code 2.1.330 treats a smaller window as this minimum and validates settings values
// against 100,000 to 1,000,000 tokens.
const MIN_WINDOW = 100_000;
const MAX_SETTINGS_WINDOW = 1_000_000;

// Claude Code's isEnvTruthy.
function isClaudeEnvTruthy(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/** Reads CLAUDE_CODE_AUTO_COMPACT_WINDOW as Claude Code does; a value that is not a size is unset. */
export function parseClaudeAutoCompactWindowEnv(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const suffix = trimmed.slice(-1).toLowerCase();
  const multiplier = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : undefined;
  const tokens = Math.round(
    multiplier === undefined
      ? trimmed.length === 0
        ? Number.NaN
        : Number(trimmed)
      : Number.parseFloat(trimmed) * multiplier,
  );
  if (!Number.isSafeInteger(tokens) || tokens < 1) return undefined;
  return Math.max(tokens, MIN_WINDOW);
}

function settingsWindow(value: unknown): number | null | undefined {
  if (value === "auto") return null;
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_WINDOW &&
    value <= MAX_SETTINGS_WINDOW
    ? value
    : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// Settings env beats the process env and earlier layers beat later ones. The variable beats every
// autoCompactWindow key, a model's key beats its layer's top-level key, and "auto" in either is
// Claude's own window, which also hides lower layers' keys.
export function resolveClaudeAutoCompactWindow(input: {
  /** Claude's settings key for the model: its API id without a context-size suffix. */
  readonly model: string;
  /** `--settings` first, then the settings files by precedence. */
  readonly layers: ReadonlyArray<ClaudeCompactSettingsLayer | undefined>;
  /** The instance environment over the server's process environment. */
  readonly environment: NodeJS.ProcessEnv;
  /** Houston's "Auto-compact after" setting; empty when unset. */
  readonly houstonWindow: string;
}): ClaudeAutoCompactWindow {
  const env = (name: string) => {
    for (const layer of input.layers) {
      const value = layer?.env?.[name];
      if (typeof value === "string") return value;
    }
    return input.environment[name];
  };
  if (isClaudeEnvTruthy(env("DISABLE_COMPACT")) || isClaudeEnvTruthy(env("DISABLE_AUTO_COMPACT")))
    return { window: null, source: "off" };
  const enabled = input.layers.find(
    (layer) => typeof layer?.autoCompactEnabled === "boolean",
  )?.autoCompactEnabled;
  if (enabled === false) return { window: null, source: "off" };
  if (input.houstonWindow !== "") return { window: Number(input.houstonWindow), source: "houston" };

  const envWindow = parseClaudeAutoCompactWindowEnv(env("CLAUDE_CODE_AUTO_COMPACT_WINDOW"));
  if (envWindow !== undefined) return { window: envWindow, source: "environment" };

  for (const layer of input.layers) {
    const modelSetting = record(record(layer?.modelSettings)?.[input.model]);
    const modelWindow = settingsWindow(modelSetting?.autoCompactWindow);
    if (modelWindow !== undefined) return { window: modelWindow, source: "settings" };
    const layerWindow = settingsWindow(layer?.autoCompactWindow);
    if (layerWindow !== undefined) return { window: layerWindow, source: "settings" };
  }
  return { window: null, source: "default" };
}
