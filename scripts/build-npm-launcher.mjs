#!/usr/bin/env node
// Builds the `houston-app` npm launcher: <output-dir>/houston-app/ and a publishable
// <output-dir>/houston-app.tgz. The launcher downloads the server archive from the GitHub Release.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const SCRIPTS_DIR = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const REPO_ROOT = NodePath.join(SCRIPTS_DIR, "..");

export const NPM_LAUNCHER_PACKAGE_NAME = "houston-app";

/** `houston.databaseMigration` is read back by the server's npm release lookup. */
export function npmLauncherPackageManifest(version, databaseMigration) {
  const server = JSON.parse(
    NodeFS.readFileSync(NodePath.join(REPO_ROOT, "apps/server/package.json"), "utf8"),
  );
  return {
    name: NPM_LAUNCHER_PACKAGE_NAME,
    version,
    description:
      "Houston CLI. Downloads this platform's server executable from the GitHub Release and runs it.",
    license: server.license,
    repository: server.repository,
    bin: { houston: "./bin/houston.mjs" },
    files: ["bin"],
    // The launcher uses the global fetch and import.meta.url only.
    engines: { node: ">=20.11" },
    houston: { databaseMigration },
  };
}

/** Highest server migration id, from the `NNN_Name.ts` files the server registers. */
export function latestServerMigrationId() {
  const dir = NodePath.join(REPO_ROOT, "apps/server/src/persistence/Migrations");
  const ids = NodeFS.readdirSync(dir).flatMap((name) => {
    const id = /^(\d+)_\w+\.ts$/.exec(name)?.[1];
    return id === undefined ? [] : [Number(id)];
  });
  return Math.max(0, ...ids);
}

export async function buildNpmLauncher({ version, outputDir }) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(
      `--version must be an exact semver such as 1.2.3, got ${JSON.stringify(version)}`,
    );
  }
  await NodeFS.promises.mkdir(outputDir, { recursive: true });
  const scratch = await NodeFS.promises.mkdtemp(NodePath.join(outputDir, ".launcher-"));
  try {
    const stageDir = NodePath.join(scratch, "package");
    await NodeFS.promises.mkdir(NodePath.join(stageDir, "bin"), { recursive: true });
    await NodeFS.promises.writeFile(
      NodePath.join(stageDir, "package.json"),
      `${JSON.stringify(npmLauncherPackageManifest(version, latestServerMigrationId()), null, 2)}\n`,
    );
    const bin = NodePath.join(stageDir, "bin/houston.mjs");
    await NodeFS.promises.copyFile(NodePath.join(SCRIPTS_DIR, "npm-launcher/houston.mjs"), bin);
    await NodeFS.promises.chmod(bin, 0o755);
    await NodeFS.promises.copyFile(
      NodePath.join(REPO_ROOT, "apps/server/README.md"),
      NodePath.join(stageDir, "README.md"),
    );

    const packageDir = NodePath.join(outputDir, NPM_LAUNCHER_PACKAGE_NAME);
    const tarball = NodePath.join(outputDir, `${NPM_LAUNCHER_PACKAGE_NAME}.tgz`);
    await NodeFS.promises.rm(tarball, { force: true });
    // npm tarballs root everything under `package/`.
    const tar = NodeChildProcess.spawnSync("tar", ["-czf", tarball, "-C", scratch, "package"], {
      stdio: "inherit",
    });
    if (tar.status !== 0) throw new Error(`tar exited with ${tar.status} writing ${tarball}`);
    await NodeFS.promises.rm(packageDir, { recursive: true, force: true });
    await NodeFS.promises.rename(stageDir, packageDir);
    return { packageDir, tarball };
  } finally {
    await NodeFS.promises.rm(scratch, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  NodeFS.realpathSync(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const { values } = NodeUtil.parseArgs({
    options: {
      version: { type: "string" },
      "output-dir": { type: "string", default: "npm-packages" },
    },
  });
  if (values.version === undefined) {
    process.stderr.write("build-npm-launcher: --version <exact release version> is required\n");
    process.exit(1);
  }
  const { packageDir, tarball } = await buildNpmLauncher({
    version: values.version,
    outputDir: NodePath.resolve(values["output-dir"]),
  });
  process.stdout.write(`[npm-launcher] Wrote ${packageDir} and ${tarball}\n`);
}
