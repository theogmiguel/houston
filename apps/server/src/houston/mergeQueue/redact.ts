// Strips terminal colour and redacts credentials from a verification's output before it is
// stored, shown or sent to an agent's provider.
import { applyCredentialRules, credentialRules } from "../redact.ts";

const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

const SECRETS = credentialRules("[redacted]");

export const stripAnsi = (text: string) => text.replace(ANSI, "");

export const redactSecrets = (text: string) => applyCredentialRules(text, SECRETS);
