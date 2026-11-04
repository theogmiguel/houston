import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { ProviderDriverKind, type ServerProviderSkill } from "@houston-app/contracts";

import "~/index.css";
import { act, render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { ComposerCommandMenu, type ComposerCommandItem } from "./ComposerCommandMenu";
import { searchSlashCommandItems } from "./composerSlashCommandSearch";

type SlashItem = Extract<
  ComposerCommandItem,
  { type: "slash-command" | "provider-slash-command" | "skill" }
>;

const PROVIDER = ProviderDriverKind.make("claudeAgent");

const ITEMS: ReadonlyArray<SlashItem> = [
  {
    id: "slash:model",
    type: "slash-command",
    command: "model",
    label: "/model",
    description: "Switch response model for this thread",
  },
  {
    id: "slash:plan",
    type: "slash-command",
    command: "plan",
    label: "/plan",
    description: "Switch this thread into plan mode",
  },
  {
    id: `provider-slash-command:${PROVIDER}:compact`,
    type: "provider-slash-command",
    provider: PROVIDER,
    command: { name: "compact", description: "Compact the conversation" },
    label: "/compact",
    description: "Compact the conversation",
  },
  {
    id: `provider-slash-command:${PROVIDER}:usage`,
    type: "provider-slash-command",
    provider: PROVIDER,
    command: { name: "usage", description: "Show provider usage" },
    label: "/usage",
    description: "Show provider usage",
  },
  {
    id: `skill:${PROVIDER}:deploy`,
    type: "skill",
    provider: PROVIDER,
    skill: {
      name: "deploy",
      description: "Deploy the app",
      path: "/skills/deploy/SKILL.md",
      enabled: true,
    } satisfies ServerProviderSkill,
    label: "/skill:deploy",
    description: "Deploy the app",
  },
];

function MenuHarness(props: { readonly items: ReadonlyArray<SlashItem> }) {
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const visible = searchSlashCommandItems(props.items, query);

  const step = (direction: "ArrowDown" | "ArrowUp") => {
    if (visible.length === 0) return;
    const index = visible.findIndex((item) => item.id === activeId);
    const from = index >= 0 ? index : direction === "ArrowDown" ? -1 : 0;
    const offset = direction === "ArrowDown" ? 1 : -1;
    setActiveId(visible[(from + offset + visible.length) % visible.length]?.id ?? null);
  };

  return (
    <>
      <input
        aria-label="Filter commands"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveId(null);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          step(event.key);
        }}
      />
      <ComposerCommandMenu
        listId="composer-commands"
        items={visible}
        resolvedTheme="light"
        isLoading={false}
        triggerKind="slash-command"
        activeItemId={activeId}
        onHighlightedItemChange={setActiveId}
        onSelect={() => {}}
      />
    </>
  );
}

const sectionTitles = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-slot="command-group-label"]')).map(
    (label) => label.textContent,
  );

const itemIds = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-composer-item-id]")).map(
    (item) => item.dataset.composerItemId,
  );

const activeItemId = () =>
  document.querySelector<HTMLElement>('[data-composer-item-id][aria-selected="true"]')?.dataset
    .composerItemId ?? null;

const filter = () => page.getByRole("textbox", { name: "Filter commands" });

it("groups commands by origin and keeps the section order", async () => {
  await using _screen = await render(<MenuHarness items={ITEMS} />);

  expect(sectionTitles()).toEqual(["Houston", "Claude", "Skills"]);
  expect(itemIds()).toEqual(ITEMS.map((item) => item.id));
  expect(document.querySelector('[data-slot="command-footer"]')?.textContent).toContain("Navigate");
  expect(document.querySelector('[data-slot="command-footer"]')?.textContent).toContain("Run");
  expect(document.querySelector('[data-slot="command-footer"]')?.textContent).toContain("Close");
});

it("hides an origin's section while filtering leaves it empty", async () => {
  await using _screen = await render(<MenuHarness items={ITEMS} />);

  await act(async () => filter().element().focus());
  await userEvent.type(filter(), "compact");

  expect(sectionTitles()).toEqual(["Claude"]);
  expect(itemIds()).toEqual([`provider-slash-command:${PROVIDER}:compact`]);

  await userEvent.fill(filter(), "plan");

  expect(sectionTitles()).toEqual(["Houston"]);
  expect(itemIds()).toEqual(["slash:plan"]);
});

it("selects a row from any section", async () => {
  const selected: string[] = [];

  await using _screen = await render(
    <ComposerCommandMenu
      listId="composer-commands"
      items={ITEMS}
      resolvedTheme="light"
      isLoading={false}
      triggerKind="slash-command"
      activeItemId={null}
      onHighlightedItemChange={() => {}}
      onSelect={(item) => selected.push(item.id)}
    />,
  );

  await userEvent.click(page.getByText("/skill:deploy"));
  expect(selected).toEqual([`skill:${PROVIDER}:deploy`]);
});

it("shows a truncated description in full on hover", async () => {
  const longDescription =
    "Review the pending changes, run the full test suite and summarise every failure with the file it came from";
  const items: ReadonlyArray<SlashItem> = [
    {
      id: `skill:${PROVIDER}:review-everything`,
      type: "skill",
      provider: PROVIDER,
      skill: {
        name: "review-everything",
        description: longDescription,
        path: "/skills/review-everything/SKILL.md",
        enabled: true,
      },
      label: "/skill:review-everything",
      description: longDescription,
    },
  ];

  await using _screen = await render(
    <div style={{ width: "240px" }}>
      <TooltipProvider delay={0}>
        <ComposerCommandMenu
          listId="composer-commands"
          items={items}
          resolvedTheme="light"
          isLoading={false}
          triggerKind="slash-command"
          activeItemId={null}
          onHighlightedItemChange={() => {}}
          onSelect={() => {}}
        />
      </TooltipProvider>
    </div>,
  );

  await userEvent.hover(page.getByText(longDescription));
  await vi.waitFor(() =>
    expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toContain(
      longDescription,
    ),
  );
});

it("moves the highlight across sections in menu order", async () => {
  await using _screen = await render(<MenuHarness items={ITEMS} />);

  await act(async () => filter().element().focus());

  await userEvent.keyboard("{ArrowDown}");
  expect(activeItemId()).toBe("slash:model");

  await userEvent.keyboard("{ArrowDown}");
  expect(activeItemId()).toBe("slash:plan");

  await userEvent.keyboard("{ArrowDown}");
  expect(activeItemId()).toBe(`provider-slash-command:${PROVIDER}:compact`);

  await userEvent.keyboard("{ArrowDown}");
  expect(activeItemId()).toBe(`provider-slash-command:${PROVIDER}:usage`);

  await userEvent.keyboard("{ArrowDown}");
  expect(activeItemId()).toBe(`skill:${PROVIDER}:deploy`);

  await userEvent.keyboard("{ArrowUp}");
  expect(activeItemId()).toBe(`provider-slash-command:${PROVIDER}:usage`);
});
