import { assert, describe, it } from "@effect/vitest";
import {
  HOST_PREPARED_FIXTURE,
  hostFixtureEnv,
} from "@houston-app/shared/testing/windowsServerEnvironmentFixture";
import * as Option from "effect/Option";

import {
  preparedWindowsServerPath,
  type WindowsPathProbe,
  type WindowsServerPathInput,
} from "./WindowsServerPath.ts";

const WINDOWS_CWD = String.raw`C:\cwd`;

const probeFor = (paths: ReadonlyArray<string>): WindowsPathProbe => {
  const present = new Set(paths);
  return {
    isFile: (path) => present.has(path),
    exists: (path) => present.has(path),
  };
};

const run = (env: Readonly<Record<string, string | undefined>>, paths: ReadonlyArray<string>) =>
  preparedWindowsServerPath({
    platform: "win32",
    env,
    cwd: WINDOWS_CWD,
    probe: probeFor(paths),
  });

const windowsEnv = (
  path: string,
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> => ({
  Path: path,
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  APPDATA: String.raw`C:\Users\u\AppData\Roaming`,
  LOCALAPPDATA: String.raw`C:\Users\u\AppData\Local`,
  USERPROFILE: String.raw`C:\Users\u`,
  ...overrides,
});

const expectedPath = (result: Option.Option<{ readonly path: string }>): string => {
  assert.isTrue(Option.isSome(result));
  return Option.isSome(result) ? result.value.path : "";
};

describe("preparedWindowsServerPath", () => {
  it("produces the PATH the server's own merge would produce", () => {
    const result = run(hostFixtureEnv(), [String.raw`C:\Program Files\nodejs\node.exe`]);

    assert.equal(expectedPath(result), HOST_PREPARED_FIXTURE.prepared);
  });

  it("counts node from a known CLI directory the inherited PATH lacks", () => {
    const result = run(windowsEnv(String.raw`C:\Windows`), [
      String.raw`C:\Users\u\AppData\Local\Programs\nodejs\node.exe`,
    ]);

    assert.equal(
      expectedPath(result),
      [
        String.raw`C:\Windows`,
        String.raw`C:\Users\u\AppData\Roaming\npm`,
        String.raw`C:\Users\u\AppData\Local\Programs\nodejs`,
        String.raw`C:\Users\u\AppData\Local\Volta\bin`,
        String.raw`C:\Users\u\AppData\Local\pnpm`,
        String.raw`C:\Users\u\.local\bin`,
        String.raw`C:\Users\u\.bun\bin`,
        String.raw`C:\Users\u\scoop\shims`,
      ].join(";"),
    );
  });

  it("uses PATHEXT to decide which node names count, with the default when blank", () => {
    const present = [String.raw`C:\tools\node.cmd`];

    assert.isTrue(Option.isSome(run(windowsEnv(String.raw`C:\tools`), present)));

    assert.isTrue(
      Option.isNone(
        run(
          windowsEnv(String.raw`C:\tools`, {
            PATHEXT: "exe",
          }),
          present,
        ),
      ),
    );

    assert.isTrue(
      Option.isSome(
        run(
          windowsEnv(String.raw`C:\tools`, {
            PATHEXT: " ; ",
          }),
          present,
        ),
      ),
    );
  });

  it("refuses when pwsh.exe resolves from PATH or the working directory", () => {
    const onPath = run(windowsEnv(String.raw`C:\Tools;C:\Program Files\nodejs`), [
      String.raw`C:\Program Files\nodejs\node.exe`,
      String.raw`C:\Tools\pwsh.exe`,
    ]);
    assert.isTrue(Option.isNone(onPath));

    const inWorkingDirectory = run(windowsEnv(String.raw`C:\Program Files\nodejs`), [
      String.raw`C:\Program Files\nodejs\node.exe`,
      String.raw`C:\cwd\pwsh.exe`,
    ]);
    assert.isTrue(Option.isNone(inWorkingDirectory));
  });

  it("refuses when node is not on the resulting PATH", () => {
    assert.isTrue(Option.isNone(run(windowsEnv(String.raw`C:\Windows`), [])));
  });

  it("refuses when the environment carries more than one PATH spelling", () => {
    const env = windowsEnv(String.raw`C:\Windows`);
    env.PATH = String.raw`C:\Program Files\nodejs`;

    assert.isTrue(Option.isNone(run(env, [String.raw`C:\Program Files\nodejs\node.exe`])));
  });

  it("refuses a variable value that is not a usable string", () => {
    const env = windowsEnv(String.raw`C:\Windows`);
    env.PATHEXT = 5 as unknown as string;

    assert.isTrue(Option.isNone(run(env, [])));
  });

  it("refuses to prepare on a non-Windows host", () => {
    const probe = probeFor([String.raw`C:\Program Files\nodejs\node.exe`]);

    assert.isTrue(
      Option.isNone(
        preparedWindowsServerPath({
          platform: "linux",
          env: hostFixtureEnv(),
          cwd: WINDOWS_CWD,
          probe,
        }),
      ),
    );
  });

  it("replaces a Path spelling with the single PATH key", () => {
    const result = run(windowsEnv(String.raw`C:\Windows`), [
      String.raw`C:\Users\u\AppData\Local\Programs\nodejs\node.exe`,
    ]);

    assert.isTrue(Option.isSome(result));
    if (Option.isSome(result)) {
      assert.deepEqual(result.value.stalePathKeys, ["Path"]);
    }
  });

  it("adds no directories for blank profile variables", () => {
    const env: WindowsServerPathInput["env"] = {
      Path: String.raw`C:\tools`,
      APPDATA: "  ",
      PATHEXT: ".EXE",
    };
    const result = run(env, [String.raw`C:\tools\node.exe`]);

    assert.equal(expectedPath(result), String.raw`C:\tools`);
  });
});
