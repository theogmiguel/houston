import * as Option from "effect/Option";

export type JoinPath = (first: string, ...segments: string[]) => string;

export const CHANNEL_ENV = "HOUSTON_CHANNEL";
export const DEFAULT_CHANNEL_DIR_NAME = ".houston";
// Bounded so a channel name can never become a path bomb or an unreadable dir name.
export const MAX_CHANNEL_LENGTH = 32;
/** The server's own directory below the channel directory. */
export const SERVER_BASE_DIR_NAME = "v2";
/** The server's state directory below its base directory. */
export const SERVER_STATE_DIR_NAME = "userdata";

export class DesktopChannelValidationError extends Error {
  readonly value: string;

  constructor(value: string) {
    super(
      `${CHANNEL_ENV}=${JSON.stringify(value)} is not a valid channel name: ${channelShapeRule()}`,
    );
    this.name = "DesktopChannelValidationError";
    this.value = value;
  }
}

export function channelShapeRule(): string {
  return `expected 1-${MAX_CHANNEL_LENGTH} characters of [a-z0-9-], not starting or ending with '-'; leave it unset (or use "release") for the default ${DEFAULT_CHANNEL_DIR_NAME} directory`;
}

/** Unset, empty, whitespace and "release" all mean the default channel. */
export function validateChannel(raw: string | undefined): Option.Option<string> {
  if (raw === undefined) {
    return Option.none();
  }
  const name = raw.trim();
  if (name.length === 0 || name === "release") {
    return Option.none();
  }
  const shapeOk =
    name.length <= MAX_CHANNEL_LENGTH &&
    /^[a-z0-9-]+$/.test(name) &&
    !name.startsWith("-") &&
    !name.endsWith("-");
  if (!shapeOk) {
    throw new DesktopChannelValidationError(raw);
  }
  return Option.some(name);
}

function normalizeConfiguredBaseDir(houstonHome: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(houstonHome)) {
    return Option.none();
  }
  const trimmed = houstonHome.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

/** The channel directory holds every file a channel owns: `~/.houston` or `~/.houston-<channel>`. */
export function resolveChannelDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly channel: Option.Option<string>;
}): string {
  return Option.match(input.channel, {
    onNone: () => input.joinPath(input.homeDirectory, DEFAULT_CHANNEL_DIR_NAME),
    onSome: (channel) =>
      input.joinPath(input.homeDirectory, `${DEFAULT_CHANNEL_DIR_NAME}-${channel}`),
  });
}

/**
 * The server's base directory. `HOUSTON_HOME` names it directly so development
 * runs keep their state beside the checkout; otherwise it is `<channel dir>/v2`.
 */
export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly houstonHome: Option.Option<string>;
  readonly channel: Option.Option<string>;
}): string {
  return Option.getOrElse(normalizeConfiguredBaseDir(input.houstonHome), () =>
    input.joinPath(
      resolveChannelDir({
        homeDirectory: input.homeDirectory,
        joinPath: input.joinPath,
        channel: input.channel,
      }),
      SERVER_BASE_DIR_NAME,
    ),
  );
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly joinPath: JoinPath;
}): string {
  return input.joinPath(input.baseDir, SERVER_STATE_DIR_NAME);
}

export function resolveServerRuntimeRecordPath(input: {
  readonly stateDir: string;
  readonly joinPath: JoinPath;
}): string {
  return input.joinPath(input.stateDir, "server-runtime.json");
}

/** Electron's own profile directory: `Houston` for the default channel. */
export function resolveUserDataDirectoryName(channel: Option.Option<string>): string {
  return Option.match(channel, {
    onNone: () => "Houston",
    onSome: (name) => `Houston-${name}`,
  });
}

/** The user-facing application name: `Houston` for the default channel. */
export function resolveApplicationName(channel: Option.Option<string>): string {
  return Option.match(channel, {
    onNone: () => "Houston",
    onSome: (name) => `Houston (${name})`,
  });
}
