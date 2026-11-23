// @effect-diagnostics nodeBuiltinImport:off globalDate:off - the service launcher runs without Effect.
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

/** The descriptors `main` hands the service child's output to: those that are regular files. */
export function appendTargets(isFile: (fd: number) => boolean = isRegularFile): {
  readonly stdout?: number;
  readonly stderr?: number;
} {
  return { ...(isFile(1) ? { stdout: 1 } : {}), ...(isFile(2) ? { stderr: 2 } : {}) };
}

// Reads `source` as fast as it arrives and appends it to `fd` with asynchronous writes, so the
// writer behind `source` never waits on the disk. Output that cannot be written is dropped and
// counted; the next successful write starts with one line saying how much, since when and why.
export function appendOutput(
  source: OutputSource,
  fd: number,
  options: {
    readonly name?: "stdout" | "stderr";
    readonly write?: WriteOutput;
    readonly maxPendingBytes?: number;
    readonly now?: () => number;
  } = {},
): OutputAppender {
  const name = options.name ?? "stdout";
  const write: WriteOutput =
    options.write ?? ((target, buffer, done) => NodeFS.write(target, buffer, done));
  const maxPendingBytes = options.maxPendingBytes ?? MAX_PENDING_OUTPUT_BYTES;
  const now = options.now ?? Date.now;
  let pending: Array<Buffer> = [];
  let pendingBytes = 0;
  let writing = false;
  let droppedBytes = 0;
  // The outage not yet recorded in the log. Nothing is written elsewhere: under a service
  // manager stderr is usually this same file, and a failed write would destroy that stream.
  let outage: { bytes: number; readonly since: number; readonly reason: string } | undefined;

  const drop = (bytes: number, reason: string) => {
    droppedBytes += bytes;
    outage = {
      bytes: (outage?.bytes ?? 0) + bytes,
      since: outage?.since ?? now(),
      reason: outage?.reason ?? reason,
    };
  };

  const flush = (): void => {
    writing = pending.length > 0;
    if (!writing) return;
    const output = Buffer.concat(pending, pendingBytes);
    pending = [];
    pendingBytes = 0;
    const announced = outage;
    const notice =
      announced === undefined
        ? undefined
        : Buffer.from(
            `houston: ${announced.bytes} bytes of server ${name} were dropped from this log since ${new Date(announced.since).toISOString()} (${announced.reason})\n`,
          );
    const chunk = notice === undefined ? output : Buffer.concat([notice, output]);
    write(fd, chunk, (error, written) => {
      if (error !== null) {
        drop(output.length, outputErrorCode(error));
      } else {
        // Drops made while this write was in flight start a new outage after the recorded one.
        if (announced !== undefined && outage !== undefined) {
          const later = outage.bytes - announced.bytes;
          outage = later > 0 ? { ...outage, bytes: later } : undefined;
        }
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
      drop(chunk.length, `more than ${maxPendingBytes} bytes waiting`);
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
