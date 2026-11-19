import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { buildRemoteNodeEnvScript } from "@houston-app/ssh/tunnel";
import { satisfiesSemverRange } from "@houston-app/shared/semver";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopManagedPolicy from "../app/DesktopManagedPolicy.ts";
import { parseWslDistroList, type WslDistro } from "./wslPathParsing.ts";

const PROCESS_TERMINATE_GRACE = Duration.seconds(1);
const LIST_TIMEOUT = Duration.seconds(8);
// Booting a stopped distro needs more time than converting paths in a running one.
const PRE_WARM_TIMEOUT = Duration.seconds(30);
const WSLPATH_TIMEOUT = Duration.seconds(10);
const PROBE_TIMEOUT = Duration.seconds(10);
const TOOLCHAIN_TIMEOUT = Duration.seconds(10);
const BUILD_TIMEOUT = Duration.minutes(5);
const USER_HOME_TIMEOUT = Duration.seconds(5);
const RUNTIME_RECORD_TIMEOUT = Duration.seconds(5);
const PROCESS_PROBE_TIMEOUT = Duration.seconds(5);
// A runtime record is a few hundred bytes; this bound rejects a runaway file without reading it.
const MAX_SERVER_RUNTIME_RECORD_BYTES = 64 * 1024;
const TOOLCHAIN_TRANSPORT_RETRY_LIMIT = 12;
const BUILD_TRANSPORT_RETRY_LIMIT = 2;

export interface EnsureWslNodePtyOptions {
  readonly allowBuild?: boolean;
  readonly nodeEngineRange?: string | null;
}

export type EnsureWslNodePtyResult =
  | {
      readonly ok: true;
      readonly nodePath: string;
      readonly resolvedPath: string;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly fatal: boolean;
      readonly retryLimit?: number;
    };

export type WslUserHomeResult =
  | {
      readonly ok: true;
      readonly home: string;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      // A timed-out or failed probe may succeed on retry; an unusable home will not.
      readonly transient: boolean;
    };

export type WslRuntimeRecordReadResult =
  | {
      readonly _tag: "Record";
      readonly contents: string;
    }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Unreadable"; readonly reason: string };

export class DesktopWslDistroListError extends Schema.TaggedError<DesktopWslDistroListError>()(
  "DesktopWslDistroListError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

const isDesktopWslDistroListError = Schema.is(DesktopWslDistroListError);

export class DesktopWslEnvironment extends Context.Service<
  DesktopWslEnvironment,
  {
    readonly isAvailable: Effect.Effect<boolean>;
    // UX-only best effort; health checks need probeDistros to distinguish failures from an empty installation.
    readonly listDistros: Effect.Effect<readonly WslDistro[]>;
    readonly probeDistros: Effect.Effect<readonly WslDistro[], DesktopWslDistroListError>;
    readonly preWarm: (distro: string | null) => Effect.Effect<void>;
    readonly windowsToWslPath: (
      distro: string | null,
      windowsPath: string,
    ) => Effect.Effect<Option.Option<string>>;
    readonly getUserHome: (distro: string | null) => Effect.Effect<WslUserHomeResult>;
    // The server runtime record lives in the distro, so a desktop process probe cannot see its PID.
    readonly readServerRuntimeRecord: (
      distro: string | null,
      recordPath: string,
    ) => Effect.Effect<WslRuntimeRecordReadResult>;
    readonly isProcessAlive: (distro: string | null, pid: number) => Effect.Effect<boolean>;
    // Use the distro IP to avoid unreliable wslhost localhost forwarding.
    readonly getDistroIp: (distro: string | null) => Effect.Effect<Option.Option<string>>;
    readonly ensureNodePty: (
      distro: string | null,
      linuxAppRoot: string,
      options?: EnsureWslNodePtyOptions,
    ) => Effect.Effect<EnsureWslNodePtyResult>;
  }
>()("@houston-app/desktop/wsl/DesktopWslEnvironment") {}

const buildDistroArgs = (distro: string | null): ReadonlyArray<string> =>
  distro ? ["-d", distro] : [];

const concatChunks = (arrays: ReadonlyArray<Uint8Array>): Uint8Array => {
  let totalLength = 0;
  for (const arr of arrays) totalLength += arr.byteLength;
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.byteLength;
  }
  return out;
};

const decodeUtf8 = (bytes: Uint8Array): string => new TextDecoder("utf-8").decode(bytes);

interface ShellResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly transportFailure: "timeout" | "spawn" | "process" | null;
}

const TIMEOUT_RESULT: ShellResult = {
  exitCode: 124,
  stdout: "",
  stderr: "\n[timeout]",
  transportFailure: "timeout",
};

const formatWslShellTransportFailureReason = (
  failure: ShellResult["transportFailure"],
  subject = "Node.js",
): string | null => {
  switch (failure) {
    case "timeout":
      return `WSL backend preflight timed out while probing for ${subject}. WSL may be slow to start; retry, or check that the distro is healthy.`;
    case "spawn":
      return `WSL backend preflight could not start wsl.exe to probe for ${subject}. Check that WSL is installed and the distro is accessible.`;
    case "process":
      return `WSL backend preflight lost communication with wsl.exe while probing for ${subject}. Retry, or check that the distro is healthy.`;
    case null:
      return null;
  }
};

const buildWslNodeEnvPreamble = (
  nodeEngineRange?: string | null,
): string => `${buildRemoteNodeEnvScript({ nodeEngineRange: nodeEngineRange ?? null })}
ensure_remote_node_path || true
`;

// wsl.exe re-escaping mangles quotes inside bash -lc scripts.
const runWslShell = (
  distro: string | null,
  bashScript: string,
  timeout: Duration.Duration,
  options: {
    readonly nodeEngineRange?: string | null;
    readonly resolveNode?: boolean;
  } = {},
): Effect.Effect<ShellResult, never, ChildProcessSpawner.ChildProcessSpawner> => {
  const spawner = ChildProcessSpawner.ChildProcessSpawner;
  const resolveNode = options.resolveNode !== false;
  const command = ChildProcess.make(
    "wsl.exe",
    resolveNode
      ? [...buildDistroArgs(distro), "--", "bash", "-l", "-s"]
      : [...buildDistroArgs(distro), "--exec", "sh", "-s"],
    {
      stdin: Stream.encodeText(
        Stream.make(
          resolveNode
            ? `${buildWslNodeEnvPreamble(options.nodeEngineRange)}${bashScript}`
            : bashScript,
        ),
      ),
      stdout: "pipe",
      stderr: "pipe",
      killSignal: "SIGTERM",
      forceKillAfter: PROCESS_TERMINATE_GRACE,
    },
  );

  return Effect.scoped(
    Effect.gen(function* () {
      const spawnerService = yield* spawner;
      const spawnResult = yield* spawnerService.spawn(command).pipe(
        Effect.match({
          onFailure: (error) => ({ _tag: "Failure", error }) as const,
          onSuccess: (handle) => ({ _tag: "Success", handle }) as const,
        }),
      );
      if (spawnResult._tag === "Failure") {
        return {
          exitCode: 127,
          stdout: "",
          stderr: `\n${spawnResult.error.message}`,
          transportFailure: "spawn",
        } satisfies ShellResult;
      }
      const handle = spawnResult.handle;
      // Drain both pipes concurrently to prevent node-gyp output from blocking the child.
      const [stdoutBytes, stderrBytes, exitCode] = yield* Effect.all(
        [Stream.runCollect(handle.stdout), Stream.runCollect(handle.stderr), handle.exitCode],
        { concurrency: "unbounded" },
      );
      return {
        exitCode: exitCode as unknown as number,
        stdout: decodeUtf8(concatChunks(stdoutBytes)),
        stderr: decodeUtf8(concatChunks(stderrBytes)),
        transportFailure: null,
      } satisfies ShellResult;
    }),
  ).pipe(
    Effect.timeoutOption(timeout),
    Effect.map(Option.getOrElse((): ShellResult => TIMEOUT_RESULT)),
    Effect.catch((error) =>
      Effect.succeed<ShellResult>({
        exitCode: 127,
        stdout: "",
        stderr: `\n${error.message}`,
        transportFailure: "process",
      }),
    ),
  );
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

// The WSL backend's state lives below the distro user's home, so a home that is
// not a plain absolute Linux path cannot name a usable directory.
export const parseWslUserHome = (raw: string): WslUserHomeResult => {
  if (raw.length === 0) {
    return { ok: false, reason: "the distro did not report a home directory", transient: false };
  }
  if (raw.includes("\0") || raw.includes("\n") || raw.includes("\r")) {
    return {
      ok: false,
      reason: `the distro home directory contains a control character: ${JSON.stringify(raw)}`,
      transient: false,
    };
  }
  if (!raw.startsWith("/")) {
    return {
      ok: false,
      reason: `the distro home directory is not an absolute Linux path: ${JSON.stringify(raw)}`,
      transient: false,
    };
  }
  return { ok: true, home: raw };
};

const WSL_RUNTIME_RECORD_MARKER = "houstonRecord:";

export const buildWslReadServerRuntimeRecordScript = (recordPath: string): string =>
  [
    `record=${shellQuote(recordPath)}`,
    'if [ ! -e "$record" ]; then printf "houstonRecord:missing\\n"; exit 0; fi',
    'if [ ! -f "$record" ] || [ ! -r "$record" ]; then printf "houstonRecord:unreadable\\n"; exit 0; fi',
    'size=$(wc -c < "$record" 2>/dev/null | tr -d "[:space:]") || size=""',
    'case "$size" in ""|*[!0-9]*) printf "houstonRecord:unreadable\\n"; exit 0 ;; esac',
    `if [ "$size" -gt ${MAX_SERVER_RUNTIME_RECORD_BYTES} ]; then printf "houstonRecord:too-large:%s\\n" "$size"; exit 0; fi`,
    'printf "houstonRecord:contents\\n"',
    'cat "$record"',
  ].join("\n");

export const parseWslServerRuntimeRecordRead = (stdout: string): WslRuntimeRecordReadResult => {
  const newline = stdout.indexOf("\n");
  const header = (newline === -1 ? stdout : stdout.slice(0, newline)).replace(/\r$/, "");
  if (header === `${WSL_RUNTIME_RECORD_MARKER}missing`) {
    return { _tag: "Missing" };
  }
  if (header === `${WSL_RUNTIME_RECORD_MARKER}contents`) {
    return { _tag: "Record", contents: newline === -1 ? "" : stdout.slice(newline + 1) };
  }
  if (header.startsWith(`${WSL_RUNTIME_RECORD_MARKER}too-large:`)) {
    return {
      _tag: "Unreadable",
      reason: `the runtime record is larger than ${String(MAX_SERVER_RUNTIME_RECORD_BYTES)} bytes (${header.slice(`${WSL_RUNTIME_RECORD_MARKER}too-large:`.length)})`,
    };
  }
  if (header === `${WSL_RUNTIME_RECORD_MARKER}unreadable`) {
    return { _tag: "Unreadable", reason: "the runtime record could not be read" };
  }
  return { _tag: "Unreadable", reason: "reading the runtime record returned an unexpected result" };
};

export const buildWslProcessProbeScript = (pid: number): string =>
  [
    `if kill -0 ${String(pid)} 2>/dev/null; then printf "houstonProcess:alive\\n"; else printf "houstonProcess:dead\\n"; fi`,
  ].join("\n");

const readServerRuntimeRecordImpl = (
  distro: string | null,
  recordPath: string,
): Effect.Effect<WslRuntimeRecordReadResult, never, ChildProcessSpawner.ChildProcessSpawner> =>
  runWslShell(distro, buildWslReadServerRuntimeRecordScript(recordPath), RUNTIME_RECORD_TIMEOUT, {
    resolveNode: false,
  }).pipe(
    Effect.map((result) => {
      const transportFailure = formatWslShellTransportFailureReason(
        result.transportFailure,
        "the server runtime record",
      );
      if (transportFailure !== null) {
        return { _tag: "Unreadable", reason: transportFailure } as const;
      }
      if (result.exitCode !== 0) {
        return {
          _tag: "Unreadable",
          reason: `reading the runtime record exited with code ${result.exitCode}`,
        } as const;
      }
      return parseWslServerRuntimeRecordRead(result.stdout);
    }),
  );

const isProcessAliveImpl = (
  distro: string | null,
  pid: number,
): Effect.Effect<boolean, never, ChildProcessSpawner.ChildProcessSpawner> => {
  if (!Number.isInteger(pid) || pid <= 0) return Effect.succeed(false);
  return runWslShell(distro, buildWslProcessProbeScript(pid), PROCESS_PROBE_TIMEOUT, {
    resolveNode: false,
  }).pipe(
    Effect.map(
      (result) =>
        result.transportFailure === null &&
        result.exitCode === 0 &&
        result.stdout.includes("houstonProcess:alive"),
    ),
  );
};

const NODE_PTY_BINARY_MISSING_EXIT_CODE = 4;

const formatNodePtyProbeFailureReason = (exitCode: number): string | null =>
  exitCode === NODE_PTY_BINARY_MISSING_EXIT_CODE
    ? "WSL support is missing from this Houston build: the packaged Linux node-pty binary was not included. Install a build that includes WSL support."
    : null;

// Capture login-shell PATH because the server launches provider CLIs by name.
const RESOLVED_PATH_LINE = `printf 'resolvedPath:%s\\n' "$PATH"`;

const NODE_PTY_PROBE_SCRIPT = (
  linuxServerDir: string,
) => `printf 'nodePath:%s\\n' "$(command -v node 2>/dev/null)"
printf 'nodeVersion:%s\\n' "$(node -p 'process.versions.node' 2>/dev/null)"
${RESOLVED_PATH_LINE}
cd ${shellQuote(linuxServerDir)} && node <<'NODE' >/dev/null 2>&1
// The WSL Node can't read inside app.asar, so confirm what the server needs is
// unpacked on the real filesystem before reporting the backend healthy. Exit 3
// marks this distinct from a node-pty binary problem so the caller can report
// it accurately instead of letting the server crash on ERR_MODULE_NOT_FOUND at
// launch (which, in wsl-only mode, would just fail to launch with no fallback).
//
// The sentinel must be a package the CLI bundle leaves external. The bundle
// inlines its JS dependencies, so only the native packages exist on disk.
// Resolving node-pty is what actually validates the unpacked tree.
try { require.resolve("node-pty/package.json"); } catch (_e) { process.exit(3); }
const fs = require("node:fs");
const path = require("node:path");
const pkgDir = path.dirname(require.resolve("node-pty/package.json"));
// node-pty 1.x is N-API based, so a single Linux pty.node is ABI-stable across
// Node versions, so require() succeeding IS the real compatibility test. Look in
// the same places node-pty's own loader does.
const candidates = [
  path.join(pkgDir, "build", "Release", "pty.node"),
  path.join(pkgDir, "prebuilds", "linux-" + process.arch, "pty.node"),
];
if (!candidates.some((candidate) => fs.existsSync(candidate))) process.exit(${NODE_PTY_BINARY_MISSING_EXIT_CODE});
require("node-pty");
NODE`;

const TOOLCHAIN_CHECK_SCRIPT = [
  "for tool in node make g++ python3; do",
  '  command -v "$tool" >/dev/null 2>&1 || echo "missing:$tool"',
  "done",
  "if command -v node >/dev/null 2>&1; then",
  `  ver="$(node -p 'process.versions.node' 2>/dev/null)"`,
  '  if [ -n "$ver" ]; then printf "nodeVersion:%s\\n" "$ver"; fi',
  "fi",
].join("\n");

const NODE_PTY_BUILD_SCRIPT = (linuxServerDir: string) =>
  [
    "set -e",
    `cd ${shellQuote(linuxServerDir)}`,
    `pkg_dir=$(node -p "require('node:path').dirname(require.resolve('node-pty/package.json'))")`,
    `cd "$pkg_dir"`,
    "npx --yes node-gyp rebuild",
    `node -e 'require("node-pty")'`,
  ].join("\n");

export interface ToolchainReport {
  readonly missingTools: ReadonlyArray<string>;
  readonly nodeVersion: string | null;
}

const parseToolchainReport = (stdout: string): ToolchainReport => {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const missingTools = lines
    .filter((line) => line.startsWith("missing:"))
    .map((line) => line.slice("missing:".length));
  const nodeVersionLine = lines.find((line) => line.startsWith("nodeVersion:"));
  const nodeVersion = nodeVersionLine
    ? nodeVersionLine.slice("nodeVersion:".length).trim() || null
    : null;
  return { missingTools, nodeVersion };
};

const parseNodePath = (stdout: string): string | null => {
  const path = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("nodePath:"))
    .map((line) => line.slice("nodePath:".length).trim())
    .find((value) => value.length > 0);
  return path ?? null;
};

const parseNodeVersion = (stdout: string): string | null => {
  const version = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("nodeVersion:"))
    .map((line) => line.slice("nodeVersion:".length).trim())
    .find((value) => value.length > 0);
  return version ?? null;
};

// Strip only Windows CR; spaces and apostrophes must survive as one env argument.
export const parseResolvedPath = (stdout: string): string | null => {
  const prefix = "resolvedPath:";
  const line = stdout.split("\n").find((candidate) => candidate.startsWith(prefix));
  if (line === undefined) return null;
  const resolvedPath = line.slice(prefix.length).replace(/\r$/, "");
  return resolvedPath.length > 0 ? resolvedPath : null;
};

const formatMissingToolsReason = (
  report: ToolchainReport,
  requiredRange: string | null,
): string | null => {
  const nodeMissing = report.missingTools.includes("node");
  const nodeOutOfRange =
    !nodeMissing &&
    requiredRange !== null &&
    report.nodeVersion !== null &&
    !satisfiesSemverRange(report.nodeVersion, requiredRange);
  const buildToolsMissing = report.missingTools.filter((tool) => tool !== "node");

  if (!nodeMissing && !nodeOutOfRange && buildToolsMissing.length === 0) {
    return null;
  }

  const issues: string[] = [];
  const remediations: string[] = [];

  if (nodeMissing) {
    issues.push("node");
    remediations.push(
      `Node.js${requiredRange ? ` satisfying \`${requiredRange}\`` : " 18+"} (e.g. via nvm)`,
    );
  } else if (nodeOutOfRange) {
    issues.push(`node ${report.nodeVersion} (requires ${requiredRange})`);
    remediations.push(
      `a newer Node.js satisfying \`${requiredRange}\` (e.g. \`nvm install 24 && nvm alias default 24\`)`,
    );
  }

  if (buildToolsMissing.length > 0) {
    issues.push(...buildToolsMissing);
    remediations.push(
      "the build toolchain (e.g. `sudo apt install -y build-essential python3` on Ubuntu/Debian)",
    );
  }

  return `WSL distro is missing required tools: ${issues.join(", ")}. Install ${remediations.join(" and ")}, then retry.`;
};

const ensureNodePtyImpl = Effect.fn("DesktopWslEnvironment.ensureNodePtyImpl")(function* (
  distro: string | null,
  linuxRepoRoot: string,
  options: EnsureWslNodePtyOptions = {},
): Effect.fn.Return<EnsureWslNodePtyResult, never, ChildProcessSpawner.ChildProcessSpawner> {
  // node-pty lives in the apps/server workspace's node_modules; resolve from
  // there rather than the monorepo root, where Bun's hoist layout omits it.
  const linuxServerDir = `${linuxRepoRoot}/apps/server`;

  const probe = yield* runWslShell(
    distro,
    NODE_PTY_PROBE_SCRIPT(linuxServerDir),
    PROBE_TIMEOUT,
    options,
  );
  const nodePath = parseNodePath(probe.stdout);
  const resolvedPath = parseResolvedPath(probe.stdout);

  const transportFailureReason = formatWslShellTransportFailureReason(probe.transportFailure);
  if (transportFailureReason !== null) {
    return {
      ok: false,
      reason: transportFailureReason,
      fatal: false,
    } as const;
  }

  if (nodePath === null) {
    const toolchainCheck = yield* runWslShell(
      distro,
      TOOLCHAIN_CHECK_SCRIPT,
      TOOLCHAIN_TIMEOUT,
      options,
    );
    const toolchainTransportFailure = formatWslShellTransportFailureReason(
      toolchainCheck.transportFailure,
    );
    if (toolchainTransportFailure !== null) {
      return {
        ok: false,
        reason: toolchainTransportFailure,
        fatal: false,
        retryLimit: TOOLCHAIN_TRANSPORT_RETRY_LIMIT,
      } as const;
    }
    const report = parseToolchainReport(toolchainCheck.stdout);
    const reason =
      formatMissingToolsReason(report, options.nodeEngineRange?.trim() || null) ??
      "Node.js was not found in the WSL distro. Install it (e.g. via nvm) and restart the desktop app.";
    return { ok: false, reason, fatal: true } as const;
  }

  if (resolvedPath === null) {
    return {
      ok: false,
      reason: "WSL login-shell PATH could not be resolved during backend preflight.",
      fatal: true,
    } as const;
  }

  if (probe.exitCode === 3) {
    return {
      ok: false,
      reason:
        'WSL server dependencies could not be loaded (for example "node-pty"). The native packages the server needs are not unpacked where the WSL distro\'s Node can read them. This is a packaging problem with this build. Please report it.',
      fatal: true,
    } as const;
  }

  if (probe.exitCode === 0) {
    const rawVersion = parseNodeVersion(probe.stdout);
    if (
      rawVersion !== null &&
      options.nodeEngineRange &&
      !satisfiesSemverRange(rawVersion, options.nodeEngineRange.trim())
    ) {
      const range = options.nodeEngineRange.trim();
      return {
        ok: false,
        reason: `WSL Node.js ${rawVersion} does not satisfy the server's required engine range (${range}). Install a compatible version, and restart the desktop app.`,
        fatal: true,
      } as const;
    }
    return { ok: true, nodePath, resolvedPath } as const;
  }

  if (options.allowBuild !== true) {
    const packagedProbeFailure = formatNodePtyProbeFailureReason(probe.exitCode);
    if (packagedProbeFailure !== null) {
      return {
        ok: false,
        reason: packagedProbeFailure,
        fatal: true,
      } as const;
    }
  }

  const toolchainCheck = yield* runWslShell(
    distro,
    TOOLCHAIN_CHECK_SCRIPT,
    TOOLCHAIN_TIMEOUT,
    options,
  );
  const toolchainTransportFailure = formatWslShellTransportFailureReason(
    toolchainCheck.transportFailure,
  );
  if (toolchainTransportFailure !== null) {
    return {
      ok: false,
      reason: toolchainTransportFailure,
      fatal: false,
      retryLimit: TOOLCHAIN_TRANSPORT_RETRY_LIMIT,
    } as const;
  }
  const report = parseToolchainReport(toolchainCheck.stdout);

  if (options.allowBuild !== true) {
    // Packaged builds ship a prebuilt Linux node-pty, so no compiler, node-gyp,
    // or network is needed — and we must not nag the user to install build
    // tools they don't need.
    const nodeOnlyReason = formatMissingToolsReason(
      {
        missingTools: report.missingTools.filter((tool) => tool === "node"),
        nodeVersion: report.nodeVersion,
      },
      options.nodeEngineRange?.trim() || null,
    );
    return {
      ok: false,
      reason:
        nodeOnlyReason ??
        "The bundled WSL backend binary (node-pty) could not be loaded in this distro. This usually means an unsupported CPU architecture or incompatible system libraries (glibc). Use a glibc-based x64/arm64 WSL distro such as Ubuntu; if you already are, please report this with your distro and the output of `uname -m`.",
      fatal: true,
    } as const;
  }

  const missingReason = formatMissingToolsReason(report, options.nodeEngineRange?.trim() || null);
  if (missingReason !== null) {
    return { ok: false, reason: missingReason, fatal: true } as const;
  }

  const build = yield* runWslShell(
    distro,
    NODE_PTY_BUILD_SCRIPT(linuxServerDir),
    BUILD_TIMEOUT,
    options,
  );
  const buildTransportFailure = formatWslShellTransportFailureReason(build.transportFailure);
  if (buildTransportFailure !== null) {
    return {
      ok: false,
      reason: buildTransportFailure,
      fatal: false,
      retryLimit: BUILD_TRANSPORT_RETRY_LIMIT,
    } as const;
  }
  if (build.exitCode === 0) return { ok: true, nodePath, resolvedPath } as const;
  const trimmedTail = `${build.stdout}${build.stderr}`.trim().slice(-500);
  return {
    ok: false,
    reason: `node-pty Linux build failed (exit ${build.exitCode}): ${trimmedTail || "no stderr captured"}`,
    fatal: true,
  } as const;
});

const probeWslDistros: Effect.Effect<
  readonly WslDistro[],
  DesktopWslDistroListError,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.scoped(
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command = ChildProcess.make("wsl.exe", ["--list", "--verbose"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      // Match the host's distro enumeration: one encoding regardless of the Windows locale.
      env: { WSL_UTF8: "1" },
      extendEnv: true,
      killSignal: "SIGTERM",
      forceKillAfter: PROCESS_TERMINATE_GRACE,
    });
    const handle = yield* spawner.spawn(command);
    const stdoutBytes = yield* Stream.runCollect(handle.stdout);
    const exitCode = yield* handle.exitCode;
    if ((exitCode as unknown as number) !== 0) {
      return yield* new DesktopWslDistroListError({
        reason: `wsl.exe --list --verbose exited with code ${String(exitCode)}`,
      });
    }
    return parseWslDistroList(Buffer.from(concatChunks(stdoutBytes)));
  }),
).pipe(
  Effect.mapError((error) =>
    isDesktopWslDistroListError(error)
      ? error
      : new DesktopWslDistroListError({
          reason: `Failed to run wsl.exe --list --verbose: ${error.message}`,
        }),
  ),
  Effect.timeoutOption(LIST_TIMEOUT),
  Effect.flatMap(
    Option.match({
      onNone: () =>
        new DesktopWslDistroListError({
          reason: "wsl.exe --list --verbose timed out",
        }),
      onSome: Effect.succeed,
    }),
  ),
);

const preWarmImpl = (
  distro: string | null,
): Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const command = ChildProcess.make("wsl.exe", [...buildDistroArgs(distro), "--", "true"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        killSignal: "SIGTERM",
        forceKillAfter: PROCESS_TERMINATE_GRACE,
      });
      const handle = yield* spawner.spawn(command);
      yield* handle.exitCode;
    }),
  ).pipe(Effect.timeoutOption(PRE_WARM_TIMEOUT), Effect.ignore);

const windowsToWslPathImpl = (
  distro: string | null,
  windowsPath: string,
): Effect.Effect<Option.Option<string>, never, ChildProcessSpawner.ChildProcessSpawner> => {
  // wsl.exe interprets backslashes as escape chars; normalize to forward slashes.
  const normalized = windowsPath.replaceAll("\\", "/");
  return Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const command = ChildProcess.make(
        "wsl.exe",
        [...buildDistroArgs(distro), "--", "wslpath", "-u", normalized],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
          killSignal: "SIGTERM",
          forceKillAfter: PROCESS_TERMINATE_GRACE,
        },
      );
      const handle = yield* spawner.spawn(command);
      const stdoutBytes = yield* Stream.runCollect(handle.stdout);
      const exitCode = yield* handle.exitCode;
      if ((exitCode as unknown as number) !== 0) return Option.none<string>();
      const converted = decodeUtf8(concatChunks(stdoutBytes)).trim();
      return converted.length > 0 ? Option.some(converted) : Option.none<string>();
    }),
  ).pipe(
    Effect.timeoutOption(WSLPATH_TIMEOUT),
    Effect.map(Option.flatten),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
};

const IPV4_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

const getDistroIpImpl = (
  distro: string | null,
): Effect.Effect<Option.Option<string>, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      // WSL2's first hostname -I address is reachable directly from Windows without wslhost forwarding.
      const command = ChildProcess.make(
        "wsl.exe",
        [...buildDistroArgs(distro), "--", "sh", "-c", "hostname -I"],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
          killSignal: "SIGTERM",
          forceKillAfter: PROCESS_TERMINATE_GRACE,
        },
      );
      const handle = yield* spawner.spawn(command);
      const stdoutBytes = yield* Stream.runCollect(handle.stdout);
      const exitCode = yield* handle.exitCode;
      if ((exitCode as unknown as number) !== 0) return Option.none<string>();
      const raw = decodeUtf8(concatChunks(stdoutBytes)).trim();
      const candidate = raw.split(/\s+/).find((part) => IPV4_PATTERN.test(part));
      return candidate ? Option.some(candidate) : Option.none<string>();
    }),
  ).pipe(
    Effect.timeoutOption(USER_HOME_TIMEOUT),
    Effect.map(Option.flatten),
    Effect.orElseSucceed(() => Option.none<string>()),
  );

const getUserHomeImpl = (
  distro: string | null,
): Effect.Effect<WslUserHomeResult, never, ChildProcessSpawner.ChildProcessSpawner> =>
  runWslShell(distro, 'printf "%s" "$HOME"', USER_HOME_TIMEOUT, { resolveNode: false }).pipe(
    Effect.map((result) => {
      if (result.transportFailure !== null) {
        return {
          ok: false,
          reason:
            result.transportFailure === "timeout"
              ? "probing the distro home directory timed out"
              : "probing the distro home directory failed",
          transient: true,
        } as const;
      }
      if (result.exitCode !== 0) {
        return {
          ok: false,
          reason: `probing the distro home directory exited with code ${result.exitCode}`,
          transient: true,
        } as const;
      }
      return parseWslUserHome(result.stdout);
    }),
  );

export const makeIsAvailable = Effect.fn("DesktopWslEnvironment.makeIsAvailable")(function* (
  platform: NodeJS.Platform,
  windir: string,
): Effect.fn.Return<
  boolean,
  never,
  FileSystem.FileSystem | Path.Path | DesktopManagedPolicy.DesktopManagedPolicy
> {
  if (platform !== "win32") return false;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const wslExePath = path.join(windir, "System32", "wsl.exe");
  if (!(yield* fileSystem.exists(wslExePath).pipe(Effect.orElseSucceed(() => false)))) {
    return false;
  }
  // A server in WSL reads Linux's policy, never this machine's, so a managed machine runs none.
  return yield* (yield* DesktopManagedPolicy.DesktopManagedPolicy).read.pipe(
    Effect.map((found) => found === undefined),
    Effect.orElseSucceed(() => false),
  );
});

export interface DesktopWslEnvironmentTestStub {
  readonly isAvailable?: boolean;
  readonly distros?: ReadonlyArray<WslDistro>;
  readonly distroListError?: DesktopWslDistroListError;
  readonly windowsToWslPath?: (distro: string | null, windowsPath: string) => Option.Option<string>;
  readonly getUserHome?: (distro: string | null) => WslUserHomeResult;
  readonly readServerRuntimeRecord?: (
    distro: string | null,
    recordPath: string,
  ) => WslRuntimeRecordReadResult;
  readonly isProcessAlive?: (distro: string | null, pid: number) => boolean;
  readonly getDistroIp?: (distro: string | null) => Option.Option<string>;
  readonly ensureNodePty?: (
    distro: string | null,
    linuxAppRoot: string,
    options?: EnsureWslNodePtyOptions,
  ) => EnsureWslNodePtyResult;
}

export const layerTest = (stub: DesktopWslEnvironmentTestStub = {}) => {
  const probeDistros: Effect.Effect<readonly WslDistro[], DesktopWslDistroListError> =
    stub.distroListError ? Effect.fail(stub.distroListError) : Effect.succeed(stub.distros ?? []);
  return Layer.succeed(
    DesktopWslEnvironment,
    DesktopWslEnvironment.of({
      isAvailable: Effect.succeed(stub.isAvailable ?? false),
      listDistros: probeDistros.pipe(Effect.orElseSucceed(() => [])),
      probeDistros,
      preWarm: Effect.fn("DesktopWslEnvironment.preWarm")(function () {
        return Effect.void;
      }),
      windowsToWslPath: Effect.fn("DesktopWslEnvironment.windowsToWslPath")(
        function (distro, windowsPath) {
          return Effect.succeed(stub.windowsToWslPath?.(distro, windowsPath) ?? Option.none());
        },
      ),
      getUserHome: Effect.fn("DesktopWslEnvironment.getUserHome")(function (distro) {
        return Effect.succeed(
          stub.getUserHome?.(distro) ?? {
            ok: false,
            reason: "getUserHome stub not configured",
            transient: false,
          },
        );
      }),
      readServerRuntimeRecord: Effect.fn("DesktopWslEnvironment.readServerRuntimeRecord")(
        function (distro, recordPath) {
          return Effect.succeed(
            stub.readServerRuntimeRecord?.(distro, recordPath) ?? { _tag: "Missing" },
          );
        },
      ),
      isProcessAlive: Effect.fn("DesktopWslEnvironment.isProcessAlive")(function (distro, pid) {
        return Effect.succeed(stub.isProcessAlive?.(distro, pid) ?? false);
      }),
      getDistroIp: Effect.fn("DesktopWslEnvironment.getDistroIp")(function (distro) {
        return Effect.succeed(stub.getDistroIp?.(distro) ?? Option.none<string>());
      }),
      ensureNodePty: Effect.fn("DesktopWslEnvironment.ensureNodePty")(
        function (distro, linuxAppRoot, options) {
          return Effect.succeed(
            stub.ensureNodePty?.(distro, linuxAppRoot, options) ?? {
              ok: false,
              reason: "ensureNodePty stub not configured",
              fatal: true,
            },
          );
        },
      ),
    }),
  );
};

export const layer = Layer.effect(
  DesktopWslEnvironment,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const windir = process.env.WINDIR ?? "C:\\Windows";

    const provideSpawner = <A, E>(
      effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
    ): Effect.Effect<A, E> =>
      effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

    // Cache availability so synchronous IPC bootstrap can read it without yielding to filesystem I/O.
    const wslAvailable = yield* makeIsAvailable(environment.platform, windir).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, environment.path),
      Effect.provideService(
        DesktopManagedPolicy.DesktopManagedPolicy,
        yield* DesktopManagedPolicy.DesktopManagedPolicy,
      ),
      Effect.withSpan("desktop.wsl.isAvailable"),
    );
    const isAvailable = Effect.succeed(wslAvailable);

    const windowsToWslPath = (distro: string | null, windowsPath: string) =>
      provideSpawner(windowsToWslPathImpl(distro, windowsPath)).pipe(
        Effect.withSpan("desktop.wsl.windowsToWslPath"),
      );

    const userHomeCache = new Map<string, string>();
    const getUserHome = Effect.fn("desktop.wsl.getUserHome")(function* (distro: string | null) {
      const key = distro ?? "__default__";
      const cached = userHomeCache.get(key);
      if (cached !== undefined) return { ok: true, home: cached } as const;
      const resolved = yield* provideSpawner(getUserHomeImpl(distro));
      if (resolved.ok) userHomeCache.set(key, resolved.home);
      return resolved;
    });

    const getDistroIp = (distro: string | null) =>
      provideSpawner(getDistroIpImpl(distro)).pipe(Effect.withSpan("desktop.wsl.getDistroIp"));

    const readServerRuntimeRecord = (distro: string | null, recordPath: string) =>
      provideSpawner(readServerRuntimeRecordImpl(distro, recordPath)).pipe(
        Effect.withSpan("desktop.wsl.readServerRuntimeRecord"),
      );

    const isProcessAlive = (distro: string | null, pid: number) =>
      provideSpawner(isProcessAliveImpl(distro, pid)).pipe(
        Effect.withSpan("desktop.wsl.isProcessAlive"),
      );

    const probeDistros = provideSpawner(probeWslDistros).pipe(
      Effect.withSpan("desktop.wsl.probeDistros"),
    );

    return DesktopWslEnvironment.of({
      isAvailable,
      listDistros: probeDistros.pipe(
        Effect.orElseSucceed(() => []),
        Effect.withSpan("desktop.wsl.listDistros"),
      ),
      probeDistros,
      preWarm: Effect.fn("desktop.wsl.preWarm")(function (distro) {
        return provideSpawner(preWarmImpl(distro));
      }),
      windowsToWslPath,
      getUserHome,
      readServerRuntimeRecord,
      isProcessAlive,
      getDistroIp,
      ensureNodePty: Effect.fn("desktop.wsl.ensureNodePty")(
        function (distro, linuxAppRoot, options) {
          return provideSpawner(ensureNodePtyImpl(distro, linuxAppRoot, options));
        },
      ),
    });
  }),
);
