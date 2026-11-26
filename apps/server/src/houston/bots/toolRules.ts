// Which tool calls a bot thread may make. Pure; the provider's tool check calls it for every call.
import type { HoustonBotToolRules } from "@houston-app/contracts/houston/bots";

export type BotToolDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string };

const ALLOW: BotToolDecision = { allow: true };
const refuse = (reason: string): BotToolDecision => ({ allow: false, reason });

const HOUSTON_PREFIX = "mcp__houston__";
const BROWSER_SERVER = "claude-in-chrome";
const SHELL_TOOLS: ReadonlySet<string> = new Set(["Bash", "PowerShell"]);

const READ_VERBS: ReadonlySet<string> = new Set(
  "get list read search fetch query find lookup view describe".split(" "),
);
const WRITE_VERBS: ReadonlySet<string> = new Set(
  (
    "send post create update write delete remove add set edit move archive schedule upload reply " +
    "comment invite publish execute run merge close assign share apply draft"
  ).split(" "),
);

/** Lowercase words of a tool name, split at non-letters and at camel case. */
const nameTokens = (name: string): ReadonlyArray<string> =>
  name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z]+/)
    .filter((token) => token.length > 0)
    .map((token) => token.toLowerCase());

/** A connector tool may be called only when its name reads and nothing in it writes. Fails closed. */
export function connectorCallReads(toolPart: string): boolean {
  const tokens = nameTokens(toolPart);
  return (
    tokens.some((token) => READ_VERBS.has(token)) && !tokens.some((token) => WRITE_VERBS.has(token))
  );
}

/** `mcp__‹server›__‹tool›` gives server and tool; a name without that shape is all tool. */
const splitMcpName = (name: string): { readonly server?: string; readonly tool: string } => {
  if (!name.startsWith("mcp__")) return { tool: name };
  const rest = name.slice("mcp__".length);
  const separator = rest.indexOf("__");
  return separator < 0
    ? { tool: rest }
    : { server: rest.slice(0, separator), tool: rest.slice(separator + 2) };
};

const GH_READ_GROUPS: ReadonlySet<string> = new Set(["issue", "pr", "repo", "release", "run"]);
const GH_READ_ACTIONS: ReadonlySet<string> = new Set(["list", "view", "status", "diff", "checks"]);
const GH_VALUE_FLAGS: ReadonlySet<string> = new Set(["-R", "--repo", "--hostname"]);
const GH_API_WRITE_FLAGS = ["-X", "--method", "-f", "-F", "--field", "--raw-field", "--input"];
/** Words that run the next word as a command. */
const COMMAND_PREFIXES: ReadonlySet<string> = new Set([
  "env",
  "command",
  "exec",
  "nohup",
  "time",
  "sudo",
  "xargs",
]);
const MAX_NESTING = 2;

/** Shell words of one segment; undefined when quoting does not close or a substitution opens. */
function shellWords(segment: string): ReadonlyArray<{ word: string; quoted: boolean }> | undefined {
  if (segment.includes("$(") || segment.includes("`") || segment.includes("<(")) return undefined;
  const words: Array<{ word: string; quoted: boolean }> = [];
  let current = "";
  let quoted = false;
  let started = false;
  let quote: "'" | '"' | null = null;
  for (const char of segment) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      quoted = true;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push({ word: current, quoted });
      current = "";
      quoted = false;
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote !== null) return undefined;
  if (started) words.push({ word: current, quoted });
  return words;
}

const isGhWord = (word: string) => word === "gh" || /[/\\]gh(\.exe)?$/i.test(word);

function ghArgumentsRead(args: ReadonlyArray<string>): boolean {
  const positional: Array<string> = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (positional.length === 0 && arg.startsWith("-")) {
      if (GH_VALUE_FLAGS.has(arg)) index += 1;
      continue;
    }
    positional.push(arg);
  }
  const [group, action] = positional;
  if (group === "search") return true;
  if (group === "api") {
    return !args.some((arg) =>
      GH_API_WRITE_FLAGS.some(
        (flag) =>
          arg === flag ||
          arg.startsWith(`${flag}=`) ||
          (flag.length === 2 && arg.startsWith(flag) && !arg.startsWith("--")),
      ),
    );
  }
  return (
    group !== undefined &&
    action !== undefined &&
    GH_READ_GROUPS.has(group) &&
    GH_READ_ACTIONS.has(action)
  );
}

function segmentReads(segment: string, depth: number): boolean {
  const words = shellWords(segment);
  if (words === undefined) return !/\bgh\b/.test(segment);
  let start = 0;
  while (
    start < words.length &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start]!.word) ||
      COMMAND_PREFIXES.has(words[start]!.word))
  ) {
    start += 1;
  }
  const command = words[start];
  if (command !== undefined && isGhWord(command.word)) {
    return ghArgumentsRead(words.slice(start + 1).map((entry) => entry.word));
  }
  // A quoted word may itself be a command, as in `sh -c '…'`.
  return words.every(
    (entry) =>
      !entry.quoted ||
      !/\bgh\b/.test(entry.word) ||
      (depth < MAX_NESTING && ghCommandReadsAt(entry.word, depth + 1)),
  );
}

function ghCommandReadsAt(command: string, depth: number): boolean {
  return command
    .split(/\r?\n|&&|\|\||[;&|]/)
    .every((segment) => segment.trim().length === 0 || segmentReads(segment.trim(), depth));
}

/** Whether every `gh` in a shell command only reads. It lowers the rate; it is no boundary. */
export const ghCommandReads = (command: string): boolean => ghCommandReadsAt(command, 0);

export function decideToolCall(input: {
  readonly refusedTools: ReadonlyArray<string>;
  readonly rules: HoustonBotToolRules;
  readonly toolName: string;
  readonly toolInput: unknown;
  /** The server the provider says the tool came from. */
  readonly mcpServer?: { readonly name: string } | undefined;
}): BotToolDecision {
  const { rules, toolName } = input;
  if (input.refusedTools.includes(toolName)) {
    return refuse(`${toolName} is not available in this bot thread.`);
  }
  // Any server can be called houston, so only the name decides, never the server.
  if (toolName.startsWith(HOUSTON_PREFIX)) {
    const name = toolName.slice(HOUSTON_PREFIX.length);
    return rules.houstonTools === undefined || rules.houstonTools.includes(name)
      ? ALLOW
      : refuse(`Houston's ${name} is not available in this bot thread.`);
  }
  if (input.mcpServer !== undefined || toolName.startsWith("mcp__")) {
    if (rules.connectorTools === "all") return ALLOW;
    const { server, tool } = splitMcpName(toolName);
    if ((server ?? input.mcpServer?.name) === BROWSER_SERVER) {
      return refuse(`The browser tool ${toolName} is not available when nobody is watching.`);
    }
    return connectorCallReads(tool)
      ? ALLOW
      : refuse(`${toolName} may change something; only reads are allowed when nobody is watching.`);
  }
  if (rules.builtinTools !== undefined && !rules.builtinTools.includes(toolName)) {
    return refuse(`${toolName} is not available when nobody is watching.`);
  }
  if (rules.gh === "reads" && SHELL_TOOLS.has(toolName)) {
    const command =
      typeof input.toolInput === "object" && input.toolInput !== null
        ? Reflect.get(input.toolInput, "command")
        : undefined;
    if (typeof command !== "string") return refuse(`${toolName} was called without a command.`);
    if (!ghCommandReads(command)) {
      return refuse("gh may only read when nobody is watching: list, view, status, diff, checks.");
    }
  }
  return ALLOW;
}
