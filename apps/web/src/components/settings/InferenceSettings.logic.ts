import {
  InferenceServerId,
  type InferenceServerSaveInput,
  type InferenceServerSnapshot,
} from "@houston-app/contracts/houston/inference";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const decodeInferenceServerId = Schema.decodeOption(InferenceServerId);
const TRAILING_SLASHES = /\/+$/;
const NON_ALNUM_RUN = /[^a-z0-9]+/g;
const EDGE_DASHES = /^-+|-+$/g;
const LEADING_LETTER = /^[a-z]/;
const TRAILING_DASHES = /-+$/;

/**
 * An OpenAI-compatible root the server can probe. A bare host gets `/v1`, the root every supported
 * engine serves. Credentials and query strings are refused: they would be stored and shown in plain
 * text, while the API key field is kept as a secret.
 */
export function normalizeInferenceServerBaseUrl(raw: string): Result.Result<string, string> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return Result.fail("Enter the server URL.");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return Result.fail("Enter a full URL, such as http://localhost:11434/v1.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return Result.fail("Use an http:// or https:// URL.");
  }
  if (url.username !== "" || url.password !== "") {
    return Result.fail("Remove the credentials from the URL and put the key in API key.");
  }
  if (url.search !== "" || trimmed.includes("?")) {
    return Result.fail("Remove the query string; put any key in API key.");
  }
  if (url.hash !== "" || trimmed.includes("#")) {
    return Result.fail("Remove the #fragment from the URL.");
  }
  const path = url.pathname.replace(TRAILING_SLASHES, "");
  return Result.succeed(`${url.origin}${path === "" ? "/v1" : path}`);
}

/** Stable and readable in settings, so re-adding a server under the same name keeps its id. */
export function inferenceServerIdFromName(name: string): InferenceServerId | null {
  const slug = name.toLowerCase().replace(NON_ALNUM_RUN, "-").replace(EDGE_DASHES, "");
  if (slug === "") return null;
  const id = (LEADING_LETTER.test(slug) ? slug : `server-${slug}`)
    .slice(0, 64)
    .replace(TRAILING_DASHES, "");
  return Option.getOrNull(decodeInferenceServerId(id));
}

export interface InferenceServerDraft {
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly maxConcurrentRequests: string;
}

export const EMPTY_INFERENCE_SERVER_DRAFT: InferenceServerDraft = {
  name: "",
  baseUrl: "",
  apiKey: "",
  maxConcurrentRequests: "",
};

export function draftFromInferenceServer(
  snapshot: Pick<InferenceServerSnapshot, "displayName" | "baseUrl" | "maxConcurrentRequests">,
): InferenceServerDraft {
  return {
    name: snapshot.displayName,
    baseUrl: snapshot.baseUrl,
    // A saved key never reaches the client; leaving this blank keeps it.
    apiKey: "",
    maxConcurrentRequests:
      snapshot.maxConcurrentRequests === undefined ? "" : String(snapshot.maxConcurrentRequests),
  };
}

export type InferenceServerTarget =
  | { readonly mode: "add" }
  | { readonly mode: "edit"; readonly id: InferenceServerId; readonly enabled: boolean };

export type InferenceServerDraftIssues = {
  readonly [Field in keyof InferenceServerDraft]?: string;
};

/** The RPC input a draft adds or replaces, or every field that blocks it, one message each. */
export function inferenceServerFromDraft(
  draft: InferenceServerDraft,
  existingIds: ReadonlySet<string>,
  target: InferenceServerTarget,
): Result.Result<InferenceServerSaveInput, InferenceServerDraftIssues> {
  const issues: { -readonly [Field in keyof InferenceServerDraft]?: string } = {};
  const baseUrl = normalizeInferenceServerBaseUrl(draft.baseUrl);
  if (Result.isFailure(baseUrl)) issues.baseUrl = baseUrl.failure;

  const name = draft.name.trim();
  let id: InferenceServerId | null = null;
  if (target.mode === "edit") {
    id = target.id;
  } else {
    let host = "";
    if (Result.isSuccess(baseUrl)) host = new URL(baseUrl.success).hostname;
    id = inferenceServerIdFromName(name || host);
    if (id === null && name !== "") issues.name = "The name needs at least one letter or digit.";
    else if (id !== null && existingIds.has(id)) issues.name = "A server with this name exists.";
  }

  const concurrencyText = draft.maxConcurrentRequests.trim();
  const maxConcurrentRequests = concurrencyText === "" ? undefined : Number(concurrencyText);
  if (
    maxConcurrentRequests !== undefined &&
    (!Number.isInteger(maxConcurrentRequests) || maxConcurrentRequests < 1)
  ) {
    issues.maxConcurrentRequests = "Enter a whole number of 1 or more, or leave it empty.";
  }

  const apiKey = draft.apiKey.trim();
  if (id === null || Result.isFailure(baseUrl) || Object.keys(issues).length > 0) {
    return Result.fail(issues);
  }
  return Result.succeed({
    id,
    ...(name === "" ? {} : { displayName: name }),
    baseUrl: baseUrl.success,
    ...(apiKey === "" ? {} : { apiKey }),
    enabled: target.mode === "edit" ? target.enabled : true,
    ...(maxConcurrentRequests === undefined ? {} : { maxConcurrentRequests }),
  });
}
