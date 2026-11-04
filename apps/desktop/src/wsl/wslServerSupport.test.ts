import { describe, expect, it } from "vite-plus/test";

import {
  decideWslEnable,
  WSL_SERVER_UNAVAILABLE_MESSAGE,
  wslPreflightError,
} from "./wslServerSupport.ts";

const distros = [
  { name: "Ubuntu-24.04", isDefault: true, version: 2 as const },
  { name: "Debian", isDefault: false, version: 2 as const },
  { name: "Alpine", isDefault: false, version: 1 as const },
];

describe("decideWslEnable", () => {
  it("refuses to start the server in a distro", () => {
    expect(decideWslEnable({ distro: null, distros })).toEqual({
      ok: false,
      reason: WSL_SERVER_UNAVAILABLE_MESSAGE,
    });
    expect(decideWslEnable({ distro: "Debian", distros })).toEqual({
      ok: false,
      reason: WSL_SERVER_UNAVAILABLE_MESSAGE,
    });
  });

  it("names a missing distro and lists what wsl.exe reported", () => {
    const decision = decideWslEnable({ distro: "missing", distros });
    expect(decision.ok).toBe(false);
    expect(decision.ok ? "" : decision.reason).toBe(
      'cannot enable the WSL backend: the selected distro "missing" is not installed; wsl.exe -l -v lists: Ubuntu-24.04, Debian, Alpine',
    );
  });

  it("rejects WSL 1 distros by name", () => {
    const decision = decideWslEnable({ distro: "Alpine", distros });
    expect(decision.ok).toBe(false);
    expect(decision.ok ? "" : decision.reason).toBe(
      "cannot enable Alpine as the WSL backend: it runs under WSL 1 and Houston needs WSL 2",
    );
  });

  it("resolves the default distro case-insensitively", () => {
    expect(decideWslEnable({ distro: "ubuntu-24.04", distros })).toEqual({
      ok: false,
      reason: WSL_SERVER_UNAVAILABLE_MESSAGE,
    });
  });
});

describe("wslPreflightError", () => {
  it("reports nothing while WSL is disabled or the only backend", () => {
    expect(wslPreflightError({ enabled: false, wslOnly: false, distro: null, distros })).toBeNull();
    expect(wslPreflightError({ enabled: true, wslOnly: true, distro: null, distros })).toBeNull();
  });

  it("names a missing or WSL 1 selection", () => {
    expect(wslPreflightError({ enabled: true, wslOnly: false, distro: "missing", distros })).toBe(
      'the selected WSL distro "missing" is not installed; wsl.exe -l -v lists: Ubuntu-24.04, Debian, Alpine',
    );
    expect(wslPreflightError({ enabled: true, wslOnly: false, distro: "Alpine", distros })).toBe(
      "Alpine runs under WSL 1; Houston needs WSL 2",
    );
  });
});
