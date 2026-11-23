// @effect-diagnostics nodeBuiltinImport:off - appends to real files in a temporary directory.
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { guardProcessOutput } from "./outputGuard.ts";
import { appendOutput, appendTargets, isRegularFile, type WriteOutput } from "./serviceOutput.ts";

type Done = Parameters<WriteOutput>[2];

/** A disk whose writes complete only when the test says so. */
function stalledDisk() {
  const calls: Array<{ readonly text: string; readonly done: Done }> = [];
  const write: WriteOutput = (_fd, buffer, done) => calls.push({ text: buffer.toString(), done });
  return { calls, write };
}

const ok = (call: { readonly text: string; readonly done: Done }) =>
  call.done(null, Buffer.byteLength(call.text));
const errno = (code: string) => Object.assign(new Error(`${code}: /home/someone/log`), { code });
const EPOCH = "1970-01-01T00:00:00.000Z";

const directories: Array<string> = [];
afterEach(() => {
  for (const dir of directories.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

describe("appendOutput", () => {
  it("keeps reading while a write never calls back, and holds only up to the bound", () => {
    const source = new NodeEvents.EventEmitter();
    const disk = stalledDisk();
    const appender = appendOutput(source, 1, {
      write: disk.write,
      maxPendingBytes: 14,
      now: () => 0,
    });

    source.emit("data", Buffer.from("first\n"));
    for (const line of ["held-1\n", "drop-it\n", "held-2"]) source.emit("data", Buffer.from(line));

    // The writer behind the source returned at once each time; one write is outstanding.
    expect(disk.calls.map((call) => call.text)).toEqual(["first\n"]);
    expect(appender.droppedBytes()).toBe("drop-it\n".length);

    ok(disk.calls[0]!);
    expect(disk.calls[1]!.text).toBe(
      `houston: 8 bytes of server stdout were dropped from this log since ${EPOCH} (more than 14 bytes waiting)\nheld-1\nheld-2`,
    );
    ok(disk.calls[1]!);
    source.emit("data", Buffer.from("later\n"));
    expect(disk.calls[2]!.text).toBe("later\n");
  });

  it("drops output a failed write could not store and records the outage once it resumes", () => {
    const source = new NodeEvents.EventEmitter();
    const disk = stalledDisk();
    let clock = 5_000;
    const appender = appendOutput(source, 2, {
      name: "stderr",
      write: disk.write,
      now: () => clock,
    });

    source.emit("data", Buffer.from("lost-1\n"));
    disk.calls[0]!.done(errno("ENOSPC"), 0);
    clock = 9_000;
    source.emit("data", Buffer.from("lost-2\n"));
    disk.calls[1]!.done(errno("EIO"), 0);
    expect(appender.droppedBytes()).toBe(14);

    source.emit("data", Buffer.from("back\n"));
    const notice = disk.calls[2]!.text;
    expect(notice).toBe(
      `houston: 14 bytes of server stderr were dropped from this log since 1970-01-01T00:00:05.000Z (ENOSPC)\nback\n`,
    );
    expect(notice).not.toContain("/home");
    ok(disk.calls[2]!);
    source.emit("data", Buffer.from("after\n"));
    expect(disk.calls[3]!.text).toBe("after\n");
  });

  it("leaves the launcher's stderr alone when both streams share the failing log", async () => {
    // One service log behind fd 1 and fd 2, as a service manager sets it up.
    let full = true;
    let log = "";
    const shared: WriteOutput = (_fd, buffer, done) => {
      if (full) return done(errno("ENOSPC"), 0);
      log += buffer.toString();
      done(null, buffer.length);
    };
    const launcherStderr = new NodeStream.Writable({
      write: (chunk: Buffer, _encoding, done) =>
        shared(2, chunk, (error) => done(error ?? undefined)),
    });
    guardProcessOutput({ stdout: new NodeStream.PassThrough(), stderr: launcherStderr });
    const processStderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const childStdout = new NodeEvents.EventEmitter();
      const childStderr = new NodeEvents.EventEmitter();
      appendOutput(childStdout, 1, { name: "stdout", write: shared, now: () => 0 });
      appendOutput(childStderr, 2, { name: "stderr", write: shared, now: () => 0 });

      childStdout.emit("data", Buffer.from("out during outage\n"));
      childStderr.emit("data", Buffer.from("err during outage\n"));
      childStdout.emit("data", Buffer.from("more\n"));
      expect(processStderr).not.toHaveBeenCalled();

      full = false;
      const delivered = Promise.withResolvers<void>();
      launcherStderr.write("[service-launcher] later message\n", () => delivered.resolve());
      await delivered.promise;
      childStdout.emit("data", Buffer.from("out after\n"));
      childStderr.emit("data", Buffer.from("err after\n"));
      childStdout.emit("data", Buffer.from("out later\n"));

      expect(processStderr).not.toHaveBeenCalled();
      expect(launcherStderr.destroyed).toBe(false);
      expect(log).toBe(
        "[service-launcher] later message\n" +
          `houston: 23 bytes of server stdout were dropped from this log since ${EPOCH} (ENOSPC)\nout after\n` +
          `houston: 18 bytes of server stderr were dropped from this log since ${EPOCH} (ENOSPC)\nerr after\n` +
          "out later\n",
      );
    } finally {
      processStderr.mockRestore();
    }
  });

  it("writes the rest of a short write before newer output", () => {
    const source = new NodeEvents.EventEmitter();
    const disk = stalledDisk();
    appendOutput(source, 1, { write: disk.write });
    source.emit("data", Buffer.from("abcdef"));
    source.emit("data", Buffer.from("gh"));
    disk.calls[0]!.done(null, 2);
    expect(disk.calls[1]!.text).toBe("cdefgh");
  });

  it("appends a child's output to a regular file in order", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "houston-service-output-"));
    directories.push(dir);
    const file = NodePath.join(dir, "service.log");
    NodeFS.writeFileSync(file, "existing\n");
    const fd = NodeFS.openSync(file, "a");
    try {
      expect(isRegularFile(fd)).toBe(true);
      const source = new NodeEvents.EventEmitter();
      const written = Promise.withResolvers<void>();
      let total = 0;
      appendOutput(source, fd, {
        write: (target, buffer, done) =>
          NodeFS.write(target, buffer, (error, bytes) => {
            total += bytes;
            done(error, bytes);
            if (total === "one\ntwo\n".length) written.resolve();
          }),
      });
      source.emit("data", Buffer.from("one\n"));
      source.emit("data", "two\n");
      await written.promise;
      expect(NodeFS.readFileSync(file, "utf8")).toBe("existing\none\ntwo\n");
    } finally {
      NodeFS.closeSync(fd);
    }
  });

  it("does not take a pipe or a closed descriptor for a regular file", () => {
    expect(isRegularFile(-1)).toBe(false);
  });
});

describe("appendTargets", () => {
  it("appends only the streams that are regular files", () => {
    expect(appendTargets(() => true)).toEqual({ stdout: 1, stderr: 2 });
    expect(appendTargets((fd) => fd === 1)).toEqual({ stdout: 1 });
    expect(appendTargets((fd) => fd === 2)).toEqual({ stderr: 2 });
    expect(appendTargets(() => false)).toEqual({});
  });
});
