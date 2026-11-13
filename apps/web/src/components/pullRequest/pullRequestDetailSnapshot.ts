// Start-up code reads and writes these snapshots, so they stay clear of the markdown parser
// that pullRequestDetail.logic carries.
import { sourceControlClients } from "@houston-app/client-runtime/source-control-clients";
import {
  PullRequestDetail,
  type PullRequestRef,
  type RepositoryIdentity,
} from "@houston-app/contracts";
import * as Schema from "effect/Schema";

type SnapshotStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function resolvePullRequestReferenceHost(
  reference: PullRequestRef,
  identity: RepositoryIdentity | null | undefined,
): PullRequestRef {
  if (reference.host !== undefined || !identity?.provider) return reference;
  const host = sourceControlClients.get(identity.provider).checkoutChangeRequestHost(identity);
  return host === null ? reference : { ...reference, host };
}

interface PullRequestDetailSnapshotRef {
  readonly host?: string | undefined;
  readonly projectId: string;
  readonly repository: string;
  readonly number: number;
}

const pullRequestDetailSnapshotKey = (
  environmentId: string,
  reference: PullRequestDetailSnapshotRef,
) =>
  reference.host
    ? `houston.pullRequests.detail:${JSON.stringify([environmentId, reference.projectId, reference.host.toLowerCase(), reference.repository.toLowerCase(), reference.number])}`
    : `houston.pullRequests.detail:${environmentId}:${reference.projectId}:${reference.repository}#${reference.number}`;

const decodeDetailSnapshot = Schema.decodeUnknownOption(PullRequestDetail);

export function readPullRequestDetailSnapshot(
  storage: SnapshotStorage | undefined,
  environmentId: string,
  reference: PullRequestDetailSnapshotRef,
): PullRequestDetail | null {
  try {
    const raw =
      storage?.getItem(pullRequestDetailSnapshotKey(environmentId, reference)) ??
      (reference.host === undefined
        ? null
        : storage?.getItem(
            pullRequestDetailSnapshotKey(environmentId, { ...reference, host: undefined }),
          ));
    if (!raw) return null;
    const decoded = decodeDetailSnapshot(JSON.parse(raw));
    return decoded._tag === "Some"
      ? resolveDisplayedPullRequestDetail({ live: null, cached: decoded.value, reference })
      : null;
  } catch {
    return null;
  }
}

const PULL_REQUEST_DETAIL_SNAPSHOT_INDEX_KEY = "houston.pullRequests.recentDetails";
const PULL_REQUEST_DETAIL_SNAPSHOT_LIMIT = 20;

function readPullRequestDetailSnapshotIndex(storage: SnapshotStorage): string[] {
  try {
    const keys: unknown = JSON.parse(
      storage.getItem(PULL_REQUEST_DETAIL_SNAPSHOT_INDEX_KEY) ?? "[]",
    );
    return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string") : [];
  } catch {
    return [];
  }
}

export function writePullRequestDetailSnapshot(
  storage: SnapshotStorage | undefined,
  environmentId: string,
  reference: PullRequestDetailSnapshotRef,
  detail: PullRequestDetail,
): void {
  if (!storage) return;
  try {
    const key = pullRequestDetailSnapshotKey(environmentId, reference);
    const recent = readPullRequestDetailSnapshotIndex(storage).filter((entry) => entry !== key);
    recent.push(key);
    for (const evicted of recent.splice(0, recent.length - PULL_REQUEST_DETAIL_SNAPSHOT_LIMIT)) {
      storage.removeItem(evicted);
    }
    storage.setItem(PULL_REQUEST_DETAIL_SNAPSHOT_INDEX_KEY, JSON.stringify(recent));
    storage.setItem(key, JSON.stringify(detail));
  } catch {}
}

export function resolveDisplayedPullRequestDetail(input: {
  readonly live: PullRequestDetail | null;
  readonly cached: PullRequestDetail | null;
  readonly reference: PullRequestDetailSnapshotRef;
}): PullRequestDetail | null {
  if (input.live !== null) return input.live;
  if (
    input.cached === null ||
    input.cached.projectId !== input.reference.projectId ||
    input.cached.repository.toLowerCase() !== input.reference.repository.toLowerCase() ||
    input.cached.number !== input.reference.number
  ) {
    return null;
  }
  if (input.reference.host === undefined) return input.cached;
  const link = sourceControlClients.parseChangeRequestUrl(input.cached.url)?.link;
  return link !== undefined && (link.authority ?? link.host) === input.reference.host.toLowerCase()
    ? input.cached
    : null;
}
