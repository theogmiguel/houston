import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { ProviderDriverKind, type ServerProviderSkill } from "@houston-app/contracts";

import "~/index.css";
import { act, render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import {
  availableTerminalCommandEntries,
  resolveTerminalCommand,
  TERMINAL_COMMAND_ENTRIES,
  type TerminalActionId,
} from "../../composerTerminalCommands";
import { parseTerminalOnlySlashCommand } from "../../composer-logic";
import { ComposerCommandMenu, type ComposerCommandItem } from "./ComposerCommandMenu";
import { searchSlashCommandItems, terminalCommandSlashItems } from "./composerSlashCommandSearch";

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

it("grows the drawer from the composer edge on the overlay role", async () => {
  await using _screen = await render(<MenuHarness items={ITEMS} />);

  const drawer = document.querySelector<HTMLElement>('[data-composer-command-drawer="true"]')!;
  const style = getComputedStyle(drawer);
  expect(style.transitionProperty).toBe("opacity, scale");
  expect(style.transitionDuration).toBe("0.15s");
  expect(style.transitionTimingFunction).toBe("cubic-bezier(0.2, 0, 0, 1)");
});

const TERMINAL_ACTIONS: ReadonlySet<TerminalActionId> = new Set(
  TERMINAL_COMMAND_ENTRIES.map((entry) => entry.action),
);

const TERMINAL_ITEMS = terminalCommandSlashItems(
  availableTerminalCommandEntries({ availableActions: TERMINAL_ACTIONS, providerCommandNames: [] }),
);

function TerminalCommandHarness(props: {
  readonly onAction: (action: TerminalActionId) => void;
  readonly onSend: (text: string) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const visible = searchSlashCommandItems(
    TERMINAL_ITEMS,
    prompt.startsWith("/") ? prompt.slice(1) : "",
  );

  const run = (action: TerminalActionId) => {
    props.onAction(action);
    setPrompt("");
    setNotice(null);
  };
  const submit = () => {
    const command = resolveTerminalCommand(prompt, {
      availableActions: TERMINAL_ACTIONS,
      providerCommandNames: [],
    });
    if (command) {
      run(command.entry.action);
      return;
    }
    const terminalOnly = parseTerminalOnlySlashCommand(prompt, []);
    if (terminalOnly) {
      setNotice(`Claude does not run /${terminalOnly.name}. Nothing was sent.`);
      return;
    }
    props.onSend(prompt);
  };

  return (
    <>
      <input
        aria-label="Message"
        value={prompt}
        onChange={(event) => {
          setPrompt(event.target.value);
          setNotice(null);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          submit();
        }}
      />
      {notice === null ? null : <p role="status">{notice}</p>}
      {visible.length === 0 ? null : (
        <ComposerCommandMenu
          listId="terminal-commands"
          items={visible}
          resolvedTheme="light"
          isLoading={false}
          triggerKind="slash-command"
          activeItemId={null}
          onHighlightedItemChange={() => {}}
          onSelect={(item) => {
            if (item.type === "terminal-command") run(item.entry.action);
          }}
        />
      )}
    </>
  );
}

it("picking /rewind from the menu opens rewind", async () => {
  const actions: TerminalActionId[] = [];
  await using _screen = await render(
    <TerminalCommandHarness onAction={(action) => actions.push(action)} onSend={() => {}} />,
  );

  const input = page.getByRole("textbox", { name: "Message" });
  await act(async () => input.element().focus());
  await userEvent.type(input, "/rew");
  await userEvent.click(page.getByText("/rewind"));

  expect(actions).toEqual(["rewind"]);
});

it("typing /rewind and pressing Enter opens rewind instead of sending", async () => {
  const actions: TerminalActionId[] = [];
  const sends: string[] = [];
  await using _screen = await render(
    <TerminalCommandHarness
      onAction={(action) => actions.push(action)}
      onSend={(text) => sends.push(text)}
    />,
  );

  const input = page.getByRole("textbox", { name: "Message" });
  await act(async () => input.element().focus());
  await userEvent.type(input, "/rewind");
  await userEvent.keyboard("{Enter}");

  expect(actions).toEqual(["rewind"]);
  expect(sends).toEqual([]);
});

it("a terminal-only name answers locally and sends nothing", async () => {
  const sends: string[] = [];
  await using _screen = await render(
    <TerminalCommandHarness onAction={() => {}} onSend={(text) => sends.push(text)} />,
  );

  const input = page.getByRole("textbox", { name: "Message" });
  await act(async () => input.element().focus());
  await userEvent.fill(input, "/terminal-setup");
  await userEvent.keyboard("{Enter}");

  expect(sends).toEqual([]);
  expect(page.getByRole("status").element().textContent).toContain("/terminal-setup");
});
