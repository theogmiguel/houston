// @effect-diagnostics nodeBuiltinImport:off - the service launcher runs without Effect.
import * as NodeFS from "node:fs";

import { outputErrorCode } from "./outputGuard.ts";

// Output a stalled disk leaves unwritten is held up to this bound and dropped beyond it, so a
// server that keeps logging cannot grow the launcher's memory; a few minutes of debug logging.
export const MAX_PENDING_OUTPUT_BYTES = 8 * 1024 * 1024;

export type WriteOutput = (
  fd: number,
  buffer: Buffer,
  callback: (error: NodeJS.ErrnoException | null, written: number) => void,
) => void;

/** The part of a child's stdout or stderr pipe the appender reads. */
export interface OutputSource {
  on(event: "data", listener: (data: Buffer | string) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface OutputAppender {
  /** Bytes of the source's output that were never written. */
  readonly droppedBytes: () => number;
}

/** True when `fd` is a regular file, which Node writes synchronously. */
export function isRegularFile(fd: number): boolean {
  try {
    return NodeFS.fstatSync(fd).isFile();
  } catch {
    return false;
  }
}

// Reads `source` as fast as it arrives and appends it to `fd` with asynchronous writes, so the
// writer behind `source` never waits on the disk. A failed write drops that output; the first
// failure is reported once, and the next successful write starts with a line counting the drops.
export function appendOutput(
  source: OutputSource,
  fd: number,
  options: {
    readonly write?: WriteOutput;
    readonly report?: (line: string) => void;
    readonly maxPendingBytes?: number;
  } = {},
): OutputAppender {
  const write: WriteOutput =
    options.write ?? ((target, buffer, done) => NodeFS.write(target, buffer, done));
  const report = options.report ?? ((line: string) => void process.stderr.write(line));
  const maxPendingBytes = options.maxPendingBytes ?? MAX_PENDING_OUTPUT_BYTES;
  let pending: Array<Buffer> = [];
  let pendingBytes = 0;
  let writing = false;
  let droppedBytes = 0;
  let unannouncedDrops = 0;
  let failureReported = false;

  const drop = (bytes: number) => {
    droppedBytes += bytes;
    unannouncedDrops += bytes;
  };

  const flush = (): void => {
    writing = pending.length > 0;
    if (!writing) return;
    const output = Buffer.concat(pending, pendingBytes);
    pending = [];
    pendingBytes = 0;
    const announced = unannouncedDrops;
    const notice =
      announced === 0
        ? undefined
        : Buffer.from(
            `houston: ${announced} bytes of server output were dropped while this log could not be written\n`,
          );
    const chunk = notice === undefined ? output : Buffer.concat([notice, output]);
    write(fd, chunk, (error, written) => {
      if (error !== null) {
        drop(output.length);
        if (!failureReported) {
          failureReported = true;
          try {
            report(
              `houston: appending server output to the service log failed (${outputErrorCode(error)}); output is dropped until a write succeeds\n`,
            );
          } catch {
            // The launcher's own output guard takes a failure of the report itself.
          }
        }
      } else {
        unannouncedDrops -= announced;
        failureReported = false;
        const unwritten = chunk.length - written;
        if (unwritten > 0) {
          const rest = chunk.subarray(written);
          pending.unshift(rest);
          pendingBytes += rest.length;
        }
      }
      flush();
    });
  };

  source.on("data", (data: Buffer | string) => {
    const chunk = typeof data === "string" ? Buffer.from(data) : data;
    if (pendingBytes + chunk.length > maxPendingBytes) {
      drop(chunk.length);
      return;
    }
    pending.push(chunk);
    pendingBytes += chunk.length;
    if (!writing) flush();
  });
  // A read error ends the child's output, not the launcher.
  source.on("error", () => undefined);
  return { droppedBytes: () => droppedBytes };
}
