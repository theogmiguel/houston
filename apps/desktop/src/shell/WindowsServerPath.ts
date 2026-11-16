// @effect-diagnostics-next-line nodeBuiltinImport:off -- The probe is synchronous so the PATH rule stays pure; the Effect FileSystem API is effectful.
import * as NodeFS from "node:fs";
import * as Option from "effect/Option";

const DEFAULT_PATHEXT = [".COM", ".EXE", ".BAT", ".CMD"] as const;

export interface WindowsPathProbe {
  /** A regular file after following links, as the server's `stat` sees it. */
  readonly isFile: (path: string) => boolean;
  /** Any non-directory entry, links included, as process creation finds it. */
  readonly exists: (path: string) => boolean;
}

export interface PreparedWindowsServerPath {
  readonly path: string;
  /** PATH spellings other than `PATH`, removed before the single key is added. */
  readonly stalePathKeys: ReadonlyArray<string>;
}

export interface WindowsServerPathInput {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly probe: WindowsPathProbe;
}

interface WindowsInputs {
  readonly path: string | undefined;
  readonly pathExt: string | undefined;
  readonly appData: string | undefined;
  readonly localAppData: string | undefined;
  readonly userProfile: string | undefined;
}

export const windowsFileSystemProbe: WindowsPathProbe = {
  isFile: (path) => {
    try {
      return NodeFS.statSync(path).isFile();
    } catch {
      return false;
    }
  },
  exists: (path) => {
    try {
      return !NodeFS.lstatSync(path).isDirectory();
    } catch {
      return false;
    }
  },
};

const environmentKey = (
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined => Object.keys(env).find((key) => key.toUpperCase() === name.toUpperCase());

const readInputs = (
  env: Readonly<Record<string, string | undefined>>,
): Option.Option<WindowsInputs> => {
  const read = (name: string): Option.Option<string | undefined> => {
    const key = environmentKey(env, name);
    if (key === undefined) return Option.some(undefined);
    const value = env[key];
    return typeof value === "string" ? Option.some(value) : Option.none();
  };

  const path = read("PATH");
  const pathExt = read("PATHEXT");
  const appData = read("APPDATA");
  const localAppData = read("LOCALAPPDATA");
  const userProfile = read("USERPROFILE");
  if (
    Option.isNone(path) ||
    Option.isNone(pathExt) ||
    Option.isNone(appData) ||
    Option.isNone(localAppData) ||
    Option.isNone(userProfile)
  ) {
    return Option.none();
  }

  return Option.some({
    path: path.value,
    pathExt: pathExt.value,
    appData: appData.value,
    localAppData: localAppData.value,
    userProfile: userProfile.value,
  });
};

const joinWindowsPath = (dir: string, name: string): string =>
  `${dir.replace(/[\\/]+$/u, "")}\\${name}`;

const stripWrappingQuotes = (value: string): string => value.replace(/^"+/, "").replace(/"+$/, "");

const mergePathValues = (values: ReadonlyArray<string | undefined>): Option.Option<string> => {
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (!value) continue;
    for (const entry of value.split(";")) {
      const sanitized = entry.trim().replaceAll('"', "");
      if (sanitized.length === 0) continue;
      const normalized = sanitized.trim().toLowerCase();
      if (normalized.length === 0 || seen.has(normalized)) continue;
      seen.add(normalized);
      merged.push(sanitized);
    }
  }

  return merged.length > 0 ? Option.some(merged.join(";")) : Option.none();
};

const trimmed = (value: string | undefined): string | undefined => {
  const result = value?.trim();
  return result && result.length > 0 ? result : undefined;
};

const knownCliDirs = (inputs: WindowsInputs): ReadonlyArray<string> => {
  const appData = trimmed(inputs.appData);
  const localAppData = trimmed(inputs.localAppData);
  const userProfile = trimmed(inputs.userProfile);

  return [
    ...(appData ? [`${appData}\\npm`] : []),
    ...(localAppData ? [`${localAppData}\\Programs\\nodejs`, `${localAppData}\\Volta\\bin`] : []),
    ...(localAppData ? [`${localAppData}\\pnpm`] : []),
    ...(userProfile
      ? [`${userProfile}\\.local\\bin`, `${userProfile}\\.bun\\bin`, `${userProfile}\\scoop\\shims`]
      : []),
  ];
};

const pathExtensions = (pathExt: string | undefined): ReadonlyArray<string> => {
  const parsed: string[] = [];
  for (const entry of (pathExt ?? "").split(";")) {
    const value = entry.trim();
    if (value.length === 0) continue;
    const extension = value.startsWith(".") ? value.toUpperCase() : `.${value.toUpperCase()}`;
    if (!parsed.includes(extension)) parsed.push(extension);
  }
  return parsed.length > 0 ? parsed : DEFAULT_PATHEXT;
};

const nodeOnPath = (
  path: string,
  pathExt: string | undefined,
  probe: WindowsPathProbe,
): boolean => {
  const candidates: string[] = [];
  for (const extension of pathExtensions(pathExt)) {
    for (const name of [`node${extension}`, `node${extension.toLowerCase()}`]) {
      if (!candidates.includes(name)) candidates.push(name);
    }
  }

  return path
    .split(";")
    .map((entry) => stripWrappingQuotes(entry.trim()))
    .filter((entry) => entry.length > 0)
    .some((entry) => candidates.some((name) => probe.isFile(joinWindowsPath(entry, name))));
};

const findsPwsh = (path: string | undefined, cwd: string, probe: WindowsPathProbe): boolean => {
  if (probe.exists(joinWindowsPath(cwd, "pwsh.exe"))) return true;

  return (path ?? "")
    .split(";")
    .map((entry) => stripWrappingQuotes(entry.trim()))
    .filter((entry) => entry.length > 0)
    .some((entry) => probe.exists(joinWindowsPath(entry, "pwsh.exe")));
};

/**
 * The PATH `resolveWindowsEnvironment` would produce from an inherited
 * environment, or none when that result is not certain.
 */
export const preparedWindowsServerPath = (
  input: WindowsServerPathInput,
): Option.Option<PreparedWindowsServerPath> => {
  if (input.platform !== "win32") return Option.none();

  const pathKeys = Object.keys(input.env).filter((key) => key.toUpperCase() === "PATH");
  if (pathKeys.length > 1) return Option.none();

  const inputs = readInputs(input.env);
  if (Option.isNone(inputs)) return Option.none();

  const windows = inputs.value;
  if (findsPwsh(windows.path, input.cwd, input.probe)) return Option.none();

  const inherited = windows.path && windows.path.length > 0 ? windows.path : undefined;
  const merged = mergePathValues([inherited, inherited]);
  const baseline = mergePathValues([
    Option.getOrUndefined(merged),
    knownCliDirs(windows).join(";"),
  ]);
  if (Option.isNone(baseline)) return Option.none();
  if (!nodeOnPath(baseline.value, windows.pathExt, input.probe)) return Option.none();

  return Option.some({
    path: baseline.value,
    stalePathKeys: pathKeys.filter((key) => key !== "PATH"),
  });
};
