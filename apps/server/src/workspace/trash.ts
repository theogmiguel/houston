// @effect-diagnostics nodeBuiltinImport:off globalDate:off - The trash protocol needs node:fs and node:child_process, and a local-time DeletionDate.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Context from "effect/Context";

/** A moved entry can copy a large directory, so the command gets a generous budget. */
const TRASH_COMMAND_TIMEOUT_MS = 30_000;
const TRASH_COMMAND_MAX_BUFFER = 64 * 1024;
export const WINDOWS_TRASH_PATH_VARIABLE = "HOUSTON_TRASH_PATH";

export interface TrashCommandResult {
  readonly exitCode: number;
  readonly stderr: string;
}

export type TrashCommandRunner = (
  command: string,
  args: ReadonlyArray<string>,
  extraEnvironment?: Readonly<Record<string, string>>,
) => Promise<TrashCommandResult>;

const defaultTrashCommandRunner: TrashCommandRunner = (command, args, extraEnvironment) =>
  new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      command,
      [...args],
      {
        timeout: TRASH_COMMAND_TIMEOUT_MS,
        ...(extraEnvironment === undefined
          ? {}
          : // oxlint-disable-next-line houston/no-global-process-runtime -- The child inherits the server environment plus the trash target.
            { env: { ...process.env, ...extraEnvironment } }),
        maxBuffer: TRASH_COMMAND_MAX_BUFFER,
        windowsHide: true,
      },
      (error, _stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stderr }));
          return;
        }
        resolve({ exitCode: 0, stderr });
      },
    );
  });

export interface TrashContextValue {
  readonly platform: NodeJS.Platform;
  readonly environment: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly runCommand: TrashCommandRunner;
  readonly now: () => Date;
}

export const TrashContext = Context.Reference<TrashContextValue>(
  "@houston-app/cli/workspace/TrashContext",
  {
    defaultValue: () => ({
      // oxlint-disable-next-line houston/no-global-process-runtime -- Fallback context for the platform trash; Effect callers inject TrashContext.
      platform: process.platform,
      environment: process.env,
      homeDirectory: NodeOS.homedir(),
      runCommand: defaultTrashCommandRunner,
      now: () => new Date(),
    }),
  },
);

export type TrashMoveResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

const isMissingCommand = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

function commandFailure(error: unknown, fallback: string): string {
  if (typeof error !== "object" || error === null) return fallback;
  const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr.trim() : "";
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  const detail = stderr || message || fallback;
  return detail.length > 300 ? `${detail.slice(0, 300)}…` : detail;
}

async function exists(target: string): Promise<boolean> {
  try {
    await NodeFSP.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/** Freedesktop's trashinfo encodes each path segment and keeps the separators. */
export const encodeTrashInfoPath = (absolutePath: string): string =>
  absolutePath.split(NodePath.sep).map(encodeURIComponent).join("/");

/** Freedesktop expects local time without an offset: YYYY-MM-DDThh:mm:ss. */
export const formatDeletionDate = (date: Date): string => {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

async function moveToFreedesktopTrash(
  absolutePath: string,
  context: TrashContextValue,
): Promise<TrashMoveResult> {
  const configuredDataHome = context.environment.XDG_DATA_HOME?.trim();
  const dataHome =
    configuredDataHome && NodePath.isAbsolute(configuredDataHome)
      ? configuredDataHome
      : NodePath.join(context.homeDirectory, ".local", "share");
  const trashDirectory = NodePath.join(dataHome, "Trash");
  const filesDirectory = NodePath.join(trashDirectory, "files");
  const infoDirectory = NodePath.join(trashDirectory, "info");

  try {
    await NodeFSP.mkdir(filesDirectory, { recursive: true });
    await NodeFSP.mkdir(infoDirectory, { recursive: true });
  } catch (error) {
    return {
      ok: false,
      reason: `the home trash '${trashDirectory}' could not be created: ${commandFailure(error, "unknown error")}`,
    };
  }

  const entry = await NodeFSP.lstat(absolutePath);
  const trash = await NodeFSP.stat(trashDirectory);
  if (entry.dev !== trash.dev) {
    return {
      ok: false,
      reason: `'${absolutePath}' is on a different filesystem than the home trash '${trashDirectory}' (device ${entry.dev} versus ${trash.dev})`,
    };
  }

  const baseName = NodePath.basename(absolutePath);
  let name = baseName;
  let infoPath = NodePath.join(infoDirectory, `${name}.trashinfo`);
  let dataPath = NodePath.join(filesDirectory, name);
  for (let suffix = 1; (await exists(infoPath)) || (await exists(dataPath)); suffix += 1) {
    name = `${baseName}.${suffix}`;
    infoPath = NodePath.join(infoDirectory, `${name}.trashinfo`);
    dataPath = NodePath.join(filesDirectory, name);
  }

  const trashInfo = [
    "[Trash Info]",
    `Path=${encodeTrashInfoPath(absolutePath)}`,
    `DeletionDate=${formatDeletionDate(context.now())}`,
    "",
  ].join("\n");
  try {
    await NodeFSP.writeFile(infoPath, trashInfo, { flag: "wx" });
  } catch (error) {
    return {
      ok: false,
      reason: `the trash info file '${infoPath}' could not be written: ${commandFailure(error, "unknown error")}`,
    };
  }

  try {
    await NodeFSP.rename(absolutePath, dataPath);
  } catch (error) {
    await NodeFSP.rm(infoPath, { force: true });
    return {
      ok: false,
      reason: `'${absolutePath}' could not be moved into the home trash '${filesDirectory}': ${commandFailure(error, "unknown error")}`,
    };
  }
  return { ok: true };
}

async function moveToLinuxTrash(
  absolutePath: string,
  context: TrashContextValue,
): Promise<TrashMoveResult> {
  try {
    const result = await context.runCommand("gio", ["trash", "--", absolutePath]);
    if (result.exitCode === 0) return { ok: true };
    return {
      ok: false,
      reason: `'gio trash -- ${absolutePath}' exited with code ${result.exitCode}: ${
        result.stderr.trim() || "no error output"
      }`,
    };
  } catch (error) {
    if (!isMissingCommand(error)) {
      return {
        ok: false,
        reason: `'gio trash -- ${absolutePath}' could not run: ${commandFailure(
          error,
          "unknown error",
        )}`,
      };
    }
  }
  return moveToFreedesktopTrash(absolutePath, context);
}

async function moveToWindowsRecycleBin(
  absolutePath: string,
  context: TrashContextValue,
): Promise<TrashMoveResult> {
  // `-Command` joins trailing arguments into the script text, so the path travels in the
  // environment and never becomes PowerShell source.
  const script = [
    "Add-Type -AssemblyName Microsoft.VisualBasic",
    `$target = $env:${WINDOWS_TRASH_PATH_VARIABLE}`,
    "if ([System.IO.Directory]::Exists($target)) {",
    "  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($target, 'OnlyErrorDialogs', 'SendToRecycleBin')",
    "} else {",
    "  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($target, 'OnlyErrorDialogs', 'SendToRecycleBin')",
    "}",
  ].join("\n");
  try {
    const result = await context.runCommand(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { [WINDOWS_TRASH_PATH_VARIABLE]: absolutePath },
    );
    if (result.exitCode === 0) return { ok: true };
    return {
      ok: false,
      reason: `PowerShell could not move '${absolutePath}' to the Recycle Bin (exit code ${result.exitCode}): ${
        result.stderr.trim() || "no error output"
      }`,
    };
  } catch (error) {
    return {
      ok: false,
      reason: `PowerShell could not move '${absolutePath}' to the Recycle Bin: ${commandFailure(
        error,
        "unknown error",
      )}`,
    };
  }
}

/** Moves an existing entry to the platform trash, or reports why it stayed in place. */
export async function moveToSystemTrash(
  absolutePath: string,
  context: TrashContextValue,
): Promise<TrashMoveResult> {
  if (context.platform === "linux") return moveToLinuxTrash(absolutePath, context);
  if (context.platform === "win32") return moveToWindowsRecycleBin(absolutePath, context);
  return {
    ok: false,
    reason: `no system trash is available on platform '${context.platform}'`,
  };
}
