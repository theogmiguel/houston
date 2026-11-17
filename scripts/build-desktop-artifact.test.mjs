#!/usr/bin/env node
import * as NodeAssert from "node:assert/strict";
import * as NodeModule from "node:module";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

import {
  createBuildConfig,
  createStageWorkspaceConfig,
  DESKTOP_APP_ID,
  DESKTOP_COPYRIGHT,
  DESKTOP_HOMEPAGE,
  DESKTOP_LONG_DESCRIPTION,
  DESKTOP_PUBLISHER,
  DESKTOP_SHORT_DESCRIPTION,
  GITHUB_PUBLISH_CONFIG,
  isExcludedPath,
  LINUX_DEB_DEPENDS,
  asarEntryPath,
  missingPackagedResources,
  stageWindowsServerSidecar,
  resolveDesktopTargets,
  resolveExtraResources,
  resolveMacFileExclusions,
  resolveStageDependencies,
  resolveStageDependencyRoots,
  resolveWindowsServerExclusions,
} from "./build-desktop-artifact.ts";
import { isDesktopRuntimeExternalDependency } from "./lib/desktop-external-packages.ts";
import { splitArchivePackages } from "./lib/staged-package-closure.ts";

const REPO_ROOT = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const BASE_INPUT = {
  version: "0.19.10",
  outputDir: NodePath.join(REPO_ROOT, "release"),
  repoRoot: REPO_ROOT,
  stageAppDir: REPO_ROOT,
};

function buildConfig(platform, target, arch = "x64", serverOnlyPackages = undefined) {
  return createBuildConfig({ ...BASE_INPUT, platform, target, arch, serverOnlyPackages });
}

/** The `files` exclusions of a config, as globs over stage-relative paths. */
function excludedBy(config) {
  return config.files.filter((pattern) => pattern.startsWith("!")).map((glob) => glob.slice(1));
}

/** A staged tree for splitArchivePackages: `{ "<path under stage>": [dependency names] }`. */
function fixtureReader(stageDir, packages) {
  return {
    readDependencies: (dir) => {
      const relative = NodePath.relative(stageDir, dir).split(NodePath.sep).join("/");
      return packages[relative];
    },
  };
}

NodeTest.test("the Windows config installs per-user with the Houston NSIS hook", () => {
  const config = buildConfig("win", "nsis");
  NodeAssert.equal(config.appId, DESKTOP_APP_ID);
  NodeAssert.equal(config.productName, "Houston");
  NodeAssert.equal(config.copyright, DESKTOP_COPYRIGHT);
  NodeAssert.deepEqual(config.publish, [GITHUB_PUBLISH_CONFIG]);
  NodeAssert.deepEqual(config.nsis, {
    oneClick: true,
    perMachine: false,
    differentialPackage: false,
    include: "apps/desktop/resources/installer.nsh",
    shortcutName: "Houston",
    artifactName: "Houston-${version}-${arch}-setup.${ext}",
  });
  NodeAssert.deepEqual(config.win, {
    target: ["nsis"],
    icon: "icon.ico",
    signAndEditExecutable: true,
  });
});

NodeTest.test("the NSIS hook keeps the Tauri install directory and daemon cleanup", () => {
  const hook = NodeFS.readFileSync(
    NodePath.join(REPO_ROOT, "apps/desktop/resources/installer.nsh"),
    "utf8",
  );
  NodeAssert.match(hook, /!macro customInit\n {2}StrCpy \$INSTDIR "\$LOCALAPPDATA\\Houston"/);
  NodeAssert.match(hook, /!macro customUnInstall/);
  NodeAssert.match(hook, /\.houston\\daemon\.json/);
  NodeAssert.match(hook, /StartsWith\('\$INSTDIR'\)/);
});

NodeTest.test("the NSIS hook defines only macros the installer templates insert", () => {
  // makensis runs with warnings as errors, and a function that only an
  // uninserted macro references is a warning.
  const hook = NodeFS.readFileSync(
    NodePath.join(REPO_ROOT, "apps/desktop/resources/installer.nsh"),
    "utf8",
  );
  const fromDesktop = NodeModule.createRequire(
    NodePath.join(REPO_ROOT, "apps/desktop/package.json"),
  );
  const fromBuilder = NodeModule.createRequire(
    fromDesktop.resolve("electron-builder/package.json"),
  );
  const templates = NodePath.join(
    NodePath.dirname(fromBuilder.resolve("app-builder-lib/package.json")),
    "templates/nsis",
  );
  const inserted = NodeFS.readdirSync(templates, { encoding: "utf8", recursive: true })
    .filter((entry) => /\.ns[hi]$/.test(entry))
    .map((entry) => NodeFS.readFileSync(NodePath.join(templates, entry), "utf8"))
    .join("\n");
  const defined = [...hook.matchAll(/^!macro (\w+)/gm)].map((match) => match[1]);
  NodeAssert.notEqual(defined.length, 0);
  for (const macro of defined) {
    NodeAssert.match(
      inserted,
      new RegExp(`!insertmacro ${macro}\\b`),
      `installer.nsh defines ${macro}, which no installer template inserts`,
    );
  }
  NodeAssert.doesNotMatch(hook, /StrFunc\.nsh/);
});

NodeTest.test("the NSIS hook declares its install variables only in the installer build", () => {
  const hook = NodeFS.readFileSync(
    NodePath.join(REPO_ROOT, "apps/desktop/resources/installer.nsh"),
    "utf8",
  );
  const declared = [...hook.matchAll(/^\s*Var \/GLOBAL (\w+)$/gm)].map((match) => match[1]);
  NodeAssert.deepEqual(declared, ["houstonUpdateMode", "houstonRestart", "houstonLaunchArgs"]);
  const guarded = /!ifndef BUILD_UNINSTALLER\n((?: {2}Var \/GLOBAL \w+\n)+)!endif/.exec(hook)?.[1];
  NodeAssert.equal(guarded?.match(/Var \/GLOBAL/g)?.length, declared.length);
  const uninstall = /!macro customUnInstall\n([\s\S]*?)!macroend/.exec(hook)?.[1] ?? "";
  for (const name of declared) NodeAssert.equal(uninstall.includes(`$${name}`), false);
});

NodeTest.test("every label in the NSIS hook is a jump target", () => {
  // An unused label is a makensis warning, and the build treats warnings as errors.
  const hook = NodeFS.readFileSync(
    NodePath.join(REPO_ROOT, "apps/desktop/resources/installer.nsh"),
    "utf8",
  );
  const labels = [...hook.matchAll(/^(\w+):$/gm)].map((match) => match[1]);
  NodeAssert.notEqual(labels.length, 0);
  for (const label of labels) {
    NodeAssert.match(
      hook,
      new RegExp(`\\b${label}\\b(?!:)`),
      `installer.nsh declares the label ${label}, which nothing jumps to`,
    );
  }
});

NodeTest.test("the NSIS hook reads the daemon pid past the key's separator", () => {
  const hook = NodeFS.readFileSync(
    NodePath.join(REPO_ROOT, "apps/desktop/resources/installer.nsh"),
    "utf8",
  );
  NodeAssert.match(hook, /StrCmp \$R4 ':' houstonUninstallNextSeparator houstonUninstallParsePid/);
  NodeAssert.match(hook, /IntCmp \$R1 0 houstonUninstallDone houstonUninstallDone\n/);
});

NodeTest.test("the NSIS hook accepts the arguments the Tauri updater passes", () => {
  const hook = NodeFS.readFileSync(
    NodePath.join(REPO_ROOT, "apps/desktop/resources/installer.nsh"),
    "utf8",
  );
  NodeAssert.match(hook, /\$\{GetOptions\} \$R0 "\/UPDATE" \$R1/);
  NodeAssert.match(hook, /\$\{GetOptions\} \$R0 "\/R" \$R1/);
  NodeAssert.match(hook, /\$\{GetOptions\} \$R0 "\/ARGS" \$R1/);
  NodeAssert.match(hook, /\$\{StdUtils\.TestParameter\} \$R1 "force-run"/);
  NodeAssert.match(hook, /\$\{StdUtils\.TestParameter\} \$R1 "updated"/);
});

NodeTest.test("the NSIS hook relaunches Houston with the updater's arguments", () => {
  const hook = NodeFS.readFileSync(
    NodePath.join(REPO_ROOT, "apps/desktop/resources/installer.nsh"),
    "utf8",
  );
  NodeAssert.match(hook, /\$\{ElseIfNot\} \$\{Silent\}/);
  NodeAssert.match(hook, /\$\{StdUtils\.ExecShellAsUser\} \$1 "\$launchLink" "open" "\$R0"/);
  NodeAssert.match(hook, /!ifdef RUN_AFTER_FINISH\n {2}!undef RUN_AFTER_FINISH/);
});

NodeTest.test("the NSIS hook removes the files only the Tauri install placed", () => {
  const hook = NodeFS.readFileSync(
    NodePath.join(REPO_ROOT, "apps/desktop/resources/installer.nsh"),
    "utf8",
  );
  const install = /!macro customInstall\n([\s\S]*?)!macroend/.exec(hook)?.[1] ?? "";
  for (const file of ["houston-core.exe", "tr-helper.exe", "uninstall.exe"]) {
    NodeAssert.equal(install.includes(`Delete "$INSTDIR\\${file}"`), true, file);
  }
});

NodeTest.test("the NSIS hook removes the Tauri uninstall registry entry", () => {
  const hook = NodeFS.readFileSync(
    NodePath.join(REPO_ROOT, "apps/desktop/resources/installer.nsh"),
    "utf8",
  );
  NodeAssert.match(
    hook,
    /ReadRegStr \$R0 HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Houston" "DisplayName"/,
  );
  NodeAssert.match(
    hook,
    /DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Houston"/,
  );
});

NodeTest.test("the Linux config builds the AppImage and deb", () => {
  const config = buildConfig("linux", "AppImage");
  NodeAssert.deepEqual(resolveDesktopTargets("linux", "AppImage"), ["AppImage", "deb"]);
  NodeAssert.deepEqual(config.linux, {
    target: ["AppImage", "deb"],
    executableName: "houston",
    icon: "icons",
    category: "Development",
    synopsis: DESKTOP_SHORT_DESCRIPTION,
    description: DESKTOP_LONG_DESCRIPTION,
    maintainer: DESKTOP_PUBLISHER,
    desktop: { entry: { StartupWMClass: "houston" } },
  });
  NodeAssert.deepEqual(config.deb.depends, [...LINUX_DEB_DEPENDS]);
  NodeAssert.equal(config.asar, false);
});

NodeTest.test("the packaged metadata matches the bundle strings", () => {
  const config = buildConfig("linux", "deb");
  NodeAssert.equal(DESKTOP_SHORT_DESCRIPTION, "Mission control for CLI coding agents");
  NodeAssert.equal(
    DESKTOP_LONG_DESCRIPTION,
    "Houston is a local-first mission control for coding agents: it runs them in persistent threads served by a local server, so agent runs continue when the window closes and agents can delegate work to other threads.",
  );
  NodeAssert.equal(DESKTOP_PUBLISHER, "Théo Miguel");
  NodeAssert.equal(DESKTOP_COPYRIGHT, "Copyright © 2026 Théo Miguel");
  NodeAssert.equal(DESKTOP_HOMEPAGE, "https://github.com/theogmiguel/houston");
  NodeAssert.equal(config.publish[0].owner, "theogmiguel");
  NodeAssert.equal(config.publish[0].repo, "houston");
});

NodeTest.test("optional helpers are only listed when the staged package carries them", () => {
  const withoutHelpers = resolveExtraResources("linux", () => false);
  NodeAssert.equal(
    withoutHelpers.some((entry) => String(entry.from).includes("browser-secret")),
    false,
  );
  const withHelpers = resolveExtraResources("linux", (path) =>
    path.endsWith("houston-browser-secret"),
  );
  NodeAssert.equal(
    withHelpers.some((entry) => String(entry.from).includes("browser-secret")),
    true,
  );
});

NodeTest.test("missing packaged resources name every required lookup", () => {
  const { missing, skippedOptional } = missingPackagedResources({
    platform: "linux",
    exists: () => false,
  });
  NodeAssert.deepEqual(missing, [
    "houston-v1-cleanup",
    "third-party-licenses.json",
    "icon.png",
    "tray/idle-16.png",
    "tray/active-16.png",
    "gnome-extension/metadata.json",
    "gnome-extension/extension.js",
    "apps/desktop/prod-resources/icon.png",
    "apps/server/dist/bin.mjs",
    "apps/server/dist/client/index.html",
    "apps/desktop/dist-electron/main.cjs",
  ]);
  NodeAssert.deepEqual(skippedOptional, [
    "browser-secret/houston-browser-secret",
    "resource-monitor/houston-resource-monitor",
    "kde-capture/houston-kde-snap-shot",
    "hyprland-capture/houston-hyprland-snap-shot",
  ]);
});

NodeTest.test("Windows packages the Houston 1 cleanup helper under its .exe name", () => {
  const asked = [];
  const { missing } = missingPackagedResources({
    platform: "win",
    exists: (path) => {
      asked.push(path);
      return path === "houston-v1-cleanup.exe";
    },
  });
  NodeAssert.equal(missing.includes("houston-v1-cleanup"), false);
  NodeAssert.equal(asked.includes("houston-v1-cleanup"), false);
  NodeAssert.deepEqual(resolveExtraResources("win", () => false)[0], {
    from: "apps/desktop/prod-resources/houston-v1-cleanup.exe",
    to: "houston-v1-cleanup.exe",
  });
  NodeAssert.deepEqual(resolveExtraResources("linux", () => false)[0], {
    from: "apps/desktop/prod-resources/houston-v1-cleanup",
    to: "houston-v1-cleanup",
  });
});

NodeTest.test("an archive lookup uses the platform's path separator", () => {
  NodeAssert.equal(asarEntryPath("apps/server/dist/bin.mjs", "\\"), "apps\\server\\dist\\bin.mjs");
  NodeAssert.equal(asarEntryPath("apps/server/dist/bin.mjs", "/"), "apps/server/dist/bin.mjs");
});

NodeTest.test("the Windows server archive is written before its staging source goes", async () => {
  const stage = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "houston-server-sidecar-"));
  try {
    const dist = NodePath.join(stage, "apps/server/dist");
    NodeFS.mkdirSync(dist, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dist, "bin.mjs"), "export {};\n");
    await stageWindowsServerSidecar(stage, "x64", []);
    const archive = NodePath.join(stage, "apps/desktop/prod-resources/windows-server/server.asar");
    NodeAssert.equal(NodeFS.existsSync(archive), true);
    const asar = NodeModule.createRequire(import.meta.url)("@electron/asar");
    NodeAssert.doesNotThrow(() =>
      asar.statFile(archive, asarEntryPath("apps/server/dist/bin.mjs")),
    );
    NodeAssert.equal(NodeFS.existsSync(NodePath.join(stage, "server-sidecar")), false);
  } finally {
    NodeFS.rmSync(stage, { recursive: true });
  }
});

NodeTest.test("a resource present in the stage is not reported missing", () => {
  const { missing } = missingPackagedResources({
    platform: "linux",
    exists: (path) => path === "apps/server/dist/bin.mjs",
  });
  NodeAssert.equal(missing.includes("apps/server/dist/bin.mjs"), false);
});

NodeTest.test("staged dependencies keep bundle externals and the matching fff binary", () => {
  const dependencies = resolveStageDependencies({
    platform: "linux",
    arch: "arm64",
    serverDependencies: {
      "node-pty": "1.2.0-beta.15",
      "@ff-labs/fff-node": "0.11.0",
      effect: "4.0.5",
      "@houston-app/shared": "link:../../packages/shared",
    },
    desktopDependencies: {
      "electron-webauthn": "1.3.1",
      "electron-updater": "6.8.11",
    },
    fffVersion: "0.11.0",
  });
  NodeAssert.equal(dependencies["node-pty"], "1.2.0-beta.15");
  NodeAssert.equal(dependencies["@ff-labs/fff-node"], "0.11.0");
  NodeAssert.equal(dependencies["electron-webauthn"], "1.3.1");
  NodeAssert.equal(dependencies["@ff-labs/fff-bin-linux-arm64-gnu"], "0.11.0");
  NodeAssert.equal(dependencies["@ff-labs/fff-bin-linux-arm64-musl"], undefined);
  NodeAssert.equal(dependencies["@ff-labs/fff-bin-linux-x64-gnu"], undefined);
  NodeAssert.equal(dependencies.effect, undefined);
  NodeAssert.equal(dependencies["@houston-app/shared"], undefined);
});

NodeTest.test("a single-architecture macOS build drops the other Darwin prebuilds", () => {
  const excludes = (arch, file) =>
    resolveMacFileExclusions(arch).some((glob) => NodePath.matchesGlob(file, glob.slice(1)));
  const x64 = [
    "node_modules/node-pty/prebuilds/darwin-x64/pty.node",
    "node_modules/objc-js/prebuilds/darwin-x64/node.napi.node",
  ];
  const arm64 = [
    "node_modules/node-pty/prebuilds/darwin-arm64/pty.node",
    "node_modules/objc-js/prebuilds/darwin-arm64/node.napi.armv8.node",
  ];
  for (const file of x64) {
    NodeAssert.equal(excludes("arm64", file), true, file);
    NodeAssert.equal(excludes("x64", file), false, file);
  }
  for (const file of arm64) {
    NodeAssert.equal(excludes("x64", file), true, file);
    NodeAssert.equal(excludes("arm64", file), false, file);
  }
  const macConfig = buildConfig("mac", "dmg", "arm64");
  NodeAssert.ok(
    macConfig.files.includes("!**/node_modules/**/prebuilds/darwin-x64/**/*"),
    "the macOS build config carries the exclusion",
  );
});

NodeTest.test("the staged install decides every dependency build script it meets", () => {
  const { allowBuilds } = createStageWorkspaceConfig({ platform: "mac", arch: "arm64" });
  NodeAssert.equal(
    allowBuilds["objc-js"],
    false,
    "pnpm fails the staged macOS install on an install script nobody allowed or denied",
  );
});

NodeTest.test("the dependency listing starts pnpm through a shell on Windows", () => {
  const source = NodeFS.readFileSync(
    NodePath.join(import.meta.dirname, "build-desktop-artifact.ts"),
    "utf8",
  );
  const listing = source.slice(source.indexOf("function listResolvedDependencies"));
  NodeAssert.match(
    listing.slice(0, listing.indexOf("\n}\n")),
    /shell: process\.platform === "win32"/,
    "pnpm is a .cmd shim on Windows and spawnSync cannot start it without a shell",
  );
});

NodeTest.test("the Windows resources check the server in server.asar, not app.asar", () => {
  const { missing } = missingPackagedResources({ platform: "win", exists: () => false });
  NodeAssert.ok(missing.includes("server.asar/apps/server/dist/bin.mjs"));
  NodeAssert.ok(missing.includes("server.asar/apps/server/dist/client/index.html"));
  NodeAssert.ok(missing.includes("server.asar/node_modules/node-pty/package.json"));
  NodeAssert.equal(missing.includes("apps/server/dist/bin.mjs"), false);
  NodeAssert.ok(missing.includes("apps/desktop/dist-electron/main.cjs"));

  const appOnly = missingPackagedResources({
    platform: "win",
    exists: (_path, area) => area !== "server",
  });
  NodeAssert.deepEqual(appOnly.missing, [
    "server.asar/apps/server/dist/bin.mjs",
    "server.asar/apps/server/dist/client/index.html",
    "server.asar/node_modules/node-pty/package.json",
  ]);
  const linux = missingPackagedResources({ platform: "linux", exists: () => false });
  NodeAssert.equal(linux.missing.includes("server.asar/apps/server/dist/bin.mjs"), false);
});

NodeTest.test("a macOS build drops node-pty's Windows and Linux binaries", () => {
  const globs = resolveMacFileExclusions("arm64").map((glob) => glob.slice(1));
  for (const file of [
    "node_modules/node-pty/prebuilds/win32-x64/conpty.dll",
    "node_modules/node-pty/prebuilds/linux-x64/pty.node",
    "node_modules/node-pty/third_party/conpty/1.23.251008001/win10-x64/OpenConsole.exe",
  ]) {
    NodeAssert.equal(isExcludedPath(file, globs), true, file);
  }
  NodeAssert.equal(
    isExcludedPath("node_modules/node-pty/prebuilds/darwin-arm64/pty.node", globs),
    false,
  );
  NodeAssert.equal(isExcludedPath("node_modules/node-pty/lib/index.js", globs), false);
});

NodeTest.test("every platform drops package sources and docs no runtime path loads", () => {
  for (const platform of ["linux", "mac", "win"]) {
    const globs = excludedBy(buildConfig(platform, platform === "linux" ? "AppImage" : "nsis"));
    for (const file of [
      "node_modules/@cursor/sdk/dist/esm/index.js",
      "node_modules/@cursor/sdk/dist/bundled/index.js",
      "node_modules/zod/src/v4/classic/schemas.ts",
      "node_modules/koffi/vendor/node-api-headers/include/node_api.h",
      "node_modules/koffi/doc/start.md",
      "node_modules/undici/docs/docs/api/Client.md",
      "apps/server/dist/bin.mjs.map",
    ]) {
      NodeAssert.equal(isExcludedPath(file, globs), true, `${platform}: ${file}`);
    }
    for (const file of [
      "node_modules/@cursor/sdk/dist/cjs/index.js",
      "node_modules/@cursor/sdk/LICENSE.md",
      "node_modules/zod/index.cjs",
      "node_modules/zod/LICENSE",
      "node_modules/koffi/index.cjs",
      "node_modules/koffi/src/koffi/index.cjs",
      "node_modules/koffi/LICENSE.txt",
      "node_modules/undici/index.js",
      "apps/desktop/dist-electron/main.cjs",
    ]) {
      NodeAssert.equal(isExcludedPath(file, globs), false, `${platform}: ${file}`);
    }
  }
});

NodeTest.test("the server's require of the Cursor SDK resolves to files the package keeps", () => {
  // The same createRequire call the server makes, from the module that makes it.
  const require = NodeModule.createRequire(
    NodePath.join(REPO_ROOT, "packages/provider-cursor/src/server/sdk.ts"),
  );
  // The SDK exports no package.json, and dist/cjs carries its own `type` manifest.
  let packageRoot = NodePath.dirname(require.resolve("@cursor/sdk"));
  const nameAt = (dir) => {
    const manifest = NodePath.join(dir, "package.json");
    return NodeFS.existsSync(manifest)
      ? JSON.parse(NodeFS.readFileSync(manifest, "utf8")).name
      : "";
  };
  while (nameAt(packageRoot) !== "@cursor/sdk") packageRoot = NodePath.dirname(packageRoot);
  const globs = [
    ...excludedBy(buildConfig("linux", "AppImage")),
    ...resolveWindowsServerExclusions({ arch: "x64", desktopOnlyPackages: [] }),
  ];
  const staged = (file) =>
    `node_modules/@cursor/sdk/${NodePath.relative(packageRoot, file).split(NodePath.sep).join("/")}`;
  for (const specifier of ["@cursor/sdk", "@cursor/sdk/sqlite"]) {
    const entry = require.resolve(specifier);
    NodeAssert.match(staged(entry), /\/dist\/cjs\//, specifier);
    NodeAssert.equal(isExcludedPath(staged(entry), globs), false, specifier);
  }
  // The CJS entry loads its numbered chunks from beside it.
  const cjs = NodePath.join(packageRoot, "dist/cjs");
  const scripts = NodeFS.readdirSync(cjs, { recursive: true, encoding: "utf8" }).filter((file) =>
    file.endsWith(".js"),
  );
  NodeAssert.ok(scripts.length > 1);
  for (const file of scripts) {
    NodeAssert.equal(isExcludedPath(staged(NodePath.join(cjs, file)), globs), false, file);
  }
});

NodeTest.test("a Windows app.asar leaves out the server and the packages only it reaches", () => {
  const globs = excludedBy(buildConfig("win", "nsis", "x64", ["node-pty", "@cursor/sdk"]));
  for (const file of [
    "apps/server/dist/bin.mjs",
    "apps/server/dist/client/index.html",
    "node_modules/node-pty/lib/index.js",
    "node_modules/@cursor/sdk/dist/cjs/index.js",
  ]) {
    NodeAssert.equal(isExcludedPath(file, globs), true, file);
  }
  for (const file of [
    "apps/desktop/dist-electron/main.cjs",
    "apps/desktop/prod-resources/icon.png",
    "node_modules/ffi-rs/index.js",
    "node_modules/other/node_modules/node-pty/lib/index.js",
  ]) {
    NodeAssert.equal(isExcludedPath(file, globs), false, file);
  }
  const linuxGlobs = excludedBy(buildConfig("linux", "AppImage", "x64", ["node-pty"]));
  NodeAssert.equal(isExcludedPath("apps/server/dist/bin.mjs", linuxGlobs), false);
  NodeAssert.equal(isExcludedPath("node_modules/node-pty/lib/index.js", linuxGlobs), false);
});

NodeTest.test(
  "server.asar keeps what the WSL server loads and drops other platforms' binaries",
  () => {
    const x64 = resolveWindowsServerExclusions({
      arch: "x64",
      desktopOnlyPackages: ["electron-webauthn"],
    });
    for (const file of [
      "apps/server/dist/bin.mjs",
      "apps/server/dist/client/index.html",
      "node_modules/node-pty/prebuilds/win32-x64/pty.node",
      "node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe",
      "node_modules/node-pty/prebuilds/linux-x64/pty.node",
      "node_modules/node-pty/prebuilds/linux-arm64/pty.node",
      "node_modules/node-pty/binding.gyp",
      "node_modules/node-pty/src/unix/pty.cc",
      "node_modules/node-addon-api/napi.h",
      "node_modules/node-pty/LICENSE",
      "node_modules/@cursor/sdk/dist/cjs/index.js",
    ]) {
      NodeAssert.equal(isExcludedPath(file, x64), false, file);
    }
    for (const file of [
      "apps/server/dist/bin.mjs.map",
      "node_modules/node-pty/build/Release/pty.pdb",
      "node_modules/node-pty/prebuilds/win32-x64/pty.pdb",
      "node_modules/node-pty/prebuilds/win32-arm64/pty.node",
      "node_modules/node-pty/prebuilds/darwin-arm64/pty.node",
      "node_modules/@cursor/sdk/dist/esm/index.js",
      "node_modules/.bin/tsc",
      "node_modules/electron-webauthn/index.js",
      "node_modules/electron-webauthn/",
    ]) {
      NodeAssert.equal(isExcludedPath(file, x64), true, file);
    }
    const arm64 = resolveWindowsServerExclusions({ arch: "arm64", desktopOnlyPackages: [] });
    NodeAssert.equal(
      isExcludedPath("node_modules/node-pty/prebuilds/win32-arm64/pty.node", arm64),
      false,
    );
    NodeAssert.equal(
      isExcludedPath("node_modules/node-pty/prebuilds/win32-x64/pty.node", arm64),
      true,
    );
  },
);

NodeTest.test("the archive split follows dependencies and keeps shared packages in both", () => {
  const stageDir = NodePath.join(REPO_ROOT, "release/.stage-fixture/app");
  const reader = fixtureReader(stageDir, {
    "node_modules/ffi-rs": ["@yuuang/ffi-rs-win32-x64-msvc", "@yuuang/ffi-rs-linux-x64-gnu"],
    "node_modules/@yuuang/ffi-rs-win32-x64-msvc": [],
    "node_modules/electron-webauthn": ["shared"],
    "node_modules/shared": [],
    "node_modules/node-pty": ["node-addon-api"],
    "node_modules/node-addon-api": [],
    "node_modules/@cursor/sdk": ["zod", "shared", "@connectrpc/connect"],
    "node_modules/zod": [],
    "node_modules/@connectrpc/connect": ["@bufbuild/protobuf"],
    "node_modules/@connectrpc/connect/node_modules/@bufbuild/protobuf": [],
    "node_modules/@bufbuild/protobuf": [],
  });
  const split = splitArchivePackages({
    stageDir,
    desktopRoots: ["ffi-rs", "electron-webauthn"],
    serverRoots: ["ffi-rs", "node-pty", "@cursor/sdk"],
    reader,
  });
  NodeAssert.deepEqual(split.serverOnly, [
    "@connectrpc/connect",
    "@cursor/sdk",
    "node-addon-api",
    "node-pty",
    "zod",
  ]);
  NodeAssert.deepEqual(split.desktopOnly, ["electron-webauthn"]);
});

NodeTest.test("nothing the desktop main bundle requires is excluded from the Windows app", () => {
  // The bundle leaves desktop externals to node_modules; everything else is inlined.
  const sourceDir = NodePath.join(REPO_ROOT, "apps/desktop/src");
  const required = new Set();
  for (const file of NodeFS.readdirSync(sourceDir, { recursive: true, encoding: "utf8" })) {
    if (!/\.tsx?$/.test(file) || /\.test\.tsx?$/.test(file)) continue;
    const source = NodeFS.readFileSync(NodePath.join(sourceDir, file), "utf8");
    for (const match of source.matchAll(
      /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"'.][^"']*)["']/g,
    )) {
      const specifier = match[1];
      if (!isDesktopRuntimeExternalDependency(specifier)) continue;
      const parts = specifier.split("/");
      required.add(specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]);
    }
  }
  NodeAssert.ok(required.has("@napi-rs/keyring"), [...required].join(", "));
  NodeAssert.ok(required.has("ffi-rs"), [...required].join(", "));

  const desktopPackageJson = JSON.parse(
    NodeFS.readFileSync(NodePath.join(REPO_ROOT, "apps/desktop/package.json"), "utf8"),
  );
  const serverPackageJson = JSON.parse(
    NodeFS.readFileSync(NodePath.join(REPO_ROOT, "apps/server/package.json"), "utf8"),
  );
  const roots = resolveStageDependencyRoots({
    platform: "win",
    arch: "x64",
    serverDependencies: serverPackageJson.dependencies,
    desktopDependencies: desktopPackageJson.dependencies,
    fffVersion: "0.11.0",
  });
  for (const name of required) {
    NodeAssert.ok(name in roots.desktop, `${name} is a desktop stage root`);
  }

  // Every root present, server roots also depending on each desktop root: the worst overlap.
  const stageDir = NodePath.join(REPO_ROOT, "release/.stage-fixture/app");
  const packages = {};
  for (const name of Object.keys(roots.desktop)) packages[`node_modules/${name}`] = [];
  for (const name of Object.keys(roots.server)) {
    packages[`node_modules/${name}`] = Object.keys(roots.desktop);
  }
  const split = splitArchivePackages({
    stageDir,
    desktopRoots: Object.keys(roots.desktop),
    serverRoots: Object.keys(roots.server),
    reader: fixtureReader(stageDir, packages),
  });
  NodeAssert.ok(split.serverOnly.includes("node-pty"));
  const globs = excludedBy(buildConfig("win", "nsis", "x64", split.serverOnly));
  for (const name of [...required, ...Object.keys(roots.desktop)]) {
    NodeAssert.equal(
      isExcludedPath(`node_modules/${name}/package.json`, globs),
      false,
      `${name} stays in app.asar`,
    );
  }
  for (const file of ["main.cjs", "boot.cjs", "preload.cjs", "compileCache.cjs"]) {
    NodeAssert.equal(isExcludedPath(`apps/desktop/dist-electron/${file}`, globs), false, file);
  }
});

NodeTest.test("a Linux build drops the musl binaries a glibc Electron never loads", () => {
  const globs = excludedBy(buildConfig("linux", "AppImage"));
  NodeAssert.equal(
    isExcludedPath("node_modules/@yuuang/ffi-rs-linux-x64-musl/ffi-rs.linux-x64-musl.node", globs),
    true,
  );
  NodeAssert.equal(
    isExcludedPath("node_modules/@yuuang/ffi-rs-linux-x64-gnu/ffi-rs.linux-x64-gnu.node", globs),
    false,
  );
});
