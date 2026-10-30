import { compareSemverVersions } from "./semver.ts";

const CLI_RELEASE_REPOSITORY = "theogmiguel/houston";
export const CLI_RELEASES_PAGE_URL = `https://github.com/${CLI_RELEASE_REPOSITORY}/releases`;
export const CLI_RELEASE_CHECKSUMS_FILE = "SHA256SUMS";
export const CLI_RELEASE_BASE_URL_ENV = "T3CODE_RELEASE_BASE_URL";

// Houston publishes Linux server archives only for now; macOS and Windows are follow-ups.
export const CLI_ARCHIVE_PLATFORM_KEYS = ["linux-x64", "linux-arm64"] as const;
export type CliArchivePlatformKey = (typeof CLI_ARCHIVE_PLATFORM_KEYS)[number];

export function cliArchivePlatformKey(
  platform: NodeJS.Platform,
  arch: string,
): CliArchivePlatformKey | undefined {
  const key = `${platform}-${arch}`;
  return CLI_ARCHIVE_PLATFORM_KEYS.find((candidate) => candidate === key);
}

/** Use System32 bsdtar on Windows; Git-for-Windows GNU tar cannot open zip archives. */
export function cliArchiveTarCommand(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (platform !== "win32") return "tar";
  const systemRoot = env["SystemRoot"] ?? env["windir"] ?? "C:\\Windows";
  return `${systemRoot}\\System32\\tar.exe`;
}

export function cliArchiveFileName(version: string, platformKey: CliArchivePlatformKey): string {
  return `houston-${version}-${platformKey}.tar.gz`;
}

const CLI_RELEASE_DEFAULT_BASE_URL = `https://github.com/${CLI_RELEASE_REPOSITORY}/releases/download`;

export function cliReleaseDownloadBaseUrl(
  version: string,
  baseUrl: string | undefined = CLI_RELEASE_DEFAULT_BASE_URL,
): string {
  return `${(baseUrl?.trim() || CLI_RELEASE_DEFAULT_BASE_URL).replace(/\/+$/, "")}/v${version}`;
}

export function parseChecksums(text: string): ReadonlyMap<string, string> {
  const checksums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      checksums.set(match[2], match[1].toLowerCase());
    }
  }
  return checksums;
}

export type CliReleaseChannel = "stable" | "nightly" | "preview";
export const CLI_RELEASE_CHANNELS: ReadonlyArray<CliReleaseChannel> = [
  "stable",
  "nightly",
  "preview",
];

export function cliReleaseChannelOf(version: string): CliReleaseChannel {
  const channel = /^[^-+]+-(nightly|preview)\.\d{8}\.\d+$/.exec(version)?.[1];
  return channel === "nightly" || channel === "preview" ? channel : "stable";
}

/** Whether updating between these versions crosses Stable and Nightly. Preview builds cross nothing.
 * Hosts refuse a crossing outside a track switch, which checks the database first. */
export function crossesReleaseTrack(fromVersion: string, toVersion: string): boolean {
  const from = cliReleaseChannelOf(fromVersion);
  const to = cliReleaseChannelOf(toVersion);
  return from !== to && from !== "preview" && to !== "preview";
}

/** The desktop update track a build belongs to. Preview builds have no feed and read as Stable. */
export function desktopUpdateChannelOf(version: string): "latest" | "nightly" {
  return cliReleaseChannelOf(version) === "nightly" ? "nightly" : "latest";
}

/** Whether a track switch may install `found` after its database check cleared `checked`: any build
 * on the switch's track at least as new, since later releases only add migrations. */
export function acceptsTrackSwitchRelease(
  found: string,
  channel: "latest" | "nightly",
  checked: string,
): boolean {
  return (
    cliReleaseChannelOf(found) === (channel === "nightly" ? "nightly" : "stable") &&
    compareSemverVersions(found, checked) >= 0
  );
}

/** Page until the channel matches; nightlies can push preview/stable releases past the first page. */
export function cliReleaseIndexPageUrl(page: number): string {
  return `https://api.github.com/repos/${CLI_RELEASE_REPOSITORY}/releases?per_page=100&page=${page}`;
}

/** Draft assets are not downloadable. */
export function newestCliReleaseVersion(
  releases: ReadonlyArray<{
    readonly tag_name: string;
    readonly draft?: boolean | undefined;
  }>,
  channel: CliReleaseChannel,
): string | undefined {
  for (const release of releases) {
    if (release.draft) continue;
    const version = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(release.tag_name)?.[1];
    if (version === undefined) continue;
    if (cliReleaseChannelOf(version) === channel) return version;
  }
  return undefined;
}
