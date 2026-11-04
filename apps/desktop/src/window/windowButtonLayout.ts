// @effect-diagnostics nodeBuiltinImport:off - The GNOME preference is read through the platform command; no streaming API is needed.
import * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";

export interface WindowButtonLayoutCommand {
  readonly status: number | null;
  readonly stdout: string;
}

/**
 * GNOME writes `'appmenu:minimize,maximize,close'`; the renderer expects the
 * unquoted value, and an empty setting means "use the fallback layout".
 */
export function normalizeWindowButtonLayout(raw: string): string | null {
  const trimmed = raw.trim();
  const unquoted =
    trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")
      ? trimmed.slice(1, -1)
      : trimmed;
  return unquoted.length > 0 ? unquoted : null;
}

/**
 * Only GNOME exposes a configurable button order; other platforms fix the
 * buttons in their own title bar, so they report null and the renderer falls
 * back to its documented layout.
 */
export function readWindowButtonLayout(
  platform: NodeJS.Platform,
  run: () => Promise<WindowButtonLayoutCommand>,
): Effect.Effect<string | null> {
  if (platform !== "linux") {
    return Effect.succeed(null);
  }
  return Effect.tryPromise(run).pipe(
    Effect.map(({ status, stdout }) => (status === 0 ? normalizeWindowButtonLayout(stdout) : null)),
    Effect.orElseSucceed(() => null),
  );
}

export function runWindowButtonLayoutCommand(): Promise<WindowButtonLayoutCommand> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      "gsettings",
      ["get", "org.gnome.desktop.wm.preferences", "button-layout"],
      { encoding: "utf8" },
      (error, stdout) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve({ status: 0, stdout });
      },
    );
  });
}
