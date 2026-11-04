#!/usr/bin/env node
// Rewrites electron-updater's latest*.yml hashes after a step that changes an
// artifact's bytes, such as Authenticode signing. Without this the feed names a
// sha512 the downloaded file no longer has, and the updater refuses it.

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

const METADATA_NAME = /^latest(?:-[A-Za-z0-9]+)?\.ya?ml$/;
const ENTRY_PATTERN = /^(\s*)- url:\s*(.+?)\s*$/;
const HASH_PATTERN = /^(\s*)sha512:\s*(.*?)\s*$/;
const SIZE_PATTERN = /^(\s*)size:\s*(.*?)\s*$/;
const PATH_PATTERN = /^path:\s*(.+?)\s*$/;

async function describe(directory, name) {
  const file = NodePath.join(directory, name);
  let stat;
  try {
    stat = await NodeFS.promises.stat(file);
  } catch {
    throw new Error(`updater metadata references ${name}, which is not in ${directory}`);
  }
  const hash = NodeCrypto.createHash("sha512");
  hash.update(await NodeFS.promises.readFile(file));
  return { sha512: hash.digest("base64"), size: String(stat.size) };
}

async function refreshFile(directory, metadataPath, check) {
  const lines = (await NodeFS.promises.readFile(metadataPath, "utf8")).split("\n");
  const pending = [];
  let current = null;
  let topLevel = null;

  lines.forEach((line, index) => {
    const entry = ENTRY_PATTERN.exec(line);
    if (entry !== null) {
      current = { url: entry[2], hashIndex: null, sizeIndex: null };
      pending.push(current);
      return;
    }
    const path = PATH_PATTERN.exec(line);
    if (path !== null) {
      topLevel = { url: path[1], hashIndex: null };
      pending.push(topLevel);
      return;
    }
    const hash = HASH_PATTERN.exec(line);
    if (hash !== null) {
      if (hash[1].length === 0) {
        if (topLevel !== null) topLevel.hashIndex = index;
        return;
      }
      if (current !== null) current.hashIndex = index;
      return;
    }
    const size = SIZE_PATTERN.exec(line);
    if (size !== null && current !== null) current.sizeIndex = index;
  });

  const mismatch = [];
  for (const target of pending) {
    const actual = await describe(directory, target.url);
    if (target.hashIndex !== null) {
      const found = HASH_PATTERN.exec(lines[target.hashIndex])?.[2] ?? "";
      if (found !== actual.sha512) {
        mismatch.push(
          `${target.url}: sha512 is ${found || "<missing>"}, expected ${actual.sha512}`,
        );
        lines[target.hashIndex] = `    sha512: ${actual.sha512}`;
      }
    }
    if (target.sizeIndex !== null) {
      const found = SIZE_PATTERN.exec(lines[target.sizeIndex])?.[2] ?? "";
      if (found !== actual.size) {
        mismatch.push(`${target.url}: size is ${found || "<missing>"}, expected ${actual.size}`);
        lines[target.sizeIndex] = `    size: ${actual.size}`;
      }
    }
  }

  if (mismatch.length > 0) {
    if (check) {
      throw new Error(
        `${NodePath.basename(metadataPath)} does not match its artifacts: ${mismatch.join("; ")}`,
      );
    }
    await NodeFS.promises.writeFile(metadataPath, lines.join("\n"));
  }
  return mismatch;
}

export async function refresh(directory, options = {}) {
  const entries = await NodeFS.promises.readdir(directory, { withFileTypes: true });
  const changed = [];
  for (const entry of entries) {
    if (!entry.isFile() || !METADATA_NAME.test(entry.name)) continue;
    const mismatch = await refreshFile(
      directory,
      NodePath.join(directory, entry.name),
      options.check === true,
    );
    if (mismatch.length > 0) changed.push(entry.name);
  }
  return changed;
}

async function main(argv) {
  const args = new Set(argv);
  const directory = argv.find((argument) => !argument.startsWith("--"));
  if (directory === undefined) {
    throw new Error("usage: refresh-updater-metadata.mjs <artifacts-dir> [--check]");
  }
  const changed = await refresh(directory, { check: args.has("--check") });
  if (args.has("--check")) {
    console.log(`updater metadata matches its artifacts in ${directory}`);
  } else if (changed.length > 0) {
    console.log(`refreshed ${changed.join(", ")} in ${directory}`);
  } else {
    console.log(`updater metadata already matches its artifacts in ${directory}`);
  }
}

if (
  NodeProcess.argv[1] !== undefined &&
  NodeURL.pathToFileURL(NodeProcess.argv[1]).href === import.meta.url
) {
  main(NodeProcess.argv.slice(2)).catch((error) => {
    console.error(
      `[refresh-updater-metadata] ${error instanceof Error ? error.message : String(error)}`,
    );
    NodeProcess.exitCode = 1;
  });
}
