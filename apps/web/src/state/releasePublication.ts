import { useAtomValue } from "@effect/atom-react";
import { cliReleaseChannelOf, type CliReleaseChannel } from "@t3tools/shared/cliRelease";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { AsyncResult, Atom } from "effect/reactivity";

const RELEASE_REPOSITORY = "theogmiguel/houston";
const RELEASES_API = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases`;
const RELEASE_TAG_PATTERN = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

export interface PublishedRelease {
  readonly version: string;
  /** GitHub releases carry no npm manifest, so the migration head is unknown from here. */
  readonly databaseMigration: number | undefined;
}

interface GithubRelease {
  readonly tag_name?: unknown;
  readonly draft?: unknown;
  readonly assets?: unknown;
}

const releaseVersion = (release: GithubRelease): string | undefined =>
  typeof release.tag_name === "string" ? RELEASE_TAG_PATTERN.exec(release.tag_name)?.[1] : undefined;

const archiveName = (version: string, platformKey: "linux-x64" | "linux-arm64") =>
  `houston-${version}-${platformKey}.tar.gz`;

/** Both Linux archives and the checksums file, which is what an installable server release carries. */
export function carriesServerArchives(release: GithubRelease, version: string): boolean {
  if (!Array.isArray(release.assets)) return false;
  const names = new Set(
    release.assets.flatMap((asset) =>
      typeof asset === "object" && asset !== null && "name" in asset && typeof asset.name === "string"
        ? [asset.name]
        : [],
    ),
  );
  return (
    names.has(archiveName(version, "linux-x64")) &&
    names.has(archiveName(version, "linux-arm64")) &&
    names.has("SHA256SUMS")
  );
}

const isGithubRelease = (body: unknown): body is GithubRelease =>
  typeof body === "object" && body !== null;

const isPublishedServerRelease = (release: GithubRelease, version: string): boolean =>
  release.draft !== true && releaseVersion(release) === version && carriesServerArchives(release, version);

const channelOfSpec = (spec: string): CliReleaseChannel | undefined =>
  spec === "latest" ? "stable" : spec === "nightly" || spec === "preview" ? spec : undefined;

const releaseForVersion = (version: string) =>
  HttpClient.get(`${RELEASES_API}/tags/v${encodeURIComponent(version)}`).pipe(
    Effect.flatMap((response) =>
      response.status === 404
        ? Effect.succeed(null)
        : HttpClientResponse.filterStatusOk(response).pipe(
            Effect.flatMap((ok) => ok.json),
            Effect.map((body) => {
              if (!isGithubRelease(body) || !isPublishedServerRelease(body, version)) return null;
              return {
                version,
                databaseMigration: undefined,
              } satisfies PublishedRelease;
            }),
          ),
    ),
  );

const releaseForChannel = (channel: CliReleaseChannel) =>
  HttpClient.get(`${RELEASES_API}?per_page=100`).pipe(
    Effect.flatMap((response) =>
      HttpClientResponse.filterStatusOk(response).pipe(
        Effect.flatMap((ok) => ok.json),
        Effect.map((body) => {
          if (!Array.isArray(body)) return null;
          for (const entry of body) {
            if (!isGithubRelease(entry)) continue;
            const version = releaseVersion(entry);
            if (version === undefined || cliReleaseChannelOf(version) !== channel) continue;
            if (!isPublishedServerRelease(entry, version)) continue;
            return { version, databaseMigration: undefined } satisfies PublishedRelease;
          }
          return null;
        }),
      ),
    ),
  );

/** `spec` is an exact version or a desktop channel (`latest`/`nightly`). Null when the release is
 * not published or does not carry the server archives. Refreshes only while mounted; the
 * published check below keeps its own versions alive. */
export const releaseAtom = Atom.family((spec: string) =>
  Atom.make(
    Effect.gen(function* () {
      const channel = channelOfSpec(spec);
      return channel === undefined ? yield* releaseForVersion(spec) : yield* releaseForChannel(channel);
    }).pipe(
      // Tracing headers would make the browser send a CORS preflight, which GitHub rejects.
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.provide(FetchHttpClient.layer),
    ),
  ).pipe(Atom.withRefresh("5 minutes"), Atom.withLabel(`release:${spec}`)),
);

export const releasePublishedAtom = Atom.family((version: string) =>
  Atom.make((get) =>
    get.result(releaseAtom(version)).pipe(Effect.map((release) => release?.version === version)),
  ).pipe(Atom.keepAlive, Atom.withLabel(`release-published:${version}`)),
);

const NO_VERSION_ATOM = Atom.make(AsyncResult.success(false)).pipe(
  Atom.withLabel("release-published:none"),
);

export function useReleasePublished(version: string | null): boolean {
  const result = useAtomValue(version ? releasePublishedAtom(version) : NO_VERSION_ATOM);
  return AsyncResult.getOrElse(result, () => false);
}
