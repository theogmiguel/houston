// @effect-diagnostics nodeBuiltinImport:off - builds and damages transfer files in temporary folders.
// The file format with the real age writer, and files crafted frame by frame: a raw age header with a
// chosen work factor, a Houston 1 tar, hostile names, a flipped byte and a cut stream.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import { Decrypter, Encrypter, generateIdentity, identityToRecipient } from "age-encryption";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  HOUSTON_TRANSFER_LIMITS,
  type HoustonTransferError,
  type HoustonTransferManifest,
} from "@t3tools/contracts/houston/transfer";

import {
  bytesEntry,
  decryptPlaintext,
  encodeFrame,
  MAGIC,
  readFrames,
  readManifest,
  sealPlaintext,
  unpackTransfer,
  writeTransferFile,
} from "./format.ts";

const PASSPHRASE = "format test passphrase 77";

const dirs: Array<string> = [];
const tempDir = () => {
  const dir = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "houston-transfer-format-")),
  );
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const text = (value: string) => new TextEncoder().encode(value);

const baseManifest = (
  entries: ReadonlyArray<{ readonly name: string; readonly bytes: Uint8Array }>,
  patch: Record<string, unknown> = {},
) => ({
  format: 2,
  transferId: "3f0c2a1e-5b7d-4c9e-8a10-2b3c4d5e6f70",
  createdAt: "2026-10-30T12:00:00.000Z",
  sourceOs: "linux",
  houstonVersion: "0.0.0",
  project: { title: "Fixture", root: "/work/fixture", remoteUrl: null },
  checkouts: [
    {
      key: "root",
      path: "/work/fixture",
      branch: "main",
      head: "a".repeat(40),
      bundle: null,
      diff: entries.some((entry) => entry.name === "checkouts/0/tracked.diff")
        ? "checkouts/0/tracked.diff"
        : null,
      untracked: entries
        .filter((entry) => entry.name.startsWith("checkouts/0/untracked/"))
        .map((entry) => entry.name.slice("checkouts/0/untracked/".length)),
      skippedPaths: [],
      archiveDir: "checkouts/0",
    },
  ],
  threads: [],
  skipped: [],
  sections: {},
  counts: { tasks: 0, taskSourceLinks: 0, viewedFiles: 0, attachments: 0 },
  renderer: null,
  entries: entries.map((entry) => ({
    name: entry.name,
    size: entry.bytes.length,
    sha256: sha256(entry.bytes),
  })),
  lineage: [],
  ...patch,
});

/** A file written frame by frame, gzipped and sealed with the real age writer. */
const craft = async (
  frames: ReadonlyArray<Uint8Array>,
  options: { readonly magic?: Uint8Array; readonly workFactor?: number } = {},
) => {
  const plain = Buffer.concat([options.magic ?? MAGIC, ...frames]);
  return sealPlaintext(NodeZlib.gzipSync(plain), PASSPHRASE, options.workFactor ?? 10);
};

const writeFile = (dir: string, name: string, bytes: Uint8Array) => {
  const path = NodePath.join(dir, name);
  NodeFS.writeFileSync(path, bytes);
  return path;
};

const refusalOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as HoustonTransferError;
  }
  throw new Error("expected a refusal");
};

const entriesOf = (files: Readonly<Record<string, string | Uint8Array>>) =>
  Object.entries(files).map(([name, value]) => ({
    name,
    bytes: typeof value === "string" ? text(value) : value,
  }));

/** A small, valid transfer file with the given entries. */
const writeValid = async (
  dir: string,
  files: Readonly<Record<string, string | Uint8Array>> = { "checkouts/0/tracked.diff": "diff\n" },
  options: { readonly workFactor?: number } = {},
) => {
  const entries = entriesOf(files);
  const manifest = baseManifest(entries) as unknown as Omit<HoustonTransferManifest, "entries">;
  const file = NodePath.join(dir, "valid.houston-transfer");
  await writeTransferFile({
    file,
    passphrase: PASSPHRASE,
    manifest,
    entries: entries.map((entry) => bytesEntry(entry.name, entry.bytes)),
    workFactor: options.workFactor ?? 10,
  });
  return file;
};

describe("the envelope is a standard age passphrase file", () => {
  it("the envelope is a standard age passphrase file", async () => {
    const dir = tempDir();
    const file = await writeValid(
      dir,
      { "checkouts/0/tracked.diff": "diff\n" },
      {
        workFactor: HOUSTON_TRANSFER_LIMITS.exportWorkFactor,
      },
    );
    const bytes = NodeFS.readFileSync(file);
    const header = bytes.subarray(0, bytes.indexOf("\n---")).toString("latin1").split("\n");
    expect(header[0]).toBe("age-encryption.org/v1");
    const stanzas = header.filter((line) => line.startsWith("-> "));
    expect(stanzas).toHaveLength(1);
    expect(stanzas[0]!.split(" ")[1]).toBe("scrypt");
    expect(stanzas[0]!.split(" ")[3]).toBe("18");

    // The library's own decryption, given only the passphrase, reads the Houston plaintext.
    const decrypter = new Decrypter();
    decrypter.addPassphrase(PASSPHRASE);
    const plain = NodeZlib.gunzipSync(await decrypter.decrypt(new Uint8Array(bytes)));
    expect(plain.subarray(0, MAGIC.length).toString("latin1")).toBe("HOUSTON-TRANSFER 2\n");
    const frames = readFrames(plain);
    expect(frames.map((frame) => frame.name)).toEqual([
      "manifest.json",
      "checkouts/0/tracked.diff",
    ]);
    expect(Buffer.from(frames[1]!.bytes).toString("utf8")).toBe("diff\n");
  });
});

describe("a file past the size limit is refused naming its largest entries", () => {
  it("a file past the size limit is refused naming its largest entries", async () => {
    const dir = tempDir();
    const files: Record<string, Uint8Array> = {};
    for (let index = 0; index < 12; index += 1) {
      files[`checkouts/0/untracked/file-${index}.bin`] = NodeCrypto.randomBytes(
        4 * 1024 + index * 512,
      );
    }
    const entries = entriesOf(files);
    expect(entries.reduce((sum, entry) => sum + entry.bytes.length, 0)).toBeGreaterThan(80 * 1024);
    const file = NodePath.join(dir, "big.houston-transfer");
    const refusal = await refusalOf(
      writeTransferFile({
        file,
        passphrase: PASSPHRASE,
        manifest: baseManifest(entries) as unknown as Omit<HoustonTransferManifest, "entries">,
        entries: entries.map((entry) => bytesEntry(entry.name, entry.bytes)),
        workFactor: 10,
        limits: { fileBytes: 64 * 1024 },
      }),
    );
    expect(refusal.kind).toBe("too_large");
    expect(refusal.limit).toBe(64 * 1024);
    expect(refusal.problem).toContain("64 KiB");
    const largest = [...entries]
      .toSorted((left, right) => right.bytes.length - left.bytes.length)
      .slice(0, 10);
    expect(refusal.items).toHaveLength(10);
    refusal.items.forEach((item, index) => {
      expect(item).toContain(largest[index]!.name.slice("checkouts/0/untracked/".length));
      expect(item).toContain(largest[index]!.bytes.length.toLocaleString("en-US"));
    });
    expect(refusal.steps.join(" ")).toMatch(/push/i);
    expect(refusal.steps.join(" ")).toMatch(/ignore/i);
    expect(NodeFS.readdirSync(dir)).toEqual([]);
  });
});

describe("a wrong passphrase, a foreign file and an excessive work factor are refused", () => {
  it("a wrong passphrase, a foreign file and an excessive work factor are refused", async () => {
    const dir = tempDir();
    const valid = await writeValid(dir);

    const wrong = await refusalOf(readManifest(valid, "another passphrase 12"));
    expect(wrong.kind).toBe("wrong_passphrase");
    expect(wrong.problem).toBe("The passphrase is wrong or the file is damaged.");

    const textFile = writeFile(dir, "notes.houston-transfer", text("just some notes\n"));
    expect((await refusalOf(readManifest(textFile, PASSPHRASE))).kind).toBe("not_transfer_file");

    const identity = await generateIdentity();
    const encrypter = new Encrypter();
    encrypter.addRecipient(await identityToRecipient(identity));
    const toRecipient = writeFile(
      dir,
      "recipient.houston-transfer",
      await encrypter.encrypt(NodeZlib.gzipSync(MAGIC)),
    );
    expect((await refusalOf(readManifest(toRecipient, PASSPHRASE))).kind).toBe("not_transfer_file");

    const whole = NodeFS.readFileSync(valid);
    const cut = writeFile(dir, "cut.houston-transfer", whole.subarray(0, whole.length / 2));
    expect((await refusalOf(readManifest(cut, PASSPHRASE))).kind).toBe("not_transfer_file");

    // A header asking 2^30: refused before any key is derived.
    const header = whole.subarray(0, whole.indexOf("\n---")).toString("latin1");
    const scrypt = header.split("\n").find((line) => line.startsWith("-> scrypt "))!;
    const raised = Buffer.from(
      whole.toString("latin1").replace(scrypt, scrypt.replace(/ \d+$/, " 30")),
      "latin1",
    );
    const costly = writeFile(dir, "costly.houston-transfer", raised);
    let decryptions = 0;
    const spy = (passphrase: string) => {
      decryptions += 1;
      const decrypter = new Decrypter();
      decrypter.addPassphrase(passphrase);
      return decrypter;
    };
    const refused = await refusalOf(readManifest(costly, PASSPHRASE, { decrypter: spy }));
    expect(refused.kind).toBe("not_transfer_file");
    expect(refused.problem).toContain("2^30");
    expect(refused.problem).toContain("2^20");
    expect(decryptions).toBe(0);

    // The writer's own work factor is read.
    const manifest = await readManifest(valid, PASSPHRASE, { decrypter: spy });
    expect(manifest.format).toBe(2);
    expect(decryptions).toBe(1);
  });
});

describe("a Houston 1 file and an unknown format are refused by name", () => {
  it("a Houston 1 file and an unknown format are refused by name", async () => {
    const dir = tempDir();
    // v1's layout: a gzip tar whose first header names manifest.json, `ustar` at offset 257.
    const tarHeader = Buffer.alloc(512);
    tarHeader.write("manifest.json", 0, "latin1");
    tarHeader.write("ustar  \0", 257, "latin1");
    const v1 = writeFile(
      dir,
      "v1.houston-transfer",
      await sealPlaintext(
        NodeZlib.gzipSync(Buffer.concat([tarHeader, Buffer.alloc(1024)])),
        PASSPHRASE,
        10,
      ),
    );
    const houston1 = await refusalOf(readManifest(v1, PASSPHRASE));
    expect(houston1.kind).toBe("houston1_file");
    expect(houston1.problem).toBe(
      "This file was made by Houston 1, which used terminal panes. This version imports files made by Houston 2.",
    );
    expect(houston1.steps).toEqual([
      "Import it with Houston 1 on this computer, or export the workspace again from Houston 2 on the computer that made it.",
    ]);

    for (const [format, named] of [
      [3, "3"],
      [undefined, "(none)"],
    ] as const) {
      const manifest = { ...baseManifest([]), format };
      const file = writeFile(
        dir,
        `format-${named}.houston-transfer`,
        await craft([encodeFrame("manifest.json", text(JSON.stringify(manifest)))]),
      );
      const refusal = await refusalOf(readManifest(file, PASSPHRASE));
      expect(refusal.kind, named).toBe("unknown_format");
      expect(refusal.problem, named).toContain(named);
      expect(refusal.problem, named).toContain("2");
    }
  });
});

describe("crafted entries are refused before anything is written", () => {
  it("crafted entries are refused before anything is written", async () => {
    const dir = tempDir();
    const parent = NodePath.join(dir, "scratch-parent");
    NodeFS.mkdirSync(parent);
    const diff = NodeCrypto.randomBytes(256 * 1024);
    const good = entriesOf({ "checkouts/0/tracked.diff": diff });
    const manifestFrame = (
      entries: ReadonlyArray<{ name: string; bytes: Uint8Array }>,
      patch = {},
    ) => encodeFrame("manifest.json", text(JSON.stringify(baseManifest(entries, patch))));
    const framesOf = (entries: ReadonlyArray<{ name: string; bytes: Uint8Array }>) =>
      entries.map((entry) => encodeFrame(entry.name, entry.bytes));
    const hostile = (name: string) => {
      const entries = [...good, { name, bytes: text("x") }];
      return [manifestFrame(entries), ...framesOf(entries)];
    };

    const validFile = await craft([manifestFrame(good), ...framesOf(good)]);
    const valid = Buffer.from(validFile);
    const flipped = Buffer.from(valid);
    // Past the first age chunks: the byte lands in tracked.diff's ciphertext.
    flipped[flipped.length - 1_000] = flipped[flipped.length - 1_000]! ^ 0xff;

    const cases: ReadonlyArray<readonly [string, Uint8Array | Promise<Uint8Array>, string]> = [
      [
        "no magic line",
        craft([manifestFrame(good), ...framesOf(good)], { magic: text("HOUSTON\n") }),
        "(the start of the file)",
      ],
      [
        "an entry before the manifest",
        craft([encodeFrame("threads/0/thread.json", text("{}")), manifestFrame(good)]),
        "threads/0/thread.json",
      ],
      [
        "a manifest past 32 MiB",
        craft([
          (() => {
            const frame = encodeFrame("manifest.json", text("{}"));
            const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
            view.setBigUint64(4 + "manifest.json".length, BigInt(32 * 1024 * 1024 + 1));
            return frame;
          })(),
        ]),
        "manifest.json",
      ],
      [
        "a manifest with an unknown field",
        craft([manifestFrame(good, { panes: [] }), ...framesOf(good)]),
        "manifest.json",
      ],
      ["../x", craft(hostile("../x")), "../x"],
      ["/etc/passwd", craft(hostile("/etc/passwd")), "/etc/passwd"],
      ["C:/x", craft(hostile("C:/x")), "C:/x"],
      ["a/.git/config", craft(hostile("a/.git/config")), "a/.git/config"],
      [
        "Readme.md beside README.md",
        (() => {
          const entries = [
            ...good,
            { name: "checkouts/0/untracked/Readme.md", bytes: text("a") },
            { name: "checkouts/0/untracked/README.md", bytes: text("b") },
          ];
          return craft([manifestFrame(entries), ...framesOf(entries)]);
        })(),
        "README.md",
      ],
      [
        "an entry absent from the manifest",
        craft([
          manifestFrame(good),
          ...framesOf([...good, { name: "checkouts/0/untracked/extra.txt", bytes: text("x") }]),
        ]),
        "checkouts/0/untracked/extra.txt",
      ],
      [
        "a manifest entry absent from the file",
        (() => {
          const entries = [...good, { name: "checkouts/0/untracked/gone.txt", bytes: text("x") }];
          return craft([manifestFrame(entries), ...framesOf(good)]);
        })(),
        "checkouts/0/untracked/gone.txt",
      ],
      ["a flipped byte inside tracked.diff", flipped, "checkouts/0/tracked.diff"],
      [
        "the stream cut mid-frame",
        valid.subarray(0, valid.length - 70_000),
        "checkouts/0/tracked.diff",
      ],
    ];
    expect(cases).toHaveLength(13);
    for (const [label, pending, named] of cases) {
      const file = writeFile(dir, "crafted.houston-transfer", await pending);
      const refusal = await refusalOf(
        unpackTransfer(file, PASSPHRASE, NodePath.join(parent, "scratch")),
      );
      expect(refusal.kind, label).toBe("not_transfer_file");
      expect(refusal.problem, label).toBe("The file is damaged or was not made by Houston.");
      expect(refusal.items.join(" "), label).toContain(named);
      expect(NodeFS.readdirSync(parent), label).toEqual([]);
    }

    // The valid file unpacks into its scratch folder.
    const file = writeFile(dir, "valid.houston-transfer", valid);
    const scratch = NodePath.join(parent, "scratch");
    await unpackTransfer(file, PASSPHRASE, scratch);
    expect(NodeFS.readFileSync(NodePath.join(scratch, "checkouts", "0", "tracked.diff"))).toEqual(
      diff,
    );
    NodeFS.rmSync(scratch, { recursive: true });

    // Injected bounds: a fourth entry past an entry limit of 3, a 2 KiB entry past 1 KiB unpacked.
    const four = entriesOf({
      "checkouts/0/untracked/a": "a",
      "checkouts/0/untracked/b": "b",
      "checkouts/0/untracked/c": "c",
      "checkouts/0/untracked/d": "d",
    });
    const countFile = writeFile(
      dir,
      "count.houston-transfer",
      await craft([manifestFrame(four), ...framesOf(four)]),
    );
    const counted = await refusalOf(
      unpackTransfer(countFile, PASSPHRASE, scratch, { limits: { entries: 3 } }),
    );
    expect(counted.kind).toBe("not_transfer_file");
    expect(counted.limit).toBe(3);
    expect(counted.actual).toBe(4);
    const big = entriesOf({ "checkouts/0/untracked/big": NodeCrypto.randomBytes(2 * 1024) });
    const bigFile = writeFile(
      dir,
      "big.houston-transfer",
      await craft([manifestFrame(big), ...framesOf(big)]),
    );
    const sized = await refusalOf(
      unpackTransfer(bigFile, PASSPHRASE, scratch, { limits: { unpackedBytes: 1024 } }),
    );
    expect(sized.kind).toBe("not_transfer_file");
    expect(sized.limit).toBe(1024);
    expect(NodeFS.readdirSync(parent)).toEqual([]);
  });

  it("an untracked path through the NTFS short name of .git is refused", async () => {
    const dir = tempDir();
    const parent = NodePath.join(dir, "scratch-parent");
    NodeFS.mkdirSync(parent);
    const name = "checkouts/0/untracked/GIT~1/hooks/pre-commit";
    const entries = entriesOf({ [name]: "#!/bin/sh\n" });
    const file = writeFile(
      dir,
      "short-name.houston-transfer",
      await craft([
        encodeFrame("manifest.json", text(JSON.stringify(baseManifest(entries)))),
        ...entries.map((entry) => encodeFrame(entry.name, entry.bytes)),
      ]),
    );
    const refusal = await refusalOf(
      unpackTransfer(file, PASSPHRASE, NodePath.join(parent, "scratch")),
    );
    expect(refusal.kind).toBe("not_transfer_file");
    expect(refusal.items.join(" ")).toContain("GIT~1");
    expect(NodeFS.readdirSync(parent)).toEqual([]);
  });
});

describe("frames decode as they were written", () => {
  it("a decrypted file lists its frames in order", async () => {
    const dir = tempDir();
    const file = await writeValid(dir, {
      "checkouts/0/tracked.diff": "diff\n",
      "checkouts/0/untracked/a b.txt": "spaces\n",
    });
    const plain = await decryptPlaintext(file, PASSPHRASE);
    expect(readFrames(plain).map((frame) => frame.name)).toEqual([
      "manifest.json",
      "checkouts/0/tracked.diff",
      "checkouts/0/untracked/a b.txt",
    ]);
  });
});
