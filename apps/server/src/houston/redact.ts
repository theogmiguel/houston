// Credential shapes Houston masks wherever text leaves the server: the merge queue's verification
// output and the harness review's digest. Each caller names its own placeholder.

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
