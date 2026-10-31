import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  HOUSTON_TRANSFER_LIMITS,
  HoustonTransferExportInput,
  HoustonTransferStage,
  decodeHoustonTransferManifest,
} from "./transfer.ts";

// As the RPC decodes a request: from its JSON form.
const decodeExport = Schema.decodeUnknownSync(Schema.toCodecJson(HoustonTransferExportInput));

const PASSPHRASE = "correct horse transfer 4c1e";

const manifest = (patch: Record<string, unknown> = {}) => ({
  format: 2,
  transferId: "3f0c2a1e-5b7d-4c9e-8a10-2b3c4d5e6f70",
  createdAt: "2026-10-30T12:00:00.000Z",
  sourceOs: "linux",
  houstonVersion: "0.19.10",
  project: { title: "Houston", root: "/work/houston", remoteUrl: "https://github.com/o/r.git" },
  checkouts: [
    {
      key: "root",
      path: "/work/houston",
      branch: "main",
      head: "a".repeat(40),
      bundle: "checkouts/0/head.bundle",
      diff: "checkouts/0/tracked.diff",
      untracked: ["notes.txt"],
      skippedPaths: ["link"],
      archiveDir: "checkouts/0",
    },
    {
      key: "worktree:1",
      path: "/state/worktrees/r/feature",
      branch: null,
      head: "b".repeat(40),
      bundle: null,
      diff: null,
      untracked: [],
      skippedPaths: [],
      archiveDir: "checkouts/1",
    },
  ],
  threads: [
    {
      sourceId: "thread-1",
      title: "Fix the parser",
      provider: "codex",
      checkout: "root",
      relCwd: "",
      archiveDir: "threads/0",
      attachments: ["threads/0/attachments/image-1"],
    },
  ],
  skipped: [{ threadId: "thread-2", title: "Elsewhere", reason: "outside" }],
  sections: { tasks: { version: 1, archivePath: "sections/tasks.json" } },
  counts: { tasks: 1, taskSourceLinks: 0, viewedFiles: 0, attachments: 1 },
  renderer: null,
  entries: [{ name: "checkouts/0/head.bundle", size: 10, sha256: "c".repeat(64) }],
  lineage: [
    { transferId: "1f0c2a1e-5b7d-4c9e-8a10-2b3c4d5e6f70", exportedAt: "2026-10-29T12:00:00.000Z" },
  ],
  ...patch,
});

const decodes = (value: unknown) => decodeHoustonTransferManifest(value)._tag === "Success";

describe("transfer limits are the documented values", () => {
  it("transfer limits are the documented values", () => {
    expect(HOUSTON_TRANSFER_LIMITS.fileBytes).toBe(209_715_200);
    expect(HOUSTON_TRANSFER_LIMITS.unpackedBytes).toBe(4_294_967_296);
    expect(HOUSTON_TRANSFER_LIMITS.manifestBytes).toBe(33_554_432);
    expect(HOUSTON_TRANSFER_LIMITS.entries).toBe(100_000);
    expect(HOUSTON_TRANSFER_LIMITS.rendererBytes).toBe(1_048_576);
    expect(HOUSTON_TRANSFER_LIMITS.passphraseMinCharacters).toBe(12);
    expect(HOUSTON_TRANSFER_LIMITS.passphraseMaxBytes).toBe(1_024);
    expect(HOUSTON_TRANSFER_LIMITS.exportWorkFactor).toBe(18);
    expect(HOUSTON_TRANSFER_LIMITS.maxWorkFactor).toBe(20);
  });
});

describe("transfer schemas bound their fields and redact the passphrase", () => {
  it("a manifest with every field decodes", () => {
    expect(decodes(manifest())).toBe(true);
  });

  it("a format 1 manifest, an unknown field and a malformed key or folder are refused", () => {
    expect(decodes(manifest({ format: 1 }))).toBe(false);
    expect(decodes(manifest({ format: 3 }))).toBe(false);
    expect(decodes({ ...manifest(), panes: [] })).toBe(false);
    const [thread] = manifest().threads;
    for (const archiveDir of ["transcripts/0", "threads/../x", "threads/", "threads/0/x", "../0"]) {
      expect(decodes(manifest({ threads: [{ ...thread, archiveDir }] })), archiveDir).toBe(false);
    }
    expect(decodes(manifest({ threads: [{ ...thread, surprise: true }] }))).toBe(false);
    const [checkout] = manifest().checkouts;
    for (const key of ["main", "worktree:", "worktree:a", "Root", "worktree:1/x"]) {
      expect(decodes(manifest({ checkouts: [{ ...checkout, key }] })), key).toBe(false);
    }
    for (const archiveDir of ["checkouts/x", "threads/0", "checkouts/0/.."]) {
      expect(decodes(manifest({ checkouts: [{ ...checkout, archiveDir }] })), archiveDir).toBe(
        false,
      );
    }
    expect(decodes(manifest({ sourceOs: "darwin" }))).toBe(false);
    expect(decodes(manifest({ transferId: "not-a-uuid" }))).toBe(false);
    expect(decodes(manifest({ entries: [{ name: "a", size: -1, sha256: "c".repeat(64) }] }))).toBe(
      false,
    );
    expect(decodes(manifest({ entries: [{ name: "a", size: 1, sha256: "C".repeat(63) }] }))).toBe(
      false,
    );
  });

  it("the stages are the eight the surface names", () => {
    const decode = Schema.decodeUnknownExit(HoustonTransferStage);
    for (const stage of [
      "checking",
      "packing",
      "decrypting",
      "restoring_code",
      "importing_threads",
      "placing_conversations",
      "done",
      "undoing",
    ]) {
      expect(decode(stage)._tag, stage).toBe("Success");
    }
    expect(decode("unpacking")._tag).toBe("Failure");
  });

  it("the decoded export input prints the passphrase as <redacted>", () => {
    const input = decodeExport({
      projectId: "p",
      destination: "/tmp/move",
      passphrase: PASSPHRASE,
      overwrite: true,
    });
    expect(Redacted.value(input.passphrase)).toBe(PASSPHRASE);
    expect(String(input.passphrase)).toBe("<redacted>");
    expect(JSON.stringify(input)).not.toContain(PASSPHRASE);
    expect(`${JSON.stringify(input.passphrase)} ${String(input)}`).not.toContain(PASSPHRASE);
  });
});
