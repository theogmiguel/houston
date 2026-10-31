// Strips terminal colour and redacts credentials from a verification's output before it is
// stored, shown or sent to an agent's provider.
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

const REDACTED = "[redacted]";

// A credential-named key, bare or quoted as in JSON, then `=` or `:`.
const KEY = String.raw`\b((?:[A-Za-z0-9_]*(?:token|secret|password|passwd|api[_-]?key))["']?\s*[=:]\s*`;

const SECRETS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, REDACTED],
  [/\b(?:glpat|xox[abprs])-[A-Za-z0-9-]{10,}\b/g, REDACTED],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, REDACTED],
  [/\b(Authorization:\s*(?:Bearer|Basic|token)\s+)\S+/gi, `$1${REDACTED}`],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, `$1${REDACTED}`],
  [new RegExp(`${KEY}")[^"\\n]*"`, "gi"), `$1${REDACTED}"`],
  [new RegExp(`${KEY}')[^'\\n]*'`, "gi"), `$1${REDACTED}'`],
  [new RegExp(`${KEY})(?!\\[redacted\\]|["'])[^\\s"',}]+`, "gi"), `$1${REDACTED}`],
  [/(\/\/[^/\s:@]+:)[^@\s/]+@/g, `$1${REDACTED}@`],
];

export const stripAnsi = (text: string) => text.replace(ANSI, "");

export const redactSecrets = (text: string) =>
  SECRETS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);
