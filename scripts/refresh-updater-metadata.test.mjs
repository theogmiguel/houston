#!/usr/bin/env node
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

import { refresh } from "./refresh-updater-metadata.mjs";

const REPO_ROOT = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

function sha512(content) {
  return NodeCrypto.createHash("sha512").update(content).digest("base64");
}

async function fixture() {
  const directory = await NodeFS.promises.mkdtemp(
    NodePath.join(REPO_ROOT, "release-metadata-test-"),
  );
  const installer = Buffer.from("signed installer bytes");
  await NodeFS.promises.writeFile(
    NodePath.join(directory, "Houston-1.2.3-x64-setup.exe"),
    installer,
  );
  const metadata = [
    "version: 1.2.3",
    "files:",
    "  - url: Houston-1.2.3-x64-setup.exe",
    "    sha512: stale",
    "    size: 1",
    "path: Houston-1.2.3-x64-setup.exe",
    "sha512: stale",
    "releaseDate: '2026-09-16T00:00:00.000Z'",
    "",
  ].join("\n");
  const metadataPath = NodePath.join(directory, "latest.yml");
  await NodeFS.promises.writeFile(metadataPath, metadata);
  return { directory, installer, metadataPath };
}

NodeTest.test("a signed installer's hash and size replace the stale values", async () => {
  const { directory, installer, metadataPath } = await fixture();
  try {
    const changed = await refresh(directory);
    const written = NodeFS.readFileSync(metadataPath, "utf8");
    NodeAssert.deepEqual(changed, ["latest.yml"]);
    NodeAssert.equal(
      written.match(/sha512: .*/g).length,
      2,
      "the file entry and the top-level path both carry the new hash",
    );
    NodeAssert.match(
      written,
      new RegExp(`sha512: ${sha512(installer).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
    NodeAssert.match(written, new RegExp(`size: ${installer.length}`));
    NodeAssert.match(written, /releaseDate: '2026-09-16T00:00:00\.000Z'/);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

NodeTest.test("check mode refuses stale metadata and names the field", async () => {
  const { directory } = await fixture();
  try {
    await NodeAssert.rejects(() => refresh(directory, { check: true }), /sha512 is stale/);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

NodeTest.test("metadata naming a missing artifact fails with its name", async () => {
  const { directory } = await fixture();
  try {
    NodeFS.rmSync(NodePath.join(directory, "Houston-1.2.3-x64-setup.exe"));
    await NodeAssert.rejects(() => refresh(directory), /Houston-1\.2\.3-x64-setup\.exe/);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
