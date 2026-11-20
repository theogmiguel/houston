import type {
  TerminalShellCandidate,
  TerminalShells,
} from "@houston-app/contracts/houston/terminalShells";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

const WHITESPACE_RUN = /\s+/g;
const QUOTES = /^['"]|['"]$/g;
const WINDOWS_PATH_SEPARATOR = /[\\/]/;
const WINDOWS_DRIVE = /^[A-Za-z]:/;
const COMMENT = /#.*$/;

const POSIX_SHELLS = [
  "/bin/bash",
  "/usr/bin/bash",
  "/bin/zsh",
  "/usr/bin/zsh",
  "/bin/fish",
  "/usr/bin/fish",
  "/bin/sh",
];

const POSIX_LABELS: Readonly<Record<string, string>> = {
  bash: "Bash",
  zsh: "Zsh",
  fish: "Fish",
  sh: "sh",
};

export interface TerminalShellEnvironment {
  readonly fs: FileSystem.FileSystem;
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
}

/** The executable token the spawner receives, or null when the value names no command. */
export function normalizeShellCommand(
  value: string | undefined,
  platform: NodeJS.Platform,
): string | null {
  if (!value) return null;
  const original = value.trim();
  const trimmed = original.replace(QUOTES, "").trim();
  if (trimmed.length === 0) return null;
  if (platform === "win32") return trimmed;
  if (original.startsWith("'") || original.startsWith('"')) return trimmed;
  return trimmed.split(WHITESPACE_RUN)[0] ?? null;
}

function basename(shell: string, platform: NodeJS.Platform): string {
  const normalized =
    platform === "win32" ? shell.replaceAll("/", "\\") : shell.replaceAll("\\", "/");
  const parts = normalized.split(platform === "win32" ? /\\+/ : /\/+/).filter(Boolean);
  return parts.at(-1) ?? normalized;
}

function shellLabel(shell: string, platform: NodeJS.Platform): string {
  const name = basename(shell, platform)
    .toLowerCase()
    .replace(/\.exe$/, "");
  return POSIX_LABELS[name] ?? name;
}

function joinWindowsPath(...parts: ReadonlyArray<string>): string {
  return parts
    .map((part, index) => {
      if (index === 0) return part.replace(/[\\/]+$/g, "");
      return part.replace(/^[\\/]+|[\\/]+$/g, "");
    })
    .filter((part) => part.length > 0)
    .join("\\");
}

function windowsSystemRoot(env: NodeJS.ProcessEnv): string {
  return env.SystemRoot?.trim() || env.windir?.trim() || "C:\\Windows";
}

export function parseShellList(contents: string): ReadonlyArray<string> {
  const shells: string[] = [];
  for (const line of contents.split(/\r?\n/)) {
    const value = line.replace(COMMENT, "").trim();
    if (value.length === 0 || !value.startsWith("/")) continue;
    shells.push(value);
  }
  return [...new Set(shells)];
}

/** POSIX shells in preference order from the login shell, /etc/shells and the usual paths. */
export function posixShellCandidates(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly etcShells: string;
}): ReadonlyArray<string> {
  return [
    ...unique([input.env.SHELL?.trim() ?? "", ...parseShellList(input.etcShells), ...POSIX_SHELLS]),
  ].filter((shell) => shell.length > 0);
}

/** Windows shells that exist at paths this process can compute without a PATH lookup. */
export function windowsShellCandidates(
  env: NodeJS.ProcessEnv,
): ReadonlyArray<TerminalShellCandidate> {
  const programFiles = env.ProgramFiles?.trim() || "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"]?.trim() || "C:\\Program Files (x86)";
  const localAppData = env.LOCALAPPDATA?.trim() || "";
  const candidates: Array<TerminalShellCandidate> = [
    { shell: "pwsh.exe", label: "PowerShell" },
    {
      shell: joinWindowsPath(
        windowsSystemRoot(env),
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      label: "Windows PowerShell",
    },
    {
      shell: env.ComSpec?.trim() || joinWindowsPath(windowsSystemRoot(env), "System32", "cmd.exe"),
      label: "Command Prompt",
    },
    { shell: joinWindowsPath(programFiles, "Git", "bin", "bash.exe"), label: "Git Bash" },
    {
      shell: joinWindowsPath(programFilesX86, "Git", "bin", "bash.exe"),
      label: "Git Bash",
    },
    ...(localAppData.length > 0
      ? [
          {
            shell: joinWindowsPath(localAppData, "Programs", "Git", "bin", "bash.exe"),
            label: "Git Bash",
          },
        ]
      : []),
    { shell: "wsl.exe", label: "WSL" },
  ];
  return uniqueShellCandidates(candidates);
}

function unique(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)];
}

function uniqueShellCandidates(
  candidates: ReadonlyArray<TerminalShellCandidate>,
): TerminalShellCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = candidate.shell.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pathEntries(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const raw = platform === "win32" ? (env.Path ?? env.PATH ?? "") : (env.PATH ?? "");
  return raw
    .split(platform === "win32" ? ";" : ":")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATHEXT?.trim();
  return raw && raw.length > 0 ? raw.split(";").filter(Boolean) : [".EXE", ".CMD", ".BAT", ".COM"];
}

const isExecutableFile = (
  fs: FileSystem.FileSystem,
  platform: NodeJS.Platform,
  file: string,
): Effect.Effect<boolean> =>
  fs.stat(file).pipe(
    Effect.map(
      (info) => info.type === "File" && (platform === "win32" || (info.mode & 0o111) !== 0),
    ),
    Effect.orElseSucceed(() => false),
  );

/** Finds a shell on PATH (or at its absolute path) and returns the path the spawner can use. */
export const resolveShellExecutable = Effect.fn("terminalShells.resolveShellExecutable")(function* (
  environment: TerminalShellEnvironment,
  value: string,
): Effect.fn.Return<string | null> {
  const { fs, platform, env } = environment;
  const command = normalizeShellCommand(value, platform);
  if (command === null) return null;

  const looksLikePath =
    platform === "win32"
      ? WINDOWS_PATH_SEPARATOR.test(command) || WINDOWS_DRIVE.test(command)
      : command.includes("/");
  if (looksLikePath) {
    return (yield* isExecutableFile(fs, platform, command)) ? command : null;
  }

  const extensions =
    platform === "win32" && !/\.[A-Za-z0-9]+$/.test(command) ? windowsExtensions(env) : [""];
  for (const entry of pathEntries(env, platform)) {
    for (const extension of extensions) {
      const candidate =
        platform === "win32"
          ? joinWindowsPath(entry, `${command}${extension}`)
          : `${entry.replace(/\/+$/g, "")}/${command}`;
      if (yield* isExecutableFile(fs, platform, candidate)) return candidate;
    }
  }
  return null;
});

export interface TerminalShellAvailability {
  readonly available: boolean;
  readonly shell: string;
  readonly message: string;
}

export const TERMINAL_SHELL_EXPECTED_SHAPE =
  "an absolute path to an executable shell, or a shell command on PATH";

export const terminalShellUnavailableMessage = (value: string): string =>
  `Terminal shell "${value}" is unavailable. Enter ${TERMINAL_SHELL_EXPECTED_SHAPE}, or reset to the system default.`;

export const checkTerminalShell = Effect.fn("terminalShells.checkTerminalShell")(function* (
  environment: TerminalShellEnvironment,
  value: string,
): Effect.fn.Return<TerminalShellAvailability> {
  const shell = yield* resolveShellExecutable(environment, value);
  return shell === null
    ? {
        available: false,
        shell: "",
        message: terminalShellUnavailableMessage(value),
      }
    : { available: true, shell, message: "" };
});

/** Reads /etc/shells, treating a missing or unreadable file as an empty list. */
const readEtcShells = (fs: FileSystem.FileSystem): Effect.Effect<string> =>
  fs.readFileString("/etc/shells").pipe(Effect.orElseSucceed(() => ""));

export const detectTerminalShells = Effect.fn("terminalShells.detectTerminalShells")(function* (
  environment: TerminalShellEnvironment,
): Effect.fn.Return<TerminalShells> {
  const { fs, platform, env } = environment;
  const defaultShell = platform === "win32" ? "pwsh.exe" : env.SHELL?.trim() || "bash";

  const requested =
    platform === "win32"
      ? windowsShellCandidates(env)
      : posixShellCandidates({ env, etcShells: yield* readEtcShells(fs) }).map((shell) => ({
          shell,
          label: shellLabel(shell, platform),
        }));

  const candidates: TerminalShellCandidate[] = [];
  for (const candidate of requested) {
    const resolved = yield* resolveShellExecutable(environment, candidate.shell);
    if (resolved === null) continue;
    candidates.push({ shell: resolved, label: candidate.label });
  }

  const uniqueCandidates = uniqueShellCandidates(candidates);
  return {
    defaultShell: (yield* resolveShellExecutable(environment, defaultShell)) ?? defaultShell,
    candidates: uniqueCandidates,
  };
});
