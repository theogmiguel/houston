import type { WslDistro } from "./wslPathParsing.ts";

/** Whether the primary backend resolves to the WSL server for these settings. */
export function wslPrimarySelected(input: {
  readonly wslBackendEnabled: boolean;
  readonly wslOnly: boolean;
  readonly available: boolean;
}): boolean {
  return input.wslBackendEnabled && input.wslOnly && input.available;
}

export type WslEnableDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

const listDistroNames = (distros: readonly WslDistro[]): string =>
  distros.map((distro) => distro.name).join(", ");

const resolveDistro = (
  distro: string | null,
  distros: readonly WslDistro[],
): WslDistro | undefined =>
  distros.find((candidate) =>
    distro === null ? candidate.isDefault : candidate.name.toLowerCase() === distro.toLowerCase(),
  );

/** The state a running WSL backend would fail its preflight for, as the settings describe it. */
export function wslPreflightError(input: {
  readonly enabled: boolean;
  readonly wslOnly: boolean;
  readonly distro: string | null;
  readonly distros: readonly WslDistro[];
}): string | null {
  if (!input.enabled || input.wslOnly) return null;
  const selected = resolveDistro(input.distro, input.distros);
  if (selected === undefined) {
    return `the selected WSL distro "${input.distro ?? "<default>"}" is not installed; wsl.exe -l -v lists: ${listDistroNames(input.distros)}`;
  }
  if (selected.version === 1) {
    return `${selected.name} runs under WSL 1; Houston needs WSL 2`;
  }
  return null;
}

/** Explains why the WSL backend cannot start, or accepts the request. */
export function decideWslEnable(input: {
  readonly distro: string | null;
  readonly distros: readonly WslDistro[];
}): WslEnableDecision {
  const selected = resolveDistro(input.distro, input.distros);
  if (selected === undefined) {
    return {
      ok: false,
      reason: `cannot enable the WSL backend: the selected distro "${input.distro ?? "<default>"}" is not installed; wsl.exe -l -v lists: ${listDistroNames(input.distros)}`,
    };
  }
  if (selected.version === 1) {
    return {
      ok: false,
      reason: `cannot enable ${selected.name} as the WSL backend: it runs under WSL 1 and Houston needs WSL 2`,
    };
  }
  return { ok: true };
}
