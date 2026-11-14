import { EnvironmentId, MessageId, ThreadId } from "@houston-app/contracts";
import { serializeAssistantCitation } from "@houston-app/shared/assistantCitations";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";

vi.mock(import("@tanstack/react-router"), async (importOriginal) => ({
  ...(await importOriginal()),
  useNavigate: () => vi.fn(),
  Link: (({
    children,
    to: _to,
    params: _params,
    hash: _hash,
    resetScroll: _resetScroll,
    ...props
  }: {
    children: ReactNode;
    [key: string]: unknown;
  }) => <a {...props}>{children}</a>) as never,
}));

import ChatMarkdown from "../ChatMarkdown";

const citation = {
  version: 1 as const,
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make("source"),
  text: "Done. I added clamp next to sum.",
  start: 0,
  end: 32,
  prefix: "",
  suffix: "",
};

function renderMessage(text: string, width = 480) {
  return render(
    <div style={{ width }} data-testid="lane">
      <ChatMarkdown text={text} cwd={undefined} />
    </div>,
  );
}

const cards = () => [...document.querySelectorAll<HTMLElement>("[data-assistant-citation-card]")];

describe("a quoted response in a sent message", () => {
  it("shows the quote as an inset card with the typed text below it", async () => {
    await using _screen = await renderMessage(
      `${serializeAssistantCitation(citation)}\n\nwhy there?`,
    );
    expect(cards()).toHaveLength(1);
    const card = cards()[0]!;
    expect(card.textContent).toBe(citation.text);
    expect(card.textContent).not.toContain("houston-citation");
    expect(card.getAttribute("aria-label")).toContain("Go to quoted response");
    expect(document.body.textContent).toContain("why there?");
    // The card sits above the typed text.
    const typed = [...document.querySelectorAll("p")].find((p) => p.textContent === "why there?")!;
    expect(card.compareDocumentPosition(typed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows the comment of a selected quote under its card", async () => {
    await using _screen = await renderMessage(
      serializeAssistantCitation({ ...citation, comment: "Check the edge case" }),
    );
    expect(cards()[0]!.textContent).toBe(citation.text);
    expect(document.body.textContent).toContain("Check the edge case");
  });

  it("clamps a very long quote and leaves the full text to the source link", async () => {
    const long = `${"A long quoted paragraph with many words. ".repeat(40)}end`;
    await using _screen = await renderMessage(
      serializeAssistantCitation({ ...citation, text: long, end: long.length }),
    );
    const card = cards()[0]!;
    const clamped = card.querySelector<HTMLElement>("[data-assistant-citation-quote]")!;
    expect(getComputedStyle(clamped).webkitLineClamp).toBe("3");
    expect(clamped.scrollHeight).toBeGreaterThan(clamped.clientHeight);
    expect(card.clientHeight).toBeLessThan(120);
    expect(card.tagName).toBe("A");
  });

  it("renders markdown and code in the quote as literal text", async () => {
    const quoted = "Use **bold** and `code`\n\n```ts\nconst a = <b>x</b>;\n```";
    await using _screen = await renderMessage(
      serializeAssistantCitation({ ...citation, text: quoted, end: quoted.length }),
    );
    const card = cards()[0]!;
    expect(card.querySelector("strong, code, pre, b")).toBeNull();
    expect(card.textContent).toBe(quoted.replace(/\s+/g, " "));
  });

  it("shows one card per quote when a message carries several", async () => {
    const second = { ...citation, messageId: MessageId.make("other"), text: "Second answer." };
    await using _screen = await renderMessage(
      `${serializeAssistantCitation(citation)}\n\n${serializeAssistantCitation(second)}\n\nboth?`,
    );
    expect(cards().map((card) => card.textContent)).toEqual([citation.text, second.text]);
  });

  it("stays inside a 370px lane even for an unbroken string", async () => {
    const unbroken = "x".repeat(400);
    await using screen = await renderMessage(
      serializeAssistantCitation({ ...citation, text: unbroken, end: 400 }),
      370,
    );
    const lane = screen.container.querySelector<HTMLElement>('[data-testid="lane"]')!;
    const card = cards()[0]!;
    expect(card.getBoundingClientRect().right).toBeLessThanOrEqual(
      lane.getBoundingClientRect().right + 0.5,
    );
    expect(lane.scrollWidth).toBeLessThanOrEqual(lane.clientWidth);
  });

  it.each(["light", "dark"] as const)("paints a visible inset in the %s theme", async (theme) => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    try {
      await using _screen = await renderMessage(serializeAssistantCitation(citation));
      expect(getComputedStyle(cards()[0]!).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    } finally {
      root.classList.remove("dark");
    }
  });
});
