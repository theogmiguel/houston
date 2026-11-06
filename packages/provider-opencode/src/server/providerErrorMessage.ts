/** OpenCode stores `<none>` when it cannot read the provider body. */
const TITLE_PATTERN = /<title[^>]*>([^<]*)<\/title>/i;
const WHITESPACE_RUN = /\s+/g;

export function readableProviderErrorMessage(
  message?: string,
  status?: number,
  body?: string,
): string | undefined {
  const text = message?.trim() ?? "";
  if (text && text.toLowerCase() !== "<none>") return text;
  const title = body?.match(TITLE_PATTERN)?.[1]?.replace(WHITESPACE_RUN, " ").trim();
  if (title) return typeof status === "number" ? `${title} (HTTP ${status}).` : title;
  if (typeof status === "number") return `The model provider failed the request (HTTP ${status}).`;
  return text
    ? "The model provider failed the request and did not include an error message."
    : undefined;
}
