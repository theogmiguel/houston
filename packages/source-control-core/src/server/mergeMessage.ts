const AGENT_EMAILS = new Set([
  "noreply@anthropic.com",
  "claude@anthropic.com",
  "noreply@openai.com",
  "codex@openai.com",
  "cursoragent@cursor.com",
  "copilot@github.com",
  "noreply@github.com",
]);

const GENERATED_BY_AGENT =
  /^(?:🤖\s*)?generated (?:with|by)\s+(?:claude(?: code)?|codex|cursor|github copilot|copilot|opencode|grok|antigravity)[.!]?$/i;

const LINE_BREAK = /\r?\n/;
const COMMIT_BODY_INDENT = /^(?: {4}|\t)/;
const DELIMITER_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const BLANK_LINE = /^[ \t]*$/;
const DASH_OR_STAR_BULLET = /^(?:[-*]\s+)/;
const AUTHOR_PATTERN = /^co-authored-by:\s*(.*?)\s*<([^<>]+)>\s*$/i;
const AGENT_AUTHOR_PATTERN = /^github copilot$|^copilot$/i;
const FOOTER_PATTERN =
  /\[([^\]]+)\]\(https:\/\/(?:claude\.ai|claude\.com|www\.anthropic\.com|chatgpt\.com|openai\.com|cursor\.com|github\.com|opencode\.ai|x\.ai|antigravity\.google)(?:\/[^\s)]*)?\)/gi;
const TRAILING_BLANK_LINES = /(?:\r?\n[ \t]*)+$/;

export function removeAgentCredits(message: string): string {
  let fence: string | undefined;
  let removed = false;
  const newline = message.includes("\r\n") ? "\r\n" : "\n";
  const lines = message.split(LINE_BREAK).filter((line) => {
    if (COMMIT_BODY_INDENT.test(line)) return true;
    const delimiter = DELIMITER_PATTERN.exec(line);
    const marker = delimiter?.[1];
    const remainder = delimiter?.[2] ?? "";
    if (marker !== undefined) {
      if (fence === undefined) {
        if (marker[0] === "~" || !remainder.includes("`")) fence = marker;
      } else if (
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        BLANK_LINE.test(remainder)
      ) {
        fence = undefined;
      }
      return true;
    }
    if (fence !== undefined) return true;
    const text = line.trim().replace(DASH_OR_STAR_BULLET, "");
    const author = AUTHOR_PATTERN.exec(text);
    // GitHub's generic noreply address is also used by people; require Copilot's name.
    const email = author?.[2]?.toLowerCase();
    const agentAuthor =
      email !== undefined &&
      AGENT_EMAILS.has(email) &&
      (email !== "noreply@github.com" || AGENT_AUTHOR_PATTERN.test(author![1]!));
    const footer = text.replace(FOOTER_PATTERN, "$1");
    if (!agentAuthor && !GENERATED_BY_AGENT.test(footer)) return true;
    removed = true;
    return false;
  });
  return removed ? lines.join(newline).replace(TRAILING_BLANK_LINES, "") : message;
}
