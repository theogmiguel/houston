import type {
  BranchNamingOptions,
  VcsRef,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "@houston-app/contracts";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";

const NORMALIZED_PATTERN = /[̀-ͯ]/g;
const NORMALIZED_PATTERN_2 = /['"`]/g;
const NORMALIZED_PATTERN_3 = /^[./\s_-]+|[./\s_-]+$/g;
const BRANCH_FRAGMENT_PATTERN = /[^a-z0-9/_-]+/g;
const SLASH_RUN = /\/+/g;
const BRANCH_FRAGMENT_PATTERN_2 = /-+/g;
const BRANCH_FRAGMENT_PATTERN_3 = /^[./_-]+|[./_-]+$/g;
const BRANCH_FRAGMENT_PATTERN_4 = /[./_-]+$/g;
const FORMAT_GENERATED_BRANCH_NAME_PATTERN = /[^a-zA-Z0-9_-]+/g;
const EDGE_DASHES = /^-+|-+$/g;
const TOKEN_PATTERN = /[^0-9a-f]/g;
const TOKEN_START_PATTERN = /[-/]/;
const TRAILING_SLASHES = /\/+$/g;
const LOWER_CASE_REMOTE_PATTERN = /\.git$/i;
const PARSE_GIT_REMOTE_REPOSITORY_PATTERN = /^(?:ssh|https?|git):\/\//i;
const SCP_STYLE_HOST_AND_PATH_PATTERN = /^[a-z]:/i;
const SCP_STYLE_HOST_AND_PATH_PATTERN_2 =
  /^(?:[a-zA-Z0-9._-]+@)?([^@:/\\\s]+):\/?([^/\s]+(?:\/[^/\s]+)+)$/i;
const LINE_BREAK = /\r?\n/;
const HEADER_PATTERN = /^\[\s*([^\]]*?)\s*\](.*)$/;
const MATCH_PATTERN = /^bare\s*(?:=(.*)|[#;].*)?$/i;
const JOINED_PATTERN = /\\\r?\n[ \t]*/g;
const HEADER_PATTERN_2 = /^\[\s*remote(?:\s+"([^"]+)"|\.([^\]\s]+))\s*\](.*)$/i;
const MATCH_PATTERN_2 = /^url\s*=\s*(.*)$/i;
const SANITIZE_NEW_REF_NAME_PATTERN = /[ \t\n\r\f\v]+/g;

export const WORKTREE_BRANCH_PREFIX = "houston";
const TEMP_WORKTREE_HEX_TOKEN = "[0-9a-f]{8}";
const TEMP_WORKTREE_UUID_V4_TOKEN =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const TEMP_WORKTREE_BRANCH_PATTERN = new RegExp(
  `^(?:${WORKTREE_BRANCH_PREFIX}(?:[-/]${TEMP_WORKTREE_HEX_TOKEN}|\\/${TEMP_WORKTREE_UUID_V4_TOKEN}))$`,
);

export function sanitizeBranchFragment(raw: string): string {
  const normalized = raw
    .normalize("NFKD")
    .replace(NORMALIZED_PATTERN, "")
    .trim()
    .toLowerCase()
    .replace(NORMALIZED_PATTERN_2, "")
    .replace(NORMALIZED_PATTERN_3, "");

  const branchFragment = normalized
    .replace(BRANCH_FRAGMENT_PATTERN, "-")
    .replace(SLASH_RUN, "/")
    .replace(BRANCH_FRAGMENT_PATTERN_2, "-")
    .replace(BRANCH_FRAGMENT_PATTERN_3, "")
    .slice(0, 64)
    .replace(BRANCH_FRAGMENT_PATTERN_4, "");

  return branchFragment.length > 0 ? branchFragment : "update";
}

export function formatGeneratedBranchName(raw: string, naming?: BranchNamingOptions): string {
  if (naming?.mode === "custom") return raw.trim();
  const branch = sanitizeBranchFragment(raw);
  if (naming?.mode !== "static") return branch;
  const prefix = naming.prefix
    .split("/")
    .map((part) =>
      part
        .replace(FORMAT_GENERATED_BRANCH_NAME_PATTERN, "-")
        .replace(BRANCH_FRAGMENT_PATTERN_2, "-")
        .replace(EDGE_DASHES, ""),
    )
    .filter(Boolean)
    .join("/");
  return prefix ? `${prefix}/${branch}` : branch;
}

export function sanitizeFeatureBranchName(raw: string): string {
  const sanitized = sanitizeBranchFragment(raw);
  return sanitized.includes("/") ? sanitized : `feature/${sanitized}`;
}

const AUTO_FEATURE_BRANCH_FALLBACK = "feature/update";

export function resolveAutoFeatureBranchName(
  existingBranchNames: readonly string[],
  preferredBranch?: string,
): string {
  const preferred = preferredBranch?.trim();
  const resolvedBase = sanitizeFeatureBranchName(
    preferred && preferred.length > 0 ? preferred : AUTO_FEATURE_BRANCH_FALLBACK,
  );
  const existingNames = existingBranchNames.map((refName) => refName.toLowerCase());
  const existingRefs = new Set(existingNames);
  const parts = resolvedBase.split("/");
  let resolved = "";

  for (const [index, part] of parts.entries()) {
    const base = resolved ? `${resolved}/${part}` : part;
    let candidate = base;
    let suffix = 2;
    while (
      existingRefs.has(candidate) ||
      (index === parts.length - 1 &&
        existingNames.some((refName) => refName.startsWith(`${candidate}/`)))
    ) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    resolved = candidate;
  }

  return resolved;
}

export function deriveLocalBranchNameFromRemoteRef(branchName: string): string {
  const firstSeparatorIndex = branchName.indexOf("/");
  if (firstSeparatorIndex <= 0 || firstSeparatorIndex === branchName.length - 1) {
    return branchName;
  }
  return branchName.slice(firstSeparatorIndex + 1);
}

export function buildTemporaryWorktreeBranchName(
  randomHex: (byteLength: number) => string,
): string {
  const token = randomHex(4).toLowerCase().replace(TOKEN_PATTERN, "").slice(0, 8);
  return `${WORKTREE_BRANCH_PREFIX}/${token}`;
}

/** Flatten temporary houston/<hex> refs because an existing houston branch blocks nested refs. */
export function flattenTemporaryWorktreeBranchName(refName: string): string {
  const normalized = refName.trim().toLowerCase();
  const tokenStart = normalized.search(TOKEN_START_PATTERN) + 1;
  const token = normalized.slice(tokenStart, tokenStart + 8);
  return `${WORKTREE_BRANCH_PREFIX}-${token}`;
}

export function isTemporaryWorktreeBranch(refName: string): boolean {
  return TEMP_WORKTREE_BRANCH_PATTERN.test(refName.trim().toLowerCase());
}

function lowerCaseRemote(value: string): string {
  return value
    .trim()
    .replace(TRAILING_SLASHES, "")
    .replace(LOWER_CASE_REMOTE_PATTERN, "")
    .toLowerCase();
}

/**
 * The host and repository path a remote names, lower case and without a port, or null for a
 * remote that names no host, such as a local path.
 */
export function parseGitRemoteRepository(
  value: string,
): { readonly host: string; readonly path: string } | null {
  const normalized = lowerCaseRemote(value);

  if (PARSE_GIT_REMOTE_REPOSITORY_PATTERN.test(normalized)) {
    try {
      const url = new URL(normalized);
      const repositorySegments = url.pathname.split("/").filter((segment) => segment.length > 0);
      if (url.hostname && repositorySegments.length > 1) {
        return { host: url.hostname, path: repositorySegments.join("/") };
      }
    } catch {
      return null;
    }
  }

  // A userless one-letter prefix is a Windows drive, not an SCP host.
  const scpStyleHostAndPath = SCP_STYLE_HOST_AND_PATH_PATTERN.test(normalized)
    ? null
    : SCP_STYLE_HOST_AND_PATH_PATTERN_2.exec(normalized);
  const scpHost = scpStyleHostAndPath?.[1];
  const scpPath = scpStyleHostAndPath?.[2];
  return scpHost && scpPath ? { host: scpHost, path: scpPath } : null;
}

/**
 * `host/path` for a remote that names a host, otherwise the remote itself, lower case. A host that
 * spells repositories differently over SSH has its source control registry's
 * `repositoryKeyFromRemote` rewrite this, so persisted keys come from that, not from here.
 */
export function normalizeGitRemoteUrl(value: string): string {
  const repository = parseGitRemoteRepository(value);
  return repository === null ? lowerCaseRemote(value) : `${repository.host}/${repository.path}`;
}

function parseGitConfigValue(raw: string): string {
  let out = "";
  let quoted = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (char === "\\" && index + 1 < raw.length) {
      out += raw[index + 1];
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && (char === "#" || char === ";")) break;
    out += char;
  }
  return out.trim();
}

export function isBareGitConfig(configText: string): boolean {
  let inCore = false;
  let bare = false;
  for (const rawLine of configText.split(LINE_BREAK)) {
    let line = rawLine.trim();
    // Git accepts the first setting on the section header's own line.
    const header = HEADER_PATTERN.exec(line);
    if (header !== null) {
      inCore = header[1]!.toLowerCase() === "core";
      line = header[2]!.trim();
    }
    if (!inCore) continue;
    const match = MATCH_PATTERN.exec(line);
    if (match === null) continue;
    const value = match[1] === undefined ? "true" : parseGitConfigValue(match[1]).toLowerCase();
    bare = value === "true" || value === "yes" || value === "on" || value === "1";
  }
  return bare;
}

export function parseOriginUrlFromGitConfig(configText: string): string | null {
  let section: string | null = null;
  let originUrl: string | null = null;
  let firstRemoteUrl: string | null = null;
  const joined = configText.replace(JOINED_PATTERN, "");
  for (const rawLine of joined.split(LINE_BREAK)) {
    let line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;
    // Git preserves case in quoted remote subsections but lowercases legacy dotted ones,
    // and accepts the first setting on the section header's own line.
    const header = HEADER_PATTERN_2.exec(line);
    if (header) {
      section = header[1] ?? header[2]?.toLowerCase() ?? null;
      line = header[3]!.trim();
    } else if (line.startsWith("[")) {
      section = null;
      continue;
    }
    if (section === null) continue;
    const match = MATCH_PATTERN_2.exec(line);
    if (!match) continue;
    const url = parseGitConfigValue(match[1] ?? "");
    if (url.length === 0) continue;
    if (section === "origin") {
      originUrl ??= url;
    } else {
      firstRemoteUrl ??= url;
    }
  }
  return originUrl ?? firstRemoteUrl;
}

function deriveLocalBranchNameCandidatesFromRemoteRef(
  branchName: string,
  remoteName?: string,
): ReadonlyArray<string> {
  const candidates = new Set<string>();
  const firstSlashCandidate = deriveLocalBranchNameFromRemoteRef(branchName);
  if (firstSlashCandidate.length > 0) {
    candidates.add(firstSlashCandidate);
  }

  if (remoteName) {
    const remotePrefix = `${remoteName}/`;
    if (branchName.startsWith(remotePrefix) && branchName.length > remotePrefix.length) {
      candidates.add(branchName.slice(remotePrefix.length));
    }
  }

  return [...candidates];
}

// Replace only Git-rejected whitespace; nonbreaking spaces are valid ref characters.
export function sanitizeNewRefName(rawName: string): string {
  return rawName.trim().replace(SANITIZE_NEW_REF_NAME_PATTERN, "-");
}

export function dedupeRemoteBranchesWithLocalMatches(
  refs: ReadonlyArray<VcsRef>,
): ReadonlyArray<VcsRef> {
  const localBranchNames = new Set(
    Arr.filterMap(refs, (refName) =>
      refName.isRemote ? Result.failVoid : Result.succeed(refName.name),
    ),
  );

  return refs.filter((refName) => {
    if (!refName.isRemote) {
      return true;
    }

    if (refName.remoteName !== "origin") {
      return true;
    }

    const localBranchCandidates = deriveLocalBranchNameCandidatesFromRemoteRef(
      refName.name,
      refName.remoteName,
    );
    return !localBranchCandidates.some((candidate) => localBranchNames.has(candidate));
  });
}

const EMPTY_GIT_STATUS_REMOTE: VcsStatusRemoteResult = {
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  aheadOfDefaultCount: 0,
  pr: null,
};

export function mergeGitStatusParts(
  local: VcsStatusLocalResult,
  remote: VcsStatusRemoteResult | null,
): VcsStatusResult {
  return {
    ...local,
    ...(remote ?? EMPTY_GIT_STATUS_REMOTE),
  };
}

function toRemoteStatusPart(status: VcsStatusResult): VcsStatusRemoteResult {
  return {
    hasUpstream: status.hasUpstream,
    aheadCount: status.aheadCount,
    behindCount: status.behindCount,
    ...(status.aheadOfDefaultCount === undefined
      ? {}
      : { aheadOfDefaultCount: status.aheadOfDefaultCount }),
    pr: status.pr,
  };
}

function toLocalStatusPart(status: VcsStatusResult): VcsStatusLocalResult {
  return {
    isRepo: status.isRepo,
    ...(status.sourceControlProvider
      ? { sourceControlProvider: status.sourceControlProvider }
      : {}),
    hasPrimaryRemote: status.hasPrimaryRemote,
    isDefaultRef: status.isDefaultRef,
    refName: status.refName,
    hasWorkingTreeChanges: status.hasWorkingTreeChanges,
    workingTree: status.workingTree,
    ...(status.branchChanges ? { branchChanges: status.branchChanges } : {}),
    ...(status.pausedOperation ? { pausedOperation: status.pausedOperation } : {}),
  };
}

export function applyGitStatusStreamEvent(
  current: VcsStatusResult | null,
  event: VcsStatusStreamEvent,
): VcsStatusResult {
  switch (event._tag) {
    case "snapshot":
      return mergeGitStatusParts(event.local, event.remote);
    case "localUpdated":
      return mergeGitStatusParts(event.local, current ? toRemoteStatusPart(current) : null);
    case "remoteUpdated":
      if (current === null) {
        return mergeGitStatusParts(
          {
            isRepo: true,
            hasPrimaryRemote: false,
            isDefaultRef: false,
            refName: null,
            hasWorkingTreeChanges: false,
            workingTree: { files: [], insertions: 0, deletions: 0 },
          },
          event.remote,
        );
      }
      return mergeGitStatusParts(toLocalStatusPart(current), event.remote);
  }
}
