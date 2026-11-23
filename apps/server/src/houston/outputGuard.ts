export type OutputName = "stdout" | "stderr";

/** The part of `process.stdout` and `process.stderr` the guard uses. */
export interface OutputStream {
  on(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
  write(chunk: string): boolean;
}

export interface OutputGuard {
  /** Failed writes seen on each stream since the guard was installed. */
  readonly failures: () => Readonly<Record<OutputName, number>>;
}

const guards = new WeakMap<OutputStream, OutputGuard>();
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** An error's code when it has the shape of one, else `unknown`: a message can carry a path. */
export const outputErrorCode = (error: NodeJS.ErrnoException): string =>
  typeof error.code === "string" && ERROR_CODE.test(error.code) ? error.code : "unknown";

// Node reports a failed stdout or stderr write (a closed reader, a full or failing disk) as an
// `error` event on that stream, which crashes the process when no listener takes it. Every such
// event is an output failure: the line is dropped and the first one is reported on the other stream.
export function guardProcessOutput(
  streams: Readonly<Record<OutputName, OutputStream>> = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): OutputGuard {
  const existing = guards.get(streams.stdout);
  if (existing !== undefined) return existing;
  const failures: Record<OutputName, number> = { stdout: 0, stderr: 0 };
  const guard: OutputGuard = { failures: () => ({ ...failures }) };
  guards.set(streams.stdout, guard);
  for (const name of ["stdout", "stderr"] as const) {
    const other = name === "stdout" ? "stderr" : "stdout";
    streams[name].on("error", (error) => {
      failures[name] += 1;
      // A stream that already failed is not written to, so two failing streams cannot ping-pong.
      if (failures[name] > 1 || failures[other] > 0) return;
      const code = outputErrorCode(error);
      try {
        streams[other].write(
          `houston: a write to ${name} failed (${code}); later ${name} output from this process is dropped\n`,
        );
      } catch {
        // A failure of the other stream reaches its own listener.
      }
    });
  }
  return guard;
}
