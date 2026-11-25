// @effect-diagnostics nodeBuiltinImport:off - drives fake output streams and a real child process.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";

import { describe, expect, it } from "vite-plus/test";

import { guardProcessOutput, type OutputStream } from "./outputGuard.ts";

class FakeStream extends NodeEvents.EventEmitter implements OutputStream {
  readonly lines: Array<string> = [];
  failing: NodeJS.ErrnoException | undefined;
  write(chunk: string): boolean {
    this.lines.push(chunk);
    const failure = this.failing;
    if (failure !== undefined) this.emit("error", failure);
    return true;
  }
}

const errno = (code: string, message = `${code}: /home/someone/private/log`) =>
  Object.assign(new Error(message), { code });

const pair = () => ({ stdout: new FakeStream(), stderr: new FakeStream() });

describe("guardProcessOutput", () => {
  // Linux and Windows codes for a closed reader, a full disk, a failing device and a destroyed stream.
  it.each([
    "EPIPE",
    "ENOSPC",
    "EIO",
    "EDQUOT",
    "EBADF",
    "ECONNRESET",
    "EOF",
    "ERR_STREAM_DESTROYED",
  ])("takes %s on stdout without throwing and reports it once on stderr", (code) => {
    const streams = pair();
    const guard = guardProcessOutput(streams);
    expect(() => streams.stdout.emit("error", errno(code))).not.toThrow();
    expect(() => streams.stdout.emit("error", errno(code))).not.toThrow();
    expect(guard.failures()).toEqual({ stdout: 2, stderr: 0 });
    expect(streams.stderr.lines).toEqual([
      `houston: a write to stdout failed (${code}); later stdout output from this process is dropped\n`,
    ]);
  });

  it("reports a stderr failure on stdout, never naming the error message", () => {
    const streams = pair();
    guardProcessOutput(streams);
    streams.stderr.emit("error", errno("ENOSPC"));
    expect(streams.stdout.lines).toHaveLength(1);
    expect(streams.stdout.lines[0]).toContain("stderr failed (ENOSPC)");
    expect(streams.stdout.lines[0]).not.toContain("/home");
  });

  it("reports a code it cannot vouch for as unknown", () => {
    const streams = pair();
    guardProcessOutput(streams);
    streams.stdout.emit("error", errno("/home/someone"));
    expect(streams.stderr.lines[0]).toContain("(unknown)");
  });

  it("stops when both streams fail, without writing to a failed stream again", () => {
    const streams = pair();
    const guard = guardProcessOutput(streams);
    streams.stderr.failing = errno("ENOSPC");
    streams.stdout.failing = errno("ENOSPC");
    streams.stdout.emit("error", errno("ENOSPC"));
    expect(guard.failures()).toEqual({ stdout: 1, stderr: 1 });
    expect(streams.stderr.lines).toHaveLength(1);
    expect(streams.stdout.lines).toEqual([]);
  });

  it("installs one listener per stream however often it is called", () => {
    const streams = pair();
    const first = guardProcessOutput(streams);
    expect(guardProcessOutput(streams)).toBe(first);
    expect(streams.stdout.listenerCount("error")).toBe(1);
    expect(streams.stderr.listenerCount("error")).toBe(1);
  });
});

const GUARD = new URL("./outputGuard.ts", import.meta.url).href;

function runGuarded(body: string) {
  return NodeChildProcess.spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { guardProcessOutput } = await import(${JSON.stringify(GUARD)});\nguardProcessOutput();\n${body}`,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, windowsHide: true },
  );
}

describe("a guarded process", () => {
  it("keeps running after a failed output write", () => {
    const result = runGuarded(
      `process.stdout.emit("error", Object.assign(new Error("write EIO"), { code: "EIO" }));
       setTimeout(() => { process.stderr.write("still running\\n"); }, 50);`,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("a write to stdout failed (EIO)");
    expect(result.stderr).toContain("still running");
  });

  it("still exits on an unrelated uncaught exception", () => {
    const result = runGuarded(`setTimeout(() => { throw new Error("unrelated failure"); }, 0);`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unrelated failure");
  });

  it("still exits on an error from another stream", () => {
    const result = runGuarded(
      `const { PassThrough } = await import("node:stream");
       new PassThrough().destroy(Object.assign(new Error("other stream"), { code: "ENOSPC" }));`,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("other stream");
  });
});
