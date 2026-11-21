import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  TERMINAL_SHELL_EXPECTED_SHAPE,
  checkTerminalShell,
  detectTerminalShells,
  normalizeShellCommand,
  parseShellList,
  posixShellCandidates,
  resolveShellExecutable,
  windowsShellCandidates,
} from "./terminalShells.ts";

// oxlint-disable-next-line houston/no-global-process-runtime -- the fixtures create real files, so they follow the host platform.
const HOST_PLATFORM = process.platform;

const layer = NodeServices.layer;

const makeShell = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "houston-terminal-shells-" });
  const shell = path.join(directory, HOST_PLATFORM === "win32" ? "shell.exe" : "shell");
  yield* fs.writeFileString(shell, "");
  if (HOST_PLATFORM !== "win32") yield* fs.chmod(shell, 0o755);
  return { directory, shell };
});

describe("shell list parsing", () => {
  it("keeps absolute paths and drops comments and duplicates", () => {
    assert.deepEqual(
      parseShellList("# comment\n/bin/bash\n\n/bin/zsh # trailing\n/bin/bash\nrelative\n"),
      ["/bin/bash", "/bin/zsh"],
    );
  });

  it("keeps a quoted path with spaces whole and drops arguments otherwise", () => {
    assert.equal(
      normalizeShellCommand('"/opt/my shell/bin/zsh"', "linux"),
      "/opt/my shell/bin/zsh",
    );
    assert.equal(normalizeShellCommand("/bin/zsh -l", "linux"), "/bin/zsh");
  });

  it("puts the login shell first and follows /etc/shells", () => {
    assert.deepEqual(
      posixShellCandidates({
        env: { SHELL: "/custom/shell" },
        etcShells: "/etc/shells-value\n/bin/zsh\n",
      }).slice(0, 3),
      ["/custom/shell", "/etc/shells-value", "/bin/zsh"],
    );
  });
});

describe("Windows candidates", () => {
  it("names PowerShell, cmd, Git Bash and WSL", () => {
    const labels = windowsShellCandidates({
      SystemRoot: "C:\\Windows",
      ProgramFiles: "C:\\Program Files",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    }).map((candidate) => candidate.label);
    assert.include(labels, "PowerShell");
    assert.include(labels, "Windows PowerShell");
    assert.include(labels, "Command Prompt");
    assert.include(labels, "Git Bash");
    assert.include(labels, "WSL");
  });
});

describe("shell validation", () => {
  it.effect("accepts an executable file and rejects a missing path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { directory, shell } = yield* makeShell;
      const environment = { fs, platform: HOST_PLATFORM, env: process.env };

      assert.equal(yield* resolveShellExecutable(environment, shell), shell);
      const missing = path.join(directory, HOST_PLATFORM === "win32" ? "no.exe" : "no");
      assert.isNull(yield* resolveShellExecutable(environment, missing));
    }).pipe(Effect.provide(layer)),
  );

  it.effect.skipIf(HOST_PLATFORM === "win32")(
    "refuses a file without execute permission on POSIX",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "houston-terminal-shells-" });
        const shell = path.join(directory, "not-executable");
        yield* fs.writeFileString(shell, "");
        yield* fs.chmod(shell, 0o644);

        const result = yield* checkTerminalShell({ fs, platform: "linux", env: {} }, shell);

        assert.isFalse(result.available);
        assert.include(result.message, shell);
        assert.include(result.message, TERMINAL_SHELL_EXPECTED_SHAPE);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("names the unavailable value and the expected shape", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const result = yield* checkTerminalShell(
        { fs, platform: HOST_PLATFORM, env: process.env },
        "/definitely/missing-shell",
      );

      assert.isFalse(result.available);
      assert.include(result.message, "/definitely/missing-shell");
      assert.include(result.message, TERMINAL_SHELL_EXPECTED_SHAPE);
    }).pipe(Effect.provide(layer)),
  );
});

describe("detection", () => {
  it.effect.skipIf(HOST_PLATFORM === "win32")(
    "offers the login shell as the POSIX default and lists only files that exist",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { shell } = yield* makeShell;
        const result = yield* detectTerminalShells({
          fs,
          platform: "linux",
          env: { SHELL: shell, PATH: "/usr/bin:/bin" },
        });

        assert.equal(result.defaultShell, shell);
        assert.isTrue(result.candidates.some((candidate) => candidate.shell === shell));
        for (const candidate of result.candidates) {
          assert.isTrue(yield* fs.exists(candidate.shell));
        }
      }).pipe(Effect.provide(layer)),
  );
});
