// @effect-diagnostics nodeBuiltinImport:off - appends to real files in a temporary directory.
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { appendOutput, isRegularFile, type WriteOutput } from "./serviceOutput.ts";

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

const directories: Array<string> = [];
afterEach(() => {
  for (const dir of directories.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

describe("appendOutput", () => {
  it("keeps reading while a write never calls back, and holds only up to the bound", () => {
    const source = new NodeEvents.EventEmitter();
    const disk = stalledDisk();
    const appender = appendOutput(source, 1, { write: disk.write, maxPendingBytes: 14 });

    source.emit("data", Buffer.from("first\n"));
    for (const line of ["held-1\n", "drop-it\n", "held-2"]) source.emit("data", Buffer.from(line));

    // The writer behind the source returned at once each time; one write is outstanding.
    expect(disk.calls.map((call) => call.text)).toEqual(["first\n"]);
    expect(appender.droppedBytes()).toBe("drop-it\n".length);

    ok(disk.calls[0]!);
    expect(disk.calls[1]!.text).toBe(
      "houston: 8 bytes of server output were dropped while this log could not be written\nheld-1\nheld-2",
    );
    ok(disk.calls[1]!);
    source.emit("data", Buffer.from("later\n"));
    expect(disk.calls[2]!.text).toBe("later\n");
  });

  it("drops output a failed write could not store, reports once by code, and resumes", () => {
    const source = new NodeEvents.EventEmitter();
    const disk = stalledDisk();
    const reports: Array<string> = [];
    const appender = appendOutput(source, 1, {
      write: disk.write,
      report: (line) => reports.push(line),
    });

    source.emit("data", Buffer.from("lost-1\n"));
    disk.calls[0]!.done(errno("ENOSPC"), 0);
    source.emit("data", Buffer.from("lost-2\n"));
    disk.calls[1]!.done(errno("EIO"), 0);

    expect(appender.droppedBytes()).toBe(14);
    expect(reports).toEqual([
      "houston: appending server output to the service log failed (ENOSPC); output is dropped until a write succeeds\n",
    ]);
    expect(reports.join("")).not.toContain("/home");

    source.emit("data", Buffer.from("back\n"));
    expect(disk.calls[2]!.text).toBe(
      "houston: 14 bytes of server output were dropped while this log could not be written\nback\n",
    );
    ok(disk.calls[2]!);
    source.emit("data", Buffer.from("after\n"));
    expect(disk.calls[3]!.text).toBe("after\n");
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
