// Masks secrets in text an agent or a thread wrote before it leaves the server. Ordinary sentences
// and numbers stay as they are; a defect's text also loses the project root and the home path.
import { applyCredentialRules, credentialRules } from "../../redact.ts";

const REDACTED = "<redacted>";
// Header, `name: value` and JSON credentials, shared with the merge queue.
const CREDENTIALS = credentialRules(REDACTED);

const SECRET_NAME = /[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL)[A-Za-z0-9_]*/i;

const RULES: ReadonlyArray<readonly [RegExp, (match: string, ...groups: string[]) => string]> = [
  // NAME=value where the name says it holds a secret; the value runs to whitespace or a quote.
  [
    new RegExp(`\\b(${SECRET_NAME.source})=("[^"]*"|'[^']*'|[^\\s"']+)`, "gi"),
    (_match, name) => `${name}=${REDACTED}`,
  ],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, () => `Bearer ${REDACTED}`],
  [/\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}/g, () => REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, () => REDACTED],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, () => REDACTED],
  // User information in a URL's authority.
  [
    /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi,
    (_match, scheme) => `${scheme}${REDACTED}@`,
  ],
  // Long base64 or hex runs with letters and digits; a slash ends one, so paths stay readable.
  [
    /(?<![A-Za-z0-9+_-])(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[A-Za-z])[A-Za-z0-9+_-]{32,}={0,2}(?![A-Za-z0-9+_-])/g,
    () => REDACTED,
  ],
];

/** `text` with secrets masked: secret-named values, bearer and API tokens, URL credentials, long runs. */
export function maskSecrets(text: string): string {
  let masked = text;
  for (const [pattern, replace] of RULES) {
    masked = masked.replace(pattern, replace as (substring: string, ...args: unknown[]) => string);
  }
  return applyCredentialRules(masked, CREDENTIALS);
}

// v1's shorter token prefixes: a defect title quoting a truncated token still loses it.
const SHORT_TOKENS = /\b(?:ghp_|gho_|ghs_|github_pat_|sk-)[A-Za-z0-9_-]{8,}/g;

/** Both separator spellings of `path`. */
const spellings = (path: string) =>
  [...new Set([path, path.replaceAll("\\", "/"), path.replaceAll("/", "\\")])].toSorted(
    (left, right) => right.length - left.length,
  );

/** A defect's text: the project root as `<project>`, the home directory as `~`, secrets masked. */
export function redact(text: string, projectRoot: string | null, home: string | null): string {
  let out = text;
  // The project usually sits under home, so it is replaced first.
  for (const [path, placeholder] of [
    [projectRoot, "<project>"],
    [home, "~"],
  ] as const) {
    if (path === null || path.trim() === "") continue;
    for (const spelling of spellings(path.replace(/[\\/]+$/, ""))) {
      out = out.replaceAll(spelling, placeholder);
    }
  }
  return maskSecrets(out).replace(SHORT_TOKENS, REDACTED);
}
