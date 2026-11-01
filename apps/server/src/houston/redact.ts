// Credential shapes and paths Houston masks wherever text leaves the server: the merge queue's
// verification output, the harness review's digest, Slack and Night shift's pull requests.

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A credential-named key, bare or quoted as in JSON, then `=` or `:`.
const KEY = String.raw`\b((?:[A-Za-z0-9_]*(?:token|secret|password|passwd|api[_-]?key))["']?\s*[=:]\s*`;

export type CredentialRules = ReadonlyArray<readonly [RegExp, string]>;

export const credentialRules = (placeholder: string): CredentialRules => [
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, placeholder],
  [/\b(?:glpat|xox[abprs])-[A-Za-z0-9-]{10,}\b/g, placeholder],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, placeholder],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, placeholder],
  [/\b(Authorization:\s*(?:Bearer|Basic|token)\s+)[^\s"']+/gi, `$1${placeholder}`],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, `$1${placeholder}`],
  [new RegExp(`${KEY}")[^"\\n]*"`, "gi"), `$1${placeholder}"`],
  [new RegExp(`${KEY}')[^'\\n]*'`, "gi"), `$1${placeholder}'`],
  [new RegExp(`${KEY})(?!${escape(placeholder)}|["'])[^\\s"',}]+`, "gi"), `$1${placeholder}`],
  [/(\/\/[^/\s:@]+:)[^@\s/]+@/g, `$1${placeholder}@`],
];

export const applyCredentialRules = (text: string, rules: CredentialRules) =>
  rules.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);

// An absolute POSIX or Windows path at a word start, so a URL's path is left alone.
const ABSOLUTE_PATH =
  /(?<=^|[\s'"(=[`])(?:[A-Za-z]:[\\/]|\/)(?:[^\s'"()[\]\\/`]+[\\/])+([^\s'"()[\]\\/`]*)/g;

/** `text` with each absolute path cut to its last part, so no home or user directory is named. */
export const cutAbsolutePaths = (text: string) => text.replace(ABSOLUTE_PATH, "$1");

/** `text` with paths under `root` made relative to it, in either slash form and any case. */
export const relativeToRoot = (text: string, root: string) => {
  const trimmed = root.replace(/[\\/]+$/, "");
  if (trimmed.length === 0) return text;
  const pattern = escape(trimmed).replace(/\\\\|\//g, "[\\\\/]");
  return text.replace(
    new RegExp(`${pattern}(?:([\\\\/])|(?=$|[\\s'"\`)]))`, "gim"),
    (_match, separator: string | undefined) => (separator === undefined ? "." : ""),
  );
};
