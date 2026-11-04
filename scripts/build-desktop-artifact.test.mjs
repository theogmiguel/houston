#!/usr/bin/env node
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

import {
  createBuildConfig,
  DESKTOP_APP_ID,
  DESKTOP_COPYRIGHT,
  DESKTOP_HOMEPAGE,
  DESKTOP_LONG_DESCRIPTION,
  DESKTOP_PUBLISHER,
  DESKTOP_SHORT_DESCRIPTION,
  GITHUB_PUBLISH_CONFIG,
  LINUX_DEB_DEPENDS,
  missingPackagedResources,
  resolveDesktopTargets,
  resolveExtraResources,
  resolveStageDependencies,
} from "./build-desktop-artifact.ts";

const REPO_ROOT = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const BASE_INPUT = {
  version: "0.19.10",
  outputDir: NodePath.join(REPO_ROOT, "release"),
  repoRoot: REPO_ROOT,
  stageAppDir: REPO_ROOT,
};

function buildConfig(platform, target, arch = "x64") {
  return createBuildConfig({ ...BASE_INPUT, platform, target, arch });
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
    "Houston is a local-first mission control for CLI coding agents: a grid of real terminals running your agent CLIs in your own project directories, where an agent can spawn and drive another agent in a new pane.",
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
  NodeAssert.equal(dependencies["@ff-labs/fff-bin-linux-arm64-musl"], "0.11.0");
  NodeAssert.equal(dependencies["@ff-labs/fff-bin-linux-x64-gnu"], undefined);
  NodeAssert.equal(dependencies.effect, undefined);
  NodeAssert.equal(dependencies["@houston-app/shared"], undefined);
});
