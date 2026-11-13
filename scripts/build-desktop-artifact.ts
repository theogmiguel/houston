#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Packaging runs before any Effect runtime exists.
/* oxlint-disable houston/no-global-process-runtime -- Standalone packaging script has no Effect runtime. */
// Stages the Electron host, installs its production dependencies and hands the
// result to electron-builder. Output lands in `release/`, which is gitignored.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeURL from "node:url";

import rootPackageJson from "../package.json" with { type: "json" };
import desktopPackageJson from "../apps/desktop/package.json" with { type: "json" };
import serverPackageJson from "../apps/server/package.json" with { type: "json" };
import gnomeCaptureBundle from "../apps/desktop/gnome-extension/bundle.json" with { type: "json" };
import { selectCliRuntimeExternalDependencies } from "./lib/cli-external-packages.ts";
import { selectDesktopRuntimeExternalDependencies } from "./lib/desktop-external-packages.ts";
import { splitArchivePackages } from "./lib/staged-package-closure.ts";

const REPO_ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

export const DESKTOP_APP_ID = "dev.houston.desktop";
export const PRODUCT_NAME = "Houston";
export const DESKTOP_EXECUTABLE_NAME = "houston";
export const DESKTOP_CATEGORY = "DeveloperTool";
export const DESKTOP_SHORT_DESCRIPTION = "Mission control for CLI coding agents";
export const DESKTOP_LONG_DESCRIPTION =
  "Houston is a local-first mission control for CLI coding agents: a grid of real terminals running your agent CLIs in your own project directories, where an agent can spawn and drive another agent in a new pane.";
export const DESKTOP_PUBLISHER = "Théo Miguel";
export const DESKTOP_COPYRIGHT = "Copyright © 2026 Théo Miguel";
export const DESKTOP_HOMEPAGE = "https://github.com/theogmiguel/houston";
export const GITHUB_PUBLISH_CONFIG = {
  provider: "github",
  owner: "theogmiguel",
  repo: "houston",
} as const;
export const DESKTOP_ARTIFACT_NAME = "Houston-${version}-${arch}.${ext}";
export const DESKTOP_WINDOWS_ARTIFACT_NAME = "Houston-${version}-${arch}-setup.${ext}";
// Setting `depends` replaces electron-builder's defaults, so Chromium's runtime
// libraries are listed here too; libsecret backs the keychain-stored secrets.
export const LINUX_DEB_DEPENDS = [
  "libgtk-3-0t64 | libgtk-3-0",
  "libnotify4",
  "libnss3",
  "libxss1",
  "libxtst6",
  "xdg-utils",
  "libatspi2.0-0t64 | libatspi2.0-0",
  "libuuid1",
  "libsecret-1-0",
  "libasound2t64 | libasound2",
] as const;
// The bundled server is a Node script inside the app; the desktop main process
// and the server share one node_modules tree on Linux and macOS.
export const STAGE_PATCHES = [
  "@ff-labs__fff-node@0.11.0.patch",
  "node-pty@1.2.0-beta.15.patch",
] as const;
export const STAGE_PATCHED_DEPENDENCIES = {
  "@ff-labs/fff-node@0.11.0": "patches/@ff-labs__fff-node@0.11.0.patch",
  "node-pty@1.2.0-beta.15": "patches/node-pty@1.2.0-beta.15.patch",
} as const;
export const V1_CLEANUP_BINARY = "houston-v1-cleanup";
export const V1_CLEANUP_CRATE = "apps/desktop/native/houston-v1-cleanup";
export const GNOME_EXTENSION_DIR = "gnome-extension";
export const BROWSER_SECRET_DIR = "browser-secret";
export const BROWSER_SECRET_EXECUTABLE = "houston-browser-secret";
export const RESOURCE_MONITOR_DIR = "resource-monitor";
export const WINDOWS_SERVER_ASAR = "server.asar";

export type BuildPlatform = "mac" | "linux" | "win";
export type BuildArch = "arm64" | "x64";

const PLATFORM_FLAGS: Record<BuildPlatform, string> = {
  mac: "--mac",
  linux: "--linux",
  win: "--win",
};
const DEFAULT_TARGETS: Record<BuildPlatform, string> = {
  mac: "dmg",
  linux: "AppImage",
  win: "nsis",
};

/** Files no runtime path loads, on every platform and in both Windows archives. */
export const UNLOADED_FILE_GLOBS = [
  "**/*.map",
  "**/*.d.cts",
  "**/node_modules/.bin",
  "**/node_modules/.bin/**",
  "**/node_modules/**/{test,tests,__tests__,example,examples}/**",
  "**/node_modules/@cursor/sdk-*/**/*",
  "**/node_modules/@anthropic-ai/claude-agent-sdk-*/**/*",
  // The server loads the SDK with `require`, which resolves dist/cjs; esm and bundled serve
  // `import` and Bun only.
  "**/node_modules/@cursor/sdk/dist/{esm,bundled}/**/*",
  // Only zod's own `@zod/source` export condition resolves into src.
  "**/node_modules/zod/src/**/*",
  // koffi's runtime entry lives in src/koffi; vendor holds headers for a source build.
  "**/node_modules/koffi/{vendor,doc}/**/*",
  "**/node_modules/undici/docs/**/*",
] as const;

const EXTERNAL_FILE_PATTERNS = [
  ...UNLOADED_FILE_GLOBS.map((glob) => `!${glob}`),
  "!apps/desktop/resources/browser-secret/**",
  "!apps/desktop/prod-resources/browser-secret/**",
  "!apps/desktop/prod-resources/windows-server/**",
] as const;

const LINUX_FILE_EXCLUSIONS = [
  "!**/node_modules/node-pty/prebuilds/win32-*/**/*",
  "!**/node_modules/node-pty/prebuilds/darwin-*/**/*",
  "!**/node_modules/node-pty/third_party/conpty/**/*",
  // Electron links glibc; this package declares glibc in its manifest, so the installer keeps it.
  "!**/node_modules/@yuuang/ffi-rs-linux-*-musl/**/*",
] as const;

// Native packages (node-pty, objc-js) ship prebuilds for both Darwin architectures; only a
// universal app needs both. macOS 27 warns when an arm64 app holds x64-only code.
export function resolveMacFileExclusions(arch: BuildArch): ReadonlyArray<string> {
  const unusedArch = arch === "arm64" ? "x64" : "arm64";
  return [
    `!**/node_modules/**/prebuilds/darwin-${unusedArch}/**/*`,
    "!**/node_modules/node-pty/prebuilds/{win32,linux}-*/**/*",
    "!**/node_modules/node-pty/third_party/conpty/**/*",
  ];
}

/** Windows runs the server from server.asar, so app.asar drops the server and its packages. */
export function resolveWindowsAppExclusions(serverOnlyPackages: Iterable<string>): string[] {
  return [
    "!apps/server/dist/**/*",
    ...[...serverOnlyPackages].map((name) => `!node_modules/${name}/**/*`),
  ];
}

// electron-builder's `files` never reach server.asar. The WSL server loads or builds Linux
// node-pty from it, so Linux prebuilds, node-pty's sources and node-addon-api stay.
export function resolveWindowsServerExclusions(input: {
  readonly arch: BuildArch;
  readonly desktopOnlyPackages: Iterable<string>;
}): string[] {
  const unusedArch = input.arch === "arm64" ? "x64" : "arm64";
  return [
    ...UNLOADED_FILE_GLOBS,
    "**/*.pdb",
    "**/node_modules/**/prebuilds/darwin-*/**",
    `**/node_modules/**/prebuilds/win32-${unusedArch}/**`,
    ...[...input.desktopOnlyPackages].map((name) => `node_modules/${name}/**`),
  ];
}

export function isExcludedPath(path: string, globs: ReadonlyArray<string>): boolean {
  return globs.some((glob) => NodePath.posix.matchesGlob(path, glob));
}

const WINDOWS_NATIVE_ASAR_UNPACK_GLOB =
  "{**/*.node,**/*.dll,**/*.exe,**/*.so,**/*.so.*,**/*.dylib}";

export interface PackagedResourceRequirement {
  /** Path the host requests from `process.resourcesPath`. */
  readonly lookup: string;
  /** Location inside the staged app or its `resources` directory. */
  readonly source: string;
  /** `resources` entries are emitted as extraResources; `app` and `server` name the archive. */
  readonly area: "resources" | "app" | "server";
  readonly platforms?: readonly BuildPlatform[];
  readonly optional?: boolean;
}

/**
 * Every `process.resourcesPath` lookup in `apps/desktop/src`, mapped to the file
 * the package must carry. `package-type` and `app-update.yml` are emitted by
 * electron-builder, so they are verified after packaging instead.
 */
export const PACKAGED_RESOURCE_REQUIREMENTS: readonly PackagedResourceRequirement[] = [
  {
    lookup: "houston-v1-cleanup",
    source: V1_CLEANUP_BINARY,
    area: "resources",
  },
  {
    lookup: "third-party-licenses.json",
    source: "third-party-licenses.json",
    area: "resources",
  },
  {
    lookup: "icon.png",
    source: "apps/desktop/prod-resources/icon.png",
    area: "app",
  },
  {
    lookup: "tray/idle-16.png",
    source: "apps/desktop/prod-resources/tray/idle-16.png",
    area: "app",
  },
  {
    lookup: "tray/active-16.png",
    source: "apps/desktop/prod-resources/tray/active-16.png",
    area: "app",
  },
  {
    lookup: "gnome-extension/metadata.json",
    source: "gnome-extension/metadata.json",
    area: "resources",
    platforms: ["linux"],
  },
  {
    lookup: "gnome-extension/extension.js",
    source: "gnome-extension/extension.js",
    area: "resources",
    platforms: ["linux"],
  },
  {
    lookup: "browser-secret/houston-browser-secret",
    source: "browser-secret/houston-browser-secret",
    area: "resources",
    platforms: ["linux"],
    optional: true,
  },
  {
    lookup: "resource-monitor/houston-resource-monitor",
    source: "resource-monitor/houston-resource-monitor",
    area: "resources",
    platforms: ["linux"],
    optional: true,
  },
  {
    lookup: "kde-capture/houston-kde-snap-shot",
    source: "kde-capture/houston-kde-snap-shot",
    area: "resources",
    platforms: ["linux"],
    optional: true,
  },
  {
    lookup: "hyprland-capture/houston-hyprland-snap-shot",
    source: "hyprland-capture/houston-hyprland-snap-shot",
    area: "resources",
    platforms: ["linux"],
    optional: true,
  },
  {
    lookup: "apps/desktop/prod-resources/icon.png",
    source: "apps/desktop/prod-resources/icon.png",
    area: "app",
  },
  {
    lookup: "apps/server/dist/bin.mjs",
    source: "apps/server/dist/bin.mjs",
    area: "app",
    platforms: ["linux", "mac"],
  },
  {
    lookup: "apps/server/dist/client/index.html",
    source: "apps/server/dist/client/index.html",
    area: "app",
    platforms: ["linux", "mac"],
  },
  {
    lookup: "server.asar/apps/server/dist/bin.mjs",
    source: "apps/server/dist/bin.mjs",
    area: "server",
    platforms: ["win"],
  },
  {
    lookup: "server.asar/apps/server/dist/client/index.html",
    source: "apps/server/dist/client/index.html",
    area: "server",
    platforms: ["win"],
  },
  {
    lookup: "server.asar/node_modules/node-pty/package.json",
    source: "node_modules/node-pty/package.json",
    area: "server",
    platforms: ["win"],
  },
  {
    lookup: "apps/desktop/dist-electron/main.cjs",
    source: "apps/desktop/dist-electron/main.cjs",
    area: "app",
  },
] as const;

export function resolveProductName(): string {
  return PRODUCT_NAME;
}

export function resolveDesktopBuildArch(arch: string): BuildArch {
  if (arch === "arm64" || arch === "x64") return arch;
  throw new Error(`Unsupported desktop build architecture: ${JSON.stringify(arch)}`);
}

export function resolveDesktopBuildPlatform(platform: string): BuildPlatform {
  if (platform === "mac" || platform === "linux" || platform === "win") return platform;
  throw new Error(
    `Unsupported desktop build platform: ${JSON.stringify(platform)}; expected mac, linux or win.`,
  );
}

export function resolveDesktopBuildTarget(platform: BuildPlatform, target: string): string {
  const supported: Record<BuildPlatform, readonly string[]> = {
    mac: ["dmg"],
    linux: ["AppImage", "deb"],
    win: ["nsis"],
  };
  if (!supported[platform].includes(target)) {
    throw new Error(
      `Unsupported target ${JSON.stringify(target)} for ${platform}; expected ${supported[platform].join(", ")}.`,
    );
  }
  return target;
}

export function resolveDesktopTargets(platform: BuildPlatform, target: string): string[] {
  if (platform === "linux" && target === "AppImage") {
    return ["AppImage", "deb"];
  }
  return [target];
}

export interface StageDependencyInput {
  readonly platform: BuildPlatform;
  readonly arch: BuildArch;
  readonly serverDependencies: Readonly<Record<string, string>>;
  readonly desktopDependencies: Readonly<Record<string, string>>;
  readonly fffVersion: string;
}

/** The packages each bundle loads from disk; Windows splits the archives along these roots. */
export function resolveStageDependencyRoots(input: StageDependencyInput): {
  readonly server: Record<string, string>;
  readonly desktop: Record<string, string>;
} {
  // Electron's Linux build links glibc, so the server never runs on a musl libc.
  const fffNative =
    input.platform === "win"
      ? `@ff-labs/fff-bin-win32-${input.arch}`
      : input.platform === "mac"
        ? `@ff-labs/fff-bin-darwin-${input.arch}`
        : `@ff-labs/fff-bin-linux-${input.arch}-gnu`;
  return {
    server: {
      ...selectCliRuntimeExternalDependencies(input.serverDependencies),
      [fffNative]: input.fffVersion,
    },
    desktop: selectDesktopRuntimeExternalDependencies(input.desktopDependencies),
  };
}

export function resolveStageDependencies(input: StageDependencyInput): Record<string, string> {
  const roots = resolveStageDependencyRoots(input);
  return { ...roots.server, ...roots.desktop };
}

export function createStageWorkspaceConfig(input: {
  readonly platform: BuildPlatform;
  readonly arch: BuildArch;
}): Record<string, unknown> {
  const hostOs = input.platform === "mac" ? "darwin" : input.platform === "win" ? "win32" : "linux";
  return {
    nodeLinker: "hoisted",
    supportedArchitectures:
      input.platform === "linux"
        ? { os: [hostOs], cpu: [input.arch], libc: ["glibc"] }
        : { os: [hostOs], cpu: [input.arch] },
    allowBuilds: { koffi: true, "node-pty": true },
    patchedDependencies: STAGE_PATCHED_DEPENDENCIES,
  };
}

export function createBuildConfig(input: {
  readonly platform: BuildPlatform;
  readonly target: string;
  readonly arch: BuildArch;
  readonly version: string;
  readonly outputDir: string;
  readonly repoRoot: string;
  readonly stageAppDir: string;
  /** Packages only the server reaches; known once the stage is installed. */
  readonly serverOnlyPackages?: ReadonlyArray<string>;
}): Record<string, unknown> {
  const buildConfig: Record<string, unknown> = {
    appId: DESKTOP_APP_ID,
    productName: resolveProductName(),
    artifactName: DESKTOP_ARTIFACT_NAME,
    copyright: DESKTOP_COPYRIGHT,
    electronLanguages: ["en-US"],
    npmRebuild: false,
    publish: [GITHUB_PUBLISH_CONFIG],
    directories: {
      buildResources: "apps/desktop/resources",
      output: input.outputDir,
    },
    files: [
      ...EXTERNAL_FILE_PATTERNS,
      ...(input.platform === "linux" ? LINUX_FILE_EXCLUSIONS : []),
      ...(input.platform === "mac" ? resolveMacFileExclusions(input.arch) : []),
      ...(input.platform === "win"
        ? resolveWindowsAppExclusions(input.serverOnlyPackages ?? [])
        : []),
    ],
    extraResources: resolveExtraResources(input.platform, (path) =>
      NodeFS.existsSync(NodePath.join(input.stageAppDir, path)),
    ),
  };

  if (input.platform === "linux") {
    // The bundled server is a Node script that resolves its dependencies from
    // the app directory; a plain app directory keeps that tree inspectable.
    buildConfig.asar = false;
    buildConfig.linux = {
      target: resolveDesktopTargets(input.platform, input.target),
      executableName: DESKTOP_EXECUTABLE_NAME,
      icon: "icons",
      category: "Development",
      synopsis: DESKTOP_SHORT_DESCRIPTION,
      description: DESKTOP_LONG_DESCRIPTION,
      maintainer: DESKTOP_PUBLISHER,
      desktop: { entry: { StartupWMClass: DESKTOP_EXECUTABLE_NAME } },
    };
    buildConfig.deb = {
      depends: [...LINUX_DEB_DEPENDS],
      fpm: [
        `${NodePath.join(input.repoRoot, "apps/desktop/resources/linux/dev.houston.desktop.metainfo.xml")}=/usr/share/metainfo/dev.houston.desktop.metainfo.xml`,
        `${NodePath.join(input.repoRoot, "LICENSE")}=/usr/share/doc/houston/copyright`,
      ],
    };
  }

  if (input.platform === "mac") {
    buildConfig.asar = false;
    buildConfig.mac = {
      target: [input.target],
      icon: "icon.png",
      category: "public.app-category.developer-tools",
    };
  }

  if (input.platform === "win") {
    buildConfig.asar = { smartUnpack: false };
    buildConfig.asarUnpack = [WINDOWS_NATIVE_ASAR_UNPACK_GLOB];
    buildConfig.win = {
      target: [input.target],
      icon: "icon.ico",
      signAndEditExecutable: true,
    };
    buildConfig.nsis = {
      oneClick: true,
      perMachine: false,
      // Authenticode signing rewrites the installer after packaging, which
      // invalidates a differential block map; updates stay full downloads.
      differentialPackage: false,
      include: "apps/desktop/resources/installer.nsh",
      shortcutName: PRODUCT_NAME,
      artifactName: DESKTOP_WINDOWS_ARTIFACT_NAME,
    };
  }

  return buildConfig;
}

export function resolveExtraResources(
  platform: BuildPlatform,
  exists: (path: string) => boolean = (path) => NodeFS.existsSync(NodePath.join(REPO_ROOT, path)),
): Array<Record<string, unknown>> {
  // The app carries `prod-resources` for lookups made relative to app.getAppPath().
  // Extra resources are the host helpers it reads straight from process.resourcesPath.
  const resources: Array<Record<string, unknown>> = [
    { from: "apps/desktop/prod-resources/houston-v1-cleanup", to: V1_CLEANUP_BINARY },
    {
      from: "apps/desktop/prod-resources/third-party-licenses.json",
      to: "third-party-licenses.json",
    },
  ];
  if (platform === "linux") {
    resources.push({
      from: "apps/desktop/prod-resources/gnome-extension",
      to: GNOME_EXTENSION_DIR,
      filter: [...gnomeCaptureBundle.files],
    });
    if (exists(`apps/desktop/prod-resources/${BROWSER_SECRET_DIR}/${BROWSER_SECRET_EXECUTABLE}`)) {
      resources.push({
        from: "apps/desktop/prod-resources/browser-secret",
        to: BROWSER_SECRET_DIR,
      });
    }
    for (const [directory, executable] of [
      [RESOURCE_MONITOR_DIR, "houston-resource-monitor"],
      ["kde-capture", "houston-kde-snap-shot"],
      ["hyprland-capture", "houston-hyprland-snap-shot"],
    ] as const) {
      if (!exists(`apps/desktop/prod-resources/${directory}/${executable}`)) continue;
      resources.push({
        from: `apps/desktop/prod-resources/${directory}/${executable}`,
        to: `${directory}/${executable}`,
      });
    }
  }
  if (platform === "win") {
    resources.push({ from: "apps/desktop/prod-resources/windows-server", to: "." });
  }
  return resources;
}

/** Lists required resources missing from the staged app; optional helpers report separately. */
export function missingPackagedResources(input: {
  readonly platform: BuildPlatform;
  readonly exists: (path: string, area: PackagedResourceRequirement["area"]) => boolean;
}): { readonly missing: string[]; readonly skippedOptional: string[] } {
  const missing: string[] = [];
  const skippedOptional: string[] = [];
  for (const requirement of PACKAGED_RESOURCE_REQUIREMENTS) {
    if (requirement.platforms !== undefined && !requirement.platforms.includes(input.platform)) {
      continue;
    }
    if (input.exists(requirement.source, requirement.area)) continue;
    if (requirement.optional === true) {
      skippedOptional.push(requirement.lookup);
    } else {
      missing.push(requirement.lookup);
    }
  }
  return { missing, skippedOptional };
}

export function assertPackagedResources(input: {
  readonly platform: BuildPlatform;
  readonly exists: (path: string, area: PackagedResourceRequirement["area"]) => boolean;
}): void {
  const { missing, skippedOptional } = missingPackagedResources(input);
  if (missing.length > 0) {
    throw new Error(
      `The desktop package is missing resources the host reads from process.resourcesPath: ${missing.join(", ")}.`,
    );
  }
  if (skippedOptional.length > 0) {
    console.warn(
      `[desktop-artifact] Optional host helpers are not in this checkout and were not packaged: ${skippedOptional.join(", ")}.`,
    );
  }
}

interface BuildOptions {
  readonly platform: BuildPlatform;
  readonly target: string;
  readonly arch: BuildArch;
  readonly version: string;
  readonly outputDir: string;
  readonly skipBuild: boolean;
  readonly keepStage: boolean;
  readonly verbose: boolean;
}

function resolveBuildOptions(): BuildOptions {
  const { values } = NodeUtil.parseArgs({
    options: {
      platform: { type: "string" },
      target: { type: "string" },
      arch: { type: "string" },
      version: { type: "string" },
      "output-dir": { type: "string" },
      "skip-build": { type: "boolean", default: false },
      "keep-stage": { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
    },
  });
  const platform = resolveDesktopBuildPlatform(
    values.platform ?? detectHostPlatform(process.platform),
  );
  const target = resolveDesktopBuildTarget(platform, values.target ?? DEFAULT_TARGETS[platform]);
  const arch = resolveDesktopBuildArch(values.arch ?? process.arch);
  const version = values.version ?? serverPackageJson.version;
  const outputDir = NodePath.resolve(REPO_ROOT, values["output-dir"] ?? "release");
  return {
    platform,
    target,
    arch,
    version,
    outputDir,
    skipBuild: values["skip-build"],
    keepStage: values["keep-stage"],
    verbose: values.verbose,
  };
}

function detectHostPlatform(host: NodeJS.Platform): BuildPlatform {
  if (host === "darwin") return "mac";
  if (host === "win32") return "win";
  return "linux";
}

function run(
  command: string,
  args: readonly string[],
  input: { cwd?: string; env?: NodeJS.ProcessEnv; verbose?: boolean } = {},
): void {
  const result = NodeChildProcess.spawnSync(command, [...args], {
    cwd: input.cwd ?? REPO_ROOT,
    env: { ...process.env, ...input.env },
    stdio: input.verbose === true ? "inherit" : "pipe",
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    const tail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(
      `${command} ${args.join(" ")} exited with ${result.status ?? "no status"}${tail === "" ? "" : `:\n${tail}`}`,
    );
  }
}

function pnpm(args: readonly string[], input: { cwd?: string; verbose?: boolean } = {}): void {
  run("pnpm", args, input);
}

function listResolvedDependencies(filter: string): Record<string, string> {
  const result = NodeChildProcess.spawnSync(
    "pnpm",
    ["--filter", filter, "list", "--depth", "0", "--prod", "--json"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `pnpm list for ${filter} exited with ${result.status ?? "no status"}: ${result.stderr}`,
    );
  }
  const [manifest] = JSON.parse(result.stdout) as Array<{
    dependencies?: Record<string, { version?: string }>;
  }>;
  return Object.fromEntries(
    Object.entries(manifest?.dependencies ?? {})
      .filter(([, info]) => typeof info.version === "string" && !info.version.startsWith("link:"))
      .map(([name, info]) => [name, info.version as string]),
  );
}

function writeJson(path: string, value: unknown): void {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function copyDirectory(
  source: string,
  destination: string,
  filter?: (source: string) => boolean,
): void {
  NodeFS.rmSync(destination, { recursive: true, force: true });
  NodeFS.cpSync(source, destination, {
    recursive: true,
    verbatimSymlinks: true,
    ...(filter === undefined ? {} : { filter }),
  });
}

function copyFile(source: string, destination: string, mode?: number): void {
  NodeFS.mkdirSync(NodePath.dirname(destination), { recursive: true });
  NodeFS.cpSync(source, destination);
  if (mode !== undefined) NodeFS.chmodSync(destination, mode);
}

function buildDesktopBundles(verbose: boolean): void {
  console.log("[desktop-artifact] Building desktop, server and web bundles...");
  pnpm(["run", "build:desktop"], { verbose });
}

function buildV1Cleanup(platform: BuildPlatform, verbose: boolean): string {
  const executable = platform === "win" ? `${V1_CLEANUP_BINARY}.exe` : V1_CLEANUP_BINARY;
  const binary = NodePath.join(REPO_ROOT, V1_CLEANUP_CRATE, "target", "release", executable);
  const crateManifest = NodePath.join(REPO_ROOT, V1_CLEANUP_CRATE, "Cargo.toml");
  const source = NodePath.join(REPO_ROOT, V1_CLEANUP_CRATE, "src");
  const newestSource = NodeFS.readdirSync(source, { encoding: "utf8", recursive: true })
    .map((entry) => NodePath.join(source, entry))
    .filter((entry) => NodeFS.existsSync(entry) && NodeFS.lstatSync(entry).isFile())
    .reduce(
      (newest, entry) => Math.max(newest, NodeFS.lstatSync(entry).mtimeMs),
      NodeFS.lstatSync(crateManifest).mtimeMs,
    );
  const fresh = NodeFS.existsSync(binary) && NodeFS.lstatSync(binary).mtimeMs >= newestSource;
  if (!fresh) {
    console.log("[desktop-artifact] Building the Houston 1 cleanup helper...");
    run("cargo", ["build", "--release", "--manifest-path", crateManifest], { verbose });
  }
  if (!NodeFS.existsSync(binary)) {
    throw new Error(
      `cargo did not produce ${binary}; expected a release build of ${V1_CLEANUP_CRATE}.`,
    );
  }
  return binary;
}

function buildBrowserSecret(verbose: boolean): string | undefined {
  run("node", ["apps/desktop/scripts/build-browser-secret.mjs"], { verbose });
  const binary = NodePath.join(
    REPO_ROOT,
    "native/browser-secret/build",
    process.arch,
    BROWSER_SECRET_EXECUTABLE,
  );
  return NodeFS.existsSync(binary) ? binary : undefined;
}

function stageResources(input: {
  readonly platform: BuildPlatform;
  readonly stageAppDir: string;
  readonly verbose: boolean;
}): void {
  const resourcesDir = NodePath.join(input.stageAppDir, "apps/desktop/resources");
  const prodResourcesDir = NodePath.join(input.stageAppDir, "apps/desktop/prod-resources");
  copyDirectory(NodePath.join(REPO_ROOT, "apps/desktop/resources"), resourcesDir);
  copyDirectory(resourcesDir, prodResourcesDir);

  const v1Cleanup = buildV1Cleanup(input.platform, input.verbose);
  copyFile(
    v1Cleanup,
    NodePath.join(
      prodResourcesDir,
      input.platform === "win" ? `${V1_CLEANUP_BINARY}.exe` : V1_CLEANUP_BINARY,
    ),
    0o755,
  );

  if (input.platform === "linux") {
    const gnomeTarget = NodePath.join(prodResourcesDir, GNOME_EXTENSION_DIR);
    NodeFS.rmSync(gnomeTarget, { recursive: true, force: true });
    NodeFS.mkdirSync(gnomeTarget, { recursive: true });
    for (const file of gnomeCaptureBundle.files) {
      copyFile(
        NodePath.join(REPO_ROOT, "apps/desktop/gnome-extension", file),
        NodePath.join(gnomeTarget, file),
      );
    }
    const browserSecret = buildBrowserSecret(input.verbose);
    if (browserSecret !== undefined) {
      copyFile(
        browserSecret,
        NodePath.join(prodResourcesDir, BROWSER_SECRET_DIR, BROWSER_SECRET_EXECUTABLE),
        0o755,
      );
    }
  }
}

function stageWindowsServerSidecar(
  stageAppDir: string,
  arch: BuildArch,
  desktopOnlyPackages: ReadonlyArray<string>,
): void {
  const require = NodeModule.createRequire(import.meta.url);
  const asar = require("@electron/asar") as {
    createPackageWithOptions(source: string, destination: string, options?: unknown): void;
  };
  const sourceDir = NodePath.join(stageAppDir, "server-sidecar");
  const asarPath = NodePath.join(
    stageAppDir,
    "apps/desktop/prod-resources/windows-server",
    WINDOWS_SERVER_ASAR,
  );
  const exclusions = resolveWindowsServerExclusions({ arch, desktopOnlyPackages });
  const keep = (source: string): boolean => {
    const path = NodePath.relative(stageAppDir, source).split(NodePath.sep).join("/");
    // A trailing slash lets `dir/**` prune the directory instead of leaving it empty.
    const directory = NodeFS.lstatSync(source).isDirectory();
    return !isExcludedPath(directory ? `${path}/` : path, exclusions);
  };
  NodeFS.mkdirSync(sourceDir, { recursive: true });
  copyDirectory(
    NodePath.join(stageAppDir, "apps/server/dist"),
    NodePath.join(sourceDir, "apps/server/dist"),
    keep,
  );
  const nodeModules = NodePath.join(stageAppDir, "node_modules");
  if (NodeFS.existsSync(nodeModules)) {
    copyDirectory(nodeModules, NodePath.join(sourceDir, "node_modules"), keep);
  }
  NodeFS.mkdirSync(NodePath.dirname(asarPath), { recursive: true });
  NodeFS.rmSync(asarPath, { force: true });
  asar.createPackageWithOptions(sourceDir, asarPath, {
    unpack: WINDOWS_NATIVE_ASAR_UNPACK_GLOB,
  });
  NodeFS.rmSync(sourceDir, { recursive: true, force: true });
}

function buildConfigInput(options: BuildOptions, stageAppDir: string) {
  return {
    platform: options.platform,
    target: options.target,
    arch: options.arch,
    version: options.version,
    outputDir: options.outputDir,
    repoRoot: REPO_ROOT,
    stageAppDir,
  };
}

function stageApp(input: { readonly options: BuildOptions; readonly stageAppDir: string }): {
  readonly serverRoots: string[];
  readonly desktopRoots: string[];
} {
  const { options, stageAppDir } = input;
  for (const directory of ["apps/desktop", "apps/server"]) {
    NodeFS.mkdirSync(NodePath.join(stageAppDir, directory), { recursive: true });
  }
  copyDirectory(
    NodePath.join(REPO_ROOT, "apps/desktop/dist-electron"),
    NodePath.join(stageAppDir, "apps/desktop/dist-electron"),
  );
  copyDirectory(
    NodePath.join(REPO_ROOT, "apps/server/dist"),
    NodePath.join(stageAppDir, "apps/server/dist"),
  );
  stageResources({ platform: options.platform, stageAppDir, verbose: options.verbose });

  const serverDependencies = listResolvedDependencies("@houston-app/cli");
  const desktopDependencies = listResolvedDependencies("@houston-app/desktop");
  const stageDependencyRoots = resolveStageDependencyRoots({
    platform: options.platform,
    arch: options.arch,
    serverDependencies,
    desktopDependencies,
    fffVersion: serverPackageJson.dependencies["@ff-labs/fff-node"],
  });
  const stageDependencies = { ...stageDependencyRoots.server, ...stageDependencyRoots.desktop };
  const stagePackageJson = {
    name: "houston",
    version: options.version,
    private: true,
    packageManager: rootPackageJson.packageManager,
    description: DESKTOP_LONG_DESCRIPTION,
    license: "MIT",
    homepage: DESKTOP_HOMEPAGE,
    author: { name: DESKTOP_PUBLISHER },
    main: "apps/desktop/dist-electron/boot.cjs",
    dependencies: stageDependencies,
    devDependencies: { electron: desktopPackageJson.dependencies.electron },
    build: createBuildConfig(buildConfigInput(options, stageAppDir)),
  };
  writeJson(NodePath.join(stageAppDir, "package.json"), stagePackageJson);

  const workspaceConfig = createStageWorkspaceConfig({
    platform: options.platform,
    arch: options.arch,
  });
  NodeFS.writeFileSync(
    NodePath.join(stageAppDir, "pnpm-workspace.yaml"),
    `${serializeWorkspaceConfig(workspaceConfig)}`,
  );

  const patchesDir = NodePath.join(stageAppDir, "patches");
  NodeFS.mkdirSync(patchesDir, { recursive: true });
  for (const patch of STAGE_PATCHES) {
    copyFile(NodePath.join(REPO_ROOT, "patches", patch), NodePath.join(patchesDir, patch));
  }
  return {
    serverRoots: Object.keys(stageDependencyRoots.server),
    desktopRoots: Object.keys(stageDependencyRoots.desktop),
  };
}

function serializeWorkspaceConfig(config: Record<string, unknown>): string {
  const lines: string[] = [];
  const emit = (value: unknown, indent: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${indent}- ${JSON.stringify(item)}`);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        const yamlKey = /^[A-Za-z0-9_.-]+$/.test(key) ? key : JSON.stringify(key);
        if (nested !== null && typeof nested === "object") {
          lines.push(`${indent}${yamlKey}:`);
          emit(nested, `${indent}  `);
        } else {
          lines.push(`${indent}${yamlKey}: ${JSON.stringify(nested)}`);
        }
      }
      return;
    }
    lines.push(`${indent}${JSON.stringify(value)}`);
  };
  emit(config, "");
  return `${lines.join("\n")}\n`;
}

function installStageDependencies(stageAppDir: string, verbose: boolean): void {
  console.log("[desktop-artifact] Installing staged production dependencies...");
  pnpm(["install", "--prod"], { cwd: stageAppDir, verbose });
}

function stageResourceMonitor(stageAppDir: string): void {
  const source = NodePath.join(
    REPO_ROOT,
    "native/resource-monitor/target/release/houston-resource-monitor",
  );
  if (!NodeFS.existsSync(source)) return;
  copyFile(
    source,
    NodePath.join(
      stageAppDir,
      "apps/desktop/prod-resources/resource-monitor/houston-resource-monitor",
    ),
    0o755,
  );
}

function verifyStagedResources(stageAppDir: string, platform: BuildPlatform): void {
  const prodResourcesDir = NodePath.join(stageAppDir, "apps/desktop/prod-resources");
  assertPackagedResources({
    platform,
    exists: (path) =>
      NodeFS.existsSync(NodePath.join(stageAppDir, path)) ||
      NodeFS.existsSync(NodePath.join(prodResourcesDir, path)),
  });
}

/** Rewrites the staged build config once the installed tree shows which packages only the server reaches. */
function splitWindowsArchives(
  options: BuildOptions,
  stageAppDir: string,
  roots: { readonly serverRoots: string[]; readonly desktopRoots: string[] },
): void {
  const split = splitArchivePackages({ stageDir: stageAppDir, ...roots });
  stageWindowsServerSidecar(stageAppDir, options.arch, split.desktopOnly);
  const manifestPath = NodePath.join(stageAppDir, "package.json");
  const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.build = createBuildConfig({
    ...buildConfigInput(options, stageAppDir),
    serverOnlyPackages: split.serverOnly,
  });
  writeJson(manifestPath, manifest);
  console.log(
    `[desktop-artifact] app.asar leaves out ${split.serverOnly.length} server-only packages; server.asar leaves out ${split.desktopOnly.length} desktop-only packages.`,
  );
}

function runElectronBuilder(options: BuildOptions, stageAppDir: string): void {
  const args = [
    "exec",
    "--filter",
    "@houston-app/desktop",
    "--",
    "electron-builder",
    "--projectDir",
    stageAppDir,
    PLATFORM_FLAGS[options.platform],
    `--${options.arch}`,
    "--publish",
    "never",
  ];
  const env: NodeJS.ProcessEnv = { ...process.env };
  // electron-builder treats empty signing variables as enabled.
  for (const [key, value] of Object.entries(env)) {
    if (value === "") delete env[key];
  }
  env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  delete env.CSC_LINK;
  delete env.CSC_KEY_PASSWORD;
  console.log(
    `[desktop-artifact] Building ${options.platform}/${options.target} (arch=${options.arch}, version=${options.version})...`,
  );
  run("pnpm", args, { env, verbose: options.verbose });
}

function verifyPackagedOutput(options: BuildOptions): void {
  const unpackedName =
    options.platform === "linux"
      ? options.arch === "x64"
        ? "linux-unpacked"
        : "linux-arm64-unpacked"
      : options.platform === "win"
        ? options.arch === "x64"
          ? "win-unpacked"
          : "win-arm64-unpacked"
        : options.arch === "x64"
          ? "mac"
          : "mac-arm64";
  const unpackedDir = NodePath.join(options.outputDir, unpackedName);
  const resourcesDir =
    options.platform === "mac"
      ? NodePath.join(unpackedDir, `${PRODUCT_NAME}.app`, "Contents", "Resources")
      : NodePath.join(unpackedDir, "resources");
  const appDir = NodePath.join(resourcesDir, "app");
  const appAsar = NodePath.join(resourcesDir, "app.asar");
  const existsInArchive = (archive: string, path: string): boolean => {
    if (!NodeFS.existsSync(archive)) return false;
    const asar = NodeModule.createRequire(import.meta.url)("@electron/asar") as {
      statFile(archive: string, path: string): unknown;
    };
    try {
      asar.statFile(archive, path);
      return true;
    } catch {
      return false;
    }
  };
  const existsInApp = (path: string): boolean =>
    NodeFS.existsSync(NodePath.join(appDir, path)) || existsInArchive(appAsar, path);

  assertPackagedResources({
    platform: options.platform,
    exists: (path, area) =>
      area === "server"
        ? existsInArchive(NodePath.join(resourcesDir, WINDOWS_SERVER_ASAR), path)
        : existsInApp(path) || NodeFS.existsSync(NodePath.join(resourcesDir, path)),
  });

  const generated = [
    { path: "app-update.yml", required: true },
    { path: "package-type", required: options.platform === "linux" && options.target === "deb" },
  ] as const;
  const missing = generated
    .filter(
      (entry) => entry.required && !NodeFS.existsSync(NodePath.join(resourcesDir, entry.path)),
    )
    .map((entry) => entry.path);
  if (missing.length > 0) {
    throw new Error(
      `The packaged app is missing electron-updater metadata: ${missing.join(", ")} (resources directory ${resourcesDir}).`,
    );
  }

  if (options.platform === "win") {
    const serverAsar = NodePath.join(resourcesDir, WINDOWS_SERVER_ASAR);
    if (!NodeFS.existsSync(serverAsar)) {
      throw new Error(`The Windows package is missing ${serverAsar}.`);
    }
  }
}

function printArtifacts(outputDir: string): void {
  if (!NodeFS.existsSync(outputDir)) return;
  for (const entry of NodeFS.readdirSync(outputDir)) {
    if (!/\.(AppImage|deb|exe|dmg|yml)$/.test(entry)) continue;
    console.log(
      `  ${NodePath.join(outputDir, entry)} (${NodeFS.lstatSync(NodePath.join(outputDir, entry)).size} bytes)`,
    );
  }
}

export function main(): void {
  const options = resolveBuildOptions();
  const hostPlatform = detectHostPlatform(process.platform);
  if (options.platform !== hostPlatform) {
    throw new Error(
      `Building ${options.platform} artifacts requires a ${options.platform} host; this host is ${hostPlatform}.`,
    );
  }
  const stageRoot = NodePath.join(options.outputDir, `.stage-${options.platform}-${options.arch}`);
  const stageAppDir = NodePath.join(stageRoot, "app");
  NodeFS.mkdirSync(options.outputDir, { recursive: true });
  NodeFS.rmSync(stageRoot, { recursive: true, force: true });
  NodeFS.mkdirSync(stageAppDir, { recursive: true });

  try {
    if (!options.skipBuild) {
      buildDesktopBundles(options.verbose);
    }
    const roots = stageApp({ options, stageAppDir });
    installStageDependencies(stageAppDir, options.verbose);
    stageResourceMonitor(stageAppDir);
    if (options.platform === "win") {
      splitWindowsArchives(options, stageAppDir, roots);
    }
    verifyStagedResources(stageAppDir, options.platform);
    runElectronBuilder(options, stageAppDir);
    verifyPackagedOutput(options);
    console.log("[desktop-artifact] Artifacts:");
    printArtifacts(options.outputDir);
  } finally {
    if (!options.keepStage) {
      NodeFS.rmSync(stageRoot, { recursive: true, force: true });
    } else {
      console.log(`[desktop-artifact] Stage kept at ${stageAppDir}.`);
    }
  }
}

if (
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(`[desktop-artifact] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
