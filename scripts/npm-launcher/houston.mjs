#!/usr/bin/env node
// The `houston-app` npm package. Downloads this version's server archive from the GitHub
// Release into <Houston home>/runtime/versions/<version>, verifies it against the release's
// SHA256SUMS, then runs the `houston` executable inside with the given arguments.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const selfPath = fileURLToPath(import.meta.url);
const { version } = JSON.parse(
  fs.readFileSync(path.join(path.dirname(selfPath), "../package.json"), "utf8"),
);

/** The platforms `release-server.yml` builds an archive for. */
export const SUPPORTED_PLATFORM_KEYS = ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"];

export function unsupportedPlatformMessage(key) {
  const windows = key.startsWith("win32-")
    ? "\nOn Windows, start triage from the Houston app instead: open the command palette and choose What went wrong?."
    : "";
  return (
    `no Houston CLI build is available for ${key} (supported: ${SUPPORTED_PLATFORM_KEYS.join(", ")}).` +
    windows
  );
}

/** Mirrors the server's default base directory and its HOUSTON_HOME override. */
export function houstonHome(env = process.env, home = os.homedir()) {
  const raw = (env.HOUSTON_HOME || "").trim();
  if (raw === "") return path.join(home, ".houston", "v2");
  if (raw === "~") return home;
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return path.join(home, raw.slice(2));
  return path.resolve(raw);
}

export function archiveName(key) {
  return `houston-${version}-${key}.tar.gz`;
}

function releaseBase() {
  const base =
    (process.env.HOUSTON_RELEASE_BASE_URL || "").trim() ||
    "https://github.com/theogmiguel/houston/releases/download";
  return `${base.replace(/\/+$/, "")}/v${version}`;
}

async function get(url) {
  const response = await fetch(url);
  if (response.status === 404) {
    throw new Error(
      `${url} does not exist yet. If ${version} was just released, try again in a few minutes.`,
    );
  }
  if (!response.ok) throw new Error(`GET ${url} returned HTTP ${response.status}`);
  return response;
}

/** Downloads `url` to `file` and returns its sha256, showing progress on a terminal. */
async function download(url, file) {
  const response = await get(url);
  const total = Number(response.headers.get("content-length")) || 0;
  const hash = crypto.createHash("sha256");
  const out = fs.openSync(file, "w");
  const tty = process.stderr.isTTY;
  let received = 0;
  let shown = -1;
  try {
    for await (const chunk of response.body) {
      hash.update(chunk);
      fs.writeSync(out, chunk);
      received += chunk.byteLength;
      // Redraw once per percent (or per MB without a length), not per chunk.
      const step = total ? Math.floor((received * 100) / total) : Math.floor(received / 1048576);
      if (tty && step !== shown) {
        shown = step;
        const percent = total ? ` ${step}%` : "";
        process.stderr.write(
          `\r\x1b[2Khouston: downloading Houston ${version}${percent} (${(received / 1048576).toFixed(1)} MB)`,
        );
      }
    }
  } finally {
    fs.closeSync(out);
    if (tty) process.stderr.write("\r\x1b[2K");
  }
  return hash.digest("hex");
}

const isComplete = (dir) => {
  try {
    return fs.readFileSync(path.join(dir, ".install-complete"), "utf8").trim() === version;
  } catch {
    return false;
  }
};

async function install(dir, key) {
  const archive = archiveName(key);
  const base = releaseBase();
  const sums = await (await get(`${base}/SHA256SUMS`)).text();
  const line = sums
    .split(/\r?\n/)
    .map((entry) => /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(entry.trim()))
    .find((match) => match && match[2] === archive);
  if (!line) throw new Error(`SHA256SUMS for v${version} has no entry for ${archive}`);

  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const staging = fs.mkdtempSync(`${dir}.staging-`);
  try {
    const file = path.join(staging, archive);
    const actual = await download(`${base}/${archive}`, file);
    if (actual !== line[1].toLowerCase()) {
      throw new Error(
        `checksum mismatch for ${archive}: expected ${line[1].toLowerCase()}, got ${actual}`,
      );
    }
    const extract = spawnSync("tar", ["-xzf", file, "-C", staging, "--strip-components=1"], {
      stdio: "inherit",
    });
    if (extract.status !== 0) throw new Error(`could not extract ${archive}`);
    fs.rmSync(file);
    const validate = spawnSync(path.join(staging, "houston"), ["--version"], {
      stdio: ["ignore", "ignore", "pipe"],
      encoding: "utf8",
      timeout: 30_000,
      killSignal: "SIGKILL",
    });
    if (validate.status !== 0) {
      throw executableError(
        key,
        validate.error?.message ||
          validate.stderr?.trim() ||
          `--version exited with ${validate.signal || validate.status}`,
      );
    }
    fs.writeFileSync(path.join(staging, ".install-complete"), `${version}\n`);
    publish(staging, dir);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Keeps a complete install another launcher published first; replaces only incomplete ones. */
function publish(staging, dir) {
  try {
    fs.renameSync(staging, dir);
    return;
  } catch (error) {
    if (isComplete(dir)) return;
    if (!fs.existsSync(dir)) throw error;
  }
  const lock = `${dir}.lock`;
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(
      `another houston is installing ${version}. If none is running, delete ${lock} and try again.`,
      { cause: error },
    );
  }
  const stale = `${staging}.stale`;
  try {
    if (isComplete(dir)) return;
    // Move it aside rather than deleting in place, so a peer's rename cannot land inside it.
    fs.renameSync(dir, stale);
    try {
      fs.renameSync(staging, dir);
    } catch (error) {
      if (!isComplete(dir)) throw error;
    }
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
    fs.rmSync(stale, { recursive: true, force: true });
  }
}

function executableError(key, detail) {
  return new Error(
    `could not run Houston ${version} for ${key}: ${detail}` +
      (process.platform === "linux"
        ? "\nThe Linux build requires glibc; musl-based systems such as Alpine are not supported."
        : ""),
  );
}

async function main() {
  const key = `${process.platform}-${process.arch}`;
  if (!SUPPORTED_PLATFORM_KEYS.includes(key)) throw new Error(unsupportedPlatformMessage(key));
  const dir = path.join(houstonHome(), "runtime", "versions", version);
  if (!isComplete(dir)) await install(dir, key);

  // Service IPC and signals must reach the child; a terminal's Ctrl-C already reaches it.
  const ipc = process.send !== undefined;
  const child = spawn(path.join(dir, "houston"), process.argv.slice(2), {
    stdio: ipc ? ["inherit", "inherit", "inherit", "ipc"] : "inherit",
    // The executable lives in the Houston home, so this is how it knows npm launched it.
    env: { ...process.env, HOUSTON_NPM_LAUNCHER_PATH: selfPath },
  });
  if (ipc) {
    process.on("message", (message) => child.connected && child.send(message));
    child.on("message", (message) => process.connected && process.send(message));
    process.on("disconnect", () => child.connected && child.disconnect());
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => (ipc || signal !== "SIGINT") && child.kill(signal));
  }
  child.on("error", (error) => fail(executableError(key, error.message)));
  child.on("exit", (code, signal) =>
    process.exit(code ?? 128 + (os.constants.signals[signal] || 1)),
  );
}

function fail(error) {
  process.stderr.write(`houston: ${error.message}\n`);
  process.exit(1);
}

const invokedDirectly = (() => {
  try {
    return fs.realpathSync(process.argv[1] ?? "") === fs.realpathSync(selfPath);
  } catch {
    return false;
  }
})();
if (invokedDirectly) await main().catch(fail);
