import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as HostProcess from "@houston-app/shared/HostProcess";
import { CommandAvailability, WindowsShellEnvironment } from "@houston-app/shared/shell";
import * as Effect from "effect/Effect";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Observe the existing synchronous shell probe without launching the user's login shell.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import { assert, it, vi } from "vite-plus/test";

import { fixPath, hydratePosixHome } from "./os-jank.ts";

vi.mock("node:child_process", { spy: true });

it("hydrates HOME independently of a blank process HOME", () => {
  const originalHome = process.env.HOME;
  const env: NodeJS.ProcessEnv = { HOME: " " };

  try {
    process.env.HOME = " ";
    hydratePosixHome(env);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it("preserves an explicitly configured HOME", () => {
  const env: NodeJS.ProcessEnv = { HOME: "/custom/home" };

  hydratePosixHome(env, () => {
    throw new Error("HOME lookup should not run");
  });

  assert.equal(env.HOME, "/custom/home");
});

effectIt.effect("hydrates PATH when the desktop handoff is absent", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      vi
        .spyOn(NodeChildProcess, "execFileSync")
        .mockReturnValue("__HOUSTON_ENV_PATH_START__\n/opt/tools/bin\n__HOUSTON_ENV_PATH_END__\n"),
    ),
    (probe) =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = { SHELL: "/bin/bash", PATH: "/usr/bin" };

        yield* fixPath().pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Environment, env),
          Effect.provide(NodeServices.layer),
        );

        assert.equal(probe.mock.calls.length, 1);
        assert.equal(env.PATH, "/opt/tools/bin:/usr/bin");
      }),
    (probe) => Effect.sync(() => probe.mockRestore()),
  ),
);

effectIt.effect("keeps mise's PATH record with the login shell PATH", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      vi
        .spyOn(NodeChildProcess, "execFileSync")
        .mockReturnValue(
          [
            "__HOUSTON_ENV_PATH_START__",
            "/home/me/.local/bin:/mise/installs/claude/latest:/mise/shims",
            "__HOUSTON_ENV_PATH_END__",
            "__HOUSTON_ENV___MISE_DIFF_START__",
            "mise-diff",
            "__HOUSTON_ENV___MISE_DIFF_END__",
          ].join("\n"),
        ),
    ),
    () =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = { SHELL: "/bin/bash", PATH: "/usr/bin" };

        yield* fixPath().pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Environment, env),
          Effect.provide(NodeServices.layer),
        );

        assert.equal(env.__MISE_DIFF, "mise-diff");
      }),
    (probe) => Effect.sync(() => probe.mockRestore()),
  ),
);

effectIt.effect("hydrates a missing JAVA_HOME from the login shell and keeps an explicit one", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      vi
        .spyOn(NodeChildProcess, "execFileSync")
        .mockReturnValue(
          [
            "__HOUSTON_ENV_PATH_START__",
            "/opt/homebrew/bin",
            "__HOUSTON_ENV_PATH_END__",
            "__HOUSTON_ENV_JAVA_HOME_START__",
            "/opt/homebrew/opt/openjdk@17",
            "__HOUSTON_ENV_JAVA_HOME_END__",
          ].join("\n"),
        ),
    ),
    () =>
      Effect.gen(function* () {
        const missing: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
        const explicit: NodeJS.ProcessEnv = {
          SHELL: "/bin/zsh",
          PATH: "/usr/bin",
          JAVA_HOME: "/custom/jdk",
        };

        for (const env of [missing, explicit]) {
          yield* fixPath().pipe(
            Effect.provideService(HostProcess.Platform, "darwin"),
            Effect.provideService(HostProcess.Environment, env),
            Effect.provide(NodeServices.layer),
          );
        }

        assert.equal(missing.JAVA_HOME, "/opt/homebrew/opt/openjdk@17");
        assert.equal(explicit.JAVA_HOME, "/custom/jdk");
      }),
    (probe) => Effect.sync(() => probe.mockRestore()),
  ),
);

effectIt.effect("replaces a Path-spelled Windows PATH instead of adding a second key", () =>
  Effect.gen(function* () {
    const env: NodeJS.ProcessEnv = { Path: "C:\\Windows" };

    yield* fixPath().pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Environment, env),
      Effect.provideService(WindowsShellEnvironment, () => Effect.succeed({ PATH: "C:\\Tools" })),
      Effect.provideService(CommandAvailability, () => Effect.succeed(true)),
      Effect.provide(NodeServices.layer),
    );

    assert.deepEqual(env, { PATH: "C:\\Tools;C:\\Windows" });
  }),
);

// The host prepares this PATH itself (src-tauri/src/sys/server_env.rs); both sides pin one fixture.
const HOST_PREPARED_FIXTURE = {
  inherited: String.raw`C:\Windows;"C:\Program Files\nodejs";c:\windows;;C:\Users\u\.bun\bin`,
  prepared: [
    String.raw`C:\Windows`,
    String.raw`C:\Program Files\nodejs`,
    String.raw`C:\Users\u\.bun\bin`,
    String.raw`C:\Users\u\AppData\Roaming\npm`,
    String.raw`C:\Users\u\AppData\Local\Programs\nodejs`,
    String.raw`C:\Users\u\AppData\Local\Volta\bin`,
    String.raw`C:\Users\u\AppData\Local\pnpm`,
    String.raw`C:\Users\u\.local\bin`,
    String.raw`C:\Users\u\scoop\shims`,
  ].join(";"),
};

function hostFixtureEnv(): NodeJS.ProcessEnv {
  return {
    Path: HOST_PREPARED_FIXTURE.inherited,
    APPDATA: String.raw`C:\Users\u\AppData\Roaming`,
    LOCALAPPDATA: String.raw`C:\Users\u\AppData\Local`,
    USERPROFILE: String.raw`C:\Users\u`,
  };
}

effectIt.effect("the -NoProfile probe of an inherited PATH yields the host's prepared PATH", () =>
  Effect.gen(function* () {
    const env = hostFixtureEnv();

    yield* fixPath().pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Environment, env),
      // Windows PowerShell answers with the PATH its parent gave it.
      Effect.provideService(WindowsShellEnvironment, () =>
        Effect.succeed({ PATH: HOST_PREPARED_FIXTURE.inherited }),
      ),
      Effect.provideService(CommandAvailability, () => Effect.succeed(true)),
      Effect.provide(NodeServices.layer),
    );

    assert.equal(env.PATH, HOST_PREPARED_FIXTURE.prepared);
  }),
);

effectIt.effect("a prepared Windows environment skips the PowerShell probe", () =>
  Effect.gen(function* () {
    const env: NodeJS.ProcessEnv = { PATH: HOST_PREPARED_FIXTURE.prepared };
    let probes = 0;

    yield* fixPath({ shellEnvironmentPrepared: true }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Environment, env),
      Effect.provideService(WindowsShellEnvironment, () =>
        Effect.sync(() => {
          probes += 1;
          return {};
        }),
      ),
      Effect.provideService(CommandAvailability, () => Effect.succeed(true)),
      Effect.provide(NodeServices.layer),
    );

    assert.equal(probes, 0);
    assert.deepEqual(env, { PATH: HOST_PREPARED_FIXTURE.prepared });
  }),
);
