/**
 * Terminal command names Houston answers with an action it already has. The menu and the send
 * path both read this table, so picking a name and typing it then pressing Enter do the same.
 */

export type TerminalActionId =
  | "rewind"
  | "context"
  | "effort"
  | "fast"
  | "permissions"
  | "diff"
  | "fork"
  | "rename"
  | "settings-appearance"
  | "settings-keybindings"
  | "settings-general"
  | "settings-providers"
  | "settings-voice";

export interface TerminalCommandEntry {
  readonly action: TerminalActionId;
  /** The first name is the menu label; the rest are aliases. All are matched case-insensitively. */
  readonly names: readonly [string, ...string[]];
  /** What it opens in Houston, shown in the menu. */
  readonly description: string;
  /** Present when the text after the name is the command's required argument, e.g. `<title>`. */
  readonly argumentHint?: string;
}

export const TERMINAL_COMMAND_ENTRIES: ReadonlyArray<TerminalCommandEntry> = [
  {
    action: "rewind",
    names: ["rewind", "checkpoint", "undo"],
    description: "Rewind to before your last message",
  },
  { action: "context", names: ["context"], description: "Show context window usage" },
  { action: "effort", names: ["effort"], description: "Choose the reasoning effort" },
  { action: "fast", names: ["fast"], description: "Choose the response speed" },
  {
    action: "permissions",
    names: ["permissions"],
    description: "Choose the permission mode",
  },
  { action: "diff", names: ["diff"], description: "Open the changes panel" },
  {
    action: "fork",
    names: ["fork", "branch"],
    description: "Fork this thread at its latest response",
  },
  {
    action: "rename",
    names: ["rename"],
    description: "Rename this thread",
    argumentHint: "<thread title>",
  },
  { action: "settings-appearance", names: ["theme"], description: "Open appearance settings" },
  {
    action: "settings-keybindings",
    names: ["keybindings"],
    description: "Open keyboard shortcut settings",
  },
  { action: "settings-general", names: ["config"], description: "Open settings" },
  {
    action: "settings-providers",
    names: ["status", "login", "logout", "doctor"],
    description: "Open provider status, health and sign-in",
  },
  {
    action: "settings-providers",
    names: ["mcp"],
    description: "Open provider settings, where MCP servers are managed",
  },
  { action: "settings-voice", names: ["voice"], description: "Open voice settings" },
];

const TERMINAL_COMMAND_TEXT = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/i;
const TERMINAL_COMMAND_NAME = /^\/([a-z][a-z0-9-]*)/i;

export interface TerminalCommandAvailability {
  /** Actions the open thread and selected provider can run right now. */
  readonly availableActions: ReadonlySet<TerminalActionId>;
  /** Names (and aliases) the selected provider reports; Houston never shadows these. */
  readonly providerCommandNames: ReadonlyArray<string>;
}

function reportedNames(providerCommandNames: ReadonlyArray<string>): ReadonlySet<string> {
  return new Set(providerCommandNames.map((name) => name.toLowerCase()));
}

/** Entries the menu offers: the action is available, and aliases the provider reports are dropped. */
export function availableTerminalCommandEntries(
  availability: TerminalCommandAvailability,
): ReadonlyArray<TerminalCommandEntry> {
  const reported = reportedNames(availability.providerCommandNames);
  return TERMINAL_COMMAND_ENTRIES.flatMap((entry) => {
    if (!availability.availableActions.has(entry.action)) return [];
    const names = entry.names.filter((name) => !reported.has(name));
    const [primary, ...aliases] = names;
    return primary === undefined ? [] : [{ ...entry, names: [primary, ...aliases] }];
  });
}

/** A whole message of the form `/name [arguments]` whose name is in the table. */
export function parseTerminalCommand(
  text: string,
): { readonly entry: TerminalCommandEntry; readonly argument: string } | null {
  const match = TERMINAL_COMMAND_TEXT.exec(text.trim());
  const name = match?.[1]?.toLowerCase();
  if (name === undefined) return null;
  const entry = TERMINAL_COMMAND_ENTRIES.find((candidate) => candidate.names.includes(name));
  return entry ? { entry, argument: match?.[2]?.trim() ?? "" } : null;
}

/**
 * The action a sent message runs, or null when it should go to the provider as typed: the action
 * must be available, and the typed name must be one Houston owns rather than one the provider
 * reports.
 */
export function resolveTerminalCommand(
  text: string,
  availability: TerminalCommandAvailability,
): { readonly entry: TerminalCommandEntry; readonly argument: string } | null {
  const parsed = parseTerminalCommand(text);
  if (!parsed || !availability.availableActions.has(parsed.entry.action)) return null;
  const name = TERMINAL_COMMAND_NAME.exec(text.trim())?.[1]?.toLowerCase();
  if (name === undefined || reportedNames(availability.providerCommandNames).has(name)) return null;
  return parsed;
}
