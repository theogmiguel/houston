import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  ComposerContextClipboardFragment,
} from "@houston-app/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export { COMPOSER_CONTEXT_CLIPBOARD_MIME };

const MAX_FRAGMENT_CHARS = 16_000_000;
const decodeFragment = Schema.decodeUnknownOption(ComposerContextClipboardFragment);

export function encodeComposerContextFragment(
  fragment: ComposerContextClipboardFragment,
): string | null {
  const encoded = JSON.stringify(fragment);
  return encoded.length <= MAX_FRAGMENT_CHARS ? encoded : null;
}

const HTML_WRAPPER_SLACK_CHARS = 4096;

const AMPERSAND = /&/g;
const LESS_THAN = /</g;
const GREATER_THAN = />/g;

export function encodeComposerContextClipboardHtml(
  text: string,
  fragment: string,
  html?: string,
): string {
  if (html !== undefined)
    return `<div data-houston-context-fragment="${encodeURIComponent(fragment)}">${html}</div>`;
  const escaped = text
    .replace(AMPERSAND, "&amp;")
    .replace(LESS_THAN, "&lt;")
    .replace(GREATER_THAN, "&gt;");
  return `<pre data-houston-context-fragment="${encodeURIComponent(fragment)}">${escaped}</pre>`;
}

const CONTEXT_FRAGMENT_ATTRIBUTE = /data-houston-context-fragment=(?:"([^"]+)"|'([^']+)')/;

export function decodeComposerContextClipboardHtml(
  html: string | null | undefined,
): ComposerContextClipboardFragment | null {
  // Percent encoding can expand each UTF-16 code unit to nine characters.
  if (!html || html.length > MAX_FRAGMENT_CHARS * 9 + HTML_WRAPPER_SLACK_CHARS) return null;
  // `encodeURIComponent` leaves `'` as is, so each quote style must end only at its own quote.
  const match = CONTEXT_FRAGMENT_ATTRIBUTE.exec(html);
  const encoded = match?.[1] ?? match?.[2];
  if (!encoded) return null;
  try {
    return decodeComposerContextFragment(decodeURIComponent(encoded));
  } catch {
    return null;
  }
}

export function decodeComposerContextFragment(
  raw: string | null | undefined,
): ComposerContextClipboardFragment | null {
  if (!raw || raw.length > MAX_FRAGMENT_CHARS) return null;
  try {
    return Option.getOrNull(decodeFragment(JSON.parse(raw)));
  } catch {
    return null;
  }
}
