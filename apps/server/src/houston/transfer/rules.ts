// @effect-diagnostics nodeBuiltinImport:off - destinations follow the host's path rules.
// The rules that decide a transfer's outcome, as pure functions over literal values.
import * as NodePath from "node:path";

import {
  HOUSTON_TRANSFER_EXTENSION,
  HOUSTON_TRANSFER_LIMITS,
  HoustonTransferError,
  type HoustonTransferErrorKind,
} from "@t3tools/contracts/houston/transfer";

/** A refusal lists this many items, then counts the rest. */
export const ERROR_ITEMS = 20;

export const itemsWithCount = (items: ReadonlyArray<string>): Array<string> =>
  items.length <= ERROR_ITEMS
    ? [...items]
    : [...items.slice(0, ERROR_ITEMS), `and ${items.length - ERROR_ITEMS} more`];

export const refusal = (
  kind: HoustonTransferErrorKind,
  operation: string,
  problem: string,
  options: {
    readonly items?: ReadonlyArray<string>;
    readonly steps?: ReadonlyArray<string>;
    readonly limit?: number;
    readonly actual?: number;
  } = {},
) =>
  new HoustonTransferError({
    kind,
    operation,
    problem,
    items: itemsWithCount(options.items ?? []),
    steps: [...(options.steps ?? [])],
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.actual === undefined ? {} : { actual: options.actual }),
  });

const utf8Bytes = (value: string) => Buffer.byteLength(value, "utf8");

/** The export passphrase: at least 12 characters, at most 1,024 bytes. */
export const checkPassphrase = (passphrase: string, operation: string) => {
  const characters = [...passphrase].length;
  const minimum = HOUSTON_TRANSFER_LIMITS.passphraseMinCharacters;
  if (characters < minimum) {
    return refusal(
      "invalid",
      operation,
      `The passphrase has ${characters} characters; at least ${minimum} are required.`,
      {
        steps: [`Use at least ${minimum} characters, then try again.`],
        limit: minimum,
        actual: characters,
      },
    );
  }
  const bytes = utf8Bytes(passphrase);
  const maximum = HOUSTON_TRANSFER_LIMITS.passphraseMaxBytes;
  if (bytes > maximum) {
    return refusal(
      "limit",
      operation,
      `The passphrase has ${bytes} bytes; at most ${maximum} are allowed.`,
      { steps: ["Use a shorter passphrase, then try again."], limit: maximum, actual: bytes },
    );
  }
  return null;
};

/** The import and inspect passphrase: any length a file could have been made with, bounded. */
export const checkReadPassphrase = (passphrase: string, operation: string) => {
  if (passphrase.length === 0) {
    return refusal("invalid", operation, "A passphrase is required.", {
      steps: ["Enter the passphrase, then try again."],
    });
  }
  const bytes = utf8Bytes(passphrase);
  const maximum = HOUSTON_TRANSFER_LIMITS.passphraseMaxBytes;
  return bytes > maximum
    ? refusal(
        "limit",
        operation,
        `The passphrase has ${bytes} bytes; at most ${maximum} are allowed.`,
        {
          limit: maximum,
          actual: bytes,
        },
      )
    : null;
};

export const checkRenderer = (renderer: string | undefined, operation: string) => {
  if (renderer === undefined) return null;
  const bytes = utf8Bytes(renderer);
  const maximum = HOUSTON_TRANSFER_LIMITS.rendererBytes;
  return bytes > maximum
    ? refusal(
        "limit",
        operation,
        `The renderer state has ${bytes} bytes; at most ${maximum} are carried.`,
        { limit: maximum, actual: bytes },
      )
    : null;
};

/** `destination`, with the transfer extension when it lacks one. */
export const transferFileName = (destination: string) =>
  destination.toLowerCase().endsWith(HOUSTON_TRANSFER_EXTENSION)
    ? destination
    : `${destination}${HOUSTON_TRANSFER_EXTENSION}`;

const EXPORT = "houston.transfer.export";

/** An absolute file path in an existing folder, never replacing a file unasked. */
export const checkDestination = (input: {
  readonly destination: string;
  readonly folderExists: boolean;
  readonly fileExists: boolean;
  readonly overwrite: boolean;
}) => {
  if (!NodePath.isAbsolute(input.destination) || NodePath.basename(input.destination) === "") {
    return refusal("invalid", EXPORT, `${input.destination} is not an absolute file path.`, {
      items: [input.destination],
      steps: ["Choose where to save the file, then export again."],
    });
  }
  if (!input.folderExists) {
    const folder = NodePath.dirname(input.destination);
    return refusal("invalid", EXPORT, `The folder ${folder} does not exist.`, {
      items: [folder],
      steps: ["Choose a folder that exists, then export again."],
    });
  }
  if (input.fileExists && !input.overwrite) {
    return refusal(
      "destination_exists",
      EXPORT,
      `A file already exists at ${input.destination}, and replacing it was not confirmed.`,
      {
        items: [input.destination],
        steps: [
          "Export again and choose another name, or pick that file in the save dialog and confirm replacing it.",
        ],
      },
    );
  }
  return null;
};

const RESERVED = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

const FORBIDDEN = /[\u0000-\u001f\u007f\\:<>"|?*]/;
/** NTFS 8.3 short names `.git` can take: `GIT~N`, or `GI` and four hex digits after collisions. */
const DOTGIT_SHORT_NAME = /^gi(?:t|[0-9a-f]{4})~[0-9]+$/i;

/** Why `part` is not a component every supported file system can hold, or null. */
const componentProblem = (part: string): string | null => {
  if (part === "" || part === "." || part === "..") return `the component "${part}"`;
  if (FORBIDDEN.test(part)) return "a character no portable file name has";
  if (part.endsWith(".") || part.endsWith(" ")) return "a name ending with a dot or space";
  if (RESERVED.has(part.split(".")[0]!.toLowerCase())) return "a reserved device name";
  if (part.toLowerCase() === ".git") return "a .git component";
  if (DOTGIT_SHORT_NAME.test(part)) return "a short name of .git on Windows";
  return null;
};

/** Why `path` is not a relative, `/`-separated path of ordinary components, or null. */
export const pathProblem = (path: string): string | null => {
  if (path === "") return "an empty path";
  if (path.startsWith("/") || path.startsWith("\\")) return "an absolute path";
  for (const part of path.split("/")) {
    const problem = componentProblem(part);
    if (problem !== null) return problem;
  }
  return null;
};

/** Why an archive entry name is refused, or null. */
export const entryNameProblem = (name: string): string | null => {
  const problem = pathProblem(name);
  return problem === null ? null : `${name} (${problem})`;
};

/** Every untracked name another computer could not hold, one entry per problem. */
export const unportableNames = (paths: ReadonlyArray<string>): Array<string> => {
  const problems: Array<string> = [];
  for (const path of paths) {
    const problem = pathProblem(path);
    if (problem !== null) problems.push(`${path} (${problem})`);
  }
  const seen = new Map<string, string>();
  for (const path of paths) {
    const folded = path.toLowerCase();
    const first = seen.get(folded);
    if (first === undefined) seen.set(folded, path);
    else problems.push(`${path} and ${first} differ only in letter case`);
  }
  return problems;
};

const SECRET_EXACT = new Set([
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  "credentials.json",
  "secrets.json",
]);
const ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template"]);
const SECRET_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".keystore", ".jks"];
const SSH_KEYS = ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"];

/** Whether an untracked file's name marks it as holding a credential. */
export const isSecretName = (path: string) => {
  const name = (path.split("/").at(-1) ?? path).toLowerCase();
  if (ENV_TEMPLATES.has(name)) return false;
  if (name === ".env" || name.startsWith(".env.")) return true;
  if (SECRET_EXACT.has(name)) return true;
  if (SECRET_EXTENSIONS.some((extension) => name.endsWith(extension))) return true;
  return SSH_KEYS.some((key) => name.startsWith(key));
};

export const secretNames = (paths: ReadonlyArray<string>) => paths.filter(isSecretName);

const AGENT_FOLDERS = new Set([
  ".claude",
  ".codex",
  ".gemini",
  ".opencode",
  ".cursor",
  ".vscode",
  ".idea",
  ".husky",
  ".github",
]);
const AGENT_FILES = new Set([
  ".mcp.json",
  ".envrc",
  "CLAUDE.md",
  "AGENTS.md",
  "GEMINI.md",
  ".gitattributes",
  ".gitmodules",
]);

/** Carried paths that configure agents or tools, at any depth, in the order given. */
export const agentConfigPaths = (paths: ReadonlyArray<string>) =>
  paths.filter((path) => {
    const parts = path.split("/");
    return (
      AGENT_FILES.has(parts.at(-1)!) || parts.slice(0, -1).some((part) => AGENT_FOLDERS.has(part))
    );
  });

/** `url` without a `user:password@` or `token@` part; scp-style and local remotes are kept. */
export const stripRemoteCredentials = (url: string | null): string | null => {
  if (url === null) return null;
  const match = /^([a-z][a-z0-9+.-]*:\/\/)([^/@]*@)?(.*)$/i.exec(url);
  if (match === null) return url;
  return `${match[1]}${match[3]}`;
};

/** `host/path` in lowercase, without scheme, user, port or `.git`; null for a local remote. */
const remoteKey = (url: string): string | null => {
  const trimmed = url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(trimmed);
  if (withScheme !== null && !/^file:/i.test(trimmed)) {
    return `${withScheme[1]}/${withScheme[2]}`.toLowerCase();
  }
  const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/)(.+)$/.exec(trimmed);
  if (scp !== null && scp[1]!.length > 1) return `${scp[1]}/${scp[2]}`.toLowerCase();
  return null;
};

/** Whether two remotes name the same repository, whatever their spelling. */
export const remotesMatch = (left: string | null, right: string | null) => {
  if (left === null || right === null) return false;
  const leftKey = remoteKey(left);
  const rightKey = remoteKey(right);
  if (leftKey === null || rightKey === null) return left.trim() === right.trim();
  return leftKey === rightKey;
};

/** `bytes` as the refusals spell a size: "200 MB", "64 KiB" or "1,234 bytes". */
export const formatSize = (bytes: number) => {
  const mib = 1024 * 1024;
  if (bytes >= mib && bytes % mib === 0) return `${bytes / mib} MB`;
  if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024} KiB`;
  return `${bytes.toLocaleString("en-US")} bytes`;
};

const FINISHED_RUNS = new Set(["completed", "failed", "interrupted", "cancelled", "rolled_back"]);

/** Whether a run in `status` no longer runs; a rolled-back run finished before it was undone. */
export const isFinishedRun = (status: string) => FINISHED_RUNS.has(status);
