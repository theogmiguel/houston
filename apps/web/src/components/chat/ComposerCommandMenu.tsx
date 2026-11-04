import { formatProviderSkillDisplayName } from "@houston-app/shared/inlineSkills";
import type { ComposerPathSearchTarget } from "@houston-app/client-runtime/state/threads";
import {
  resolveProviderSkillSourceKind,
  type ProviderSkillSourceKind,
} from "@houston-app/client-runtime/providerSkills";
import {
  type EnvironmentId,
  type EnvironmentMachineKind,
  type ProjectEntry,
  type ProviderDriverKind,
  type PullRequestContextMetadata,
  type ScopedThreadRef,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@houston-app/contracts";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BotIcon,
  ChartNoAxesColumnIcon,
  ChromeIcon,
  CodeIcon,
  CornerDownLeftIcon,
  Maximize2Icon,
  MessagesSquareIcon,
  PenLineIcon,
  SparklesIcon,
  TerminalIcon,
  ZapIcon,
} from "lucide-react";
import { memo, useLayoutEffect, useRef, useState } from "react";

import { type ComposerSlashCommand, type ComposerTriggerKind } from "../../composer-logic";
import { cn } from "~/lib/utils";
import { observeResize } from "~/lib/observeResize";
import {
  Command,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandItem,
  CommandList,
} from "../ui/command";
import { Kbd, KbdGroup } from "../ui/kbd";
import { overlayMotion } from "../ui/overlayMotion";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { PierreEntryIcon } from "./PierreEntryIcon";
import { slashCommandSections } from "./composerSlashCommandSearch";
import { resolvePullRequestState } from "../pullRequest/pullRequestPresentation";

export type ComposerCommandItem =
  | {
      id: string;
      type: "path";
      path: string;
      pathKind: ProjectEntry["kind"];
      searchTarget: ComposerPathSearchTarget;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "slash-command";
      command: ComposerSlashCommand;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "provider-slash-command";
      provider: ProviderDriverKind;
      command: ServerProviderSlashCommand;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "skill";
      provider: ProviderDriverKind;
      skill: ServerProviderSkill;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "pull-request";
      pullRequest: PullRequestContextMetadata;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "thread";
      thread: ScopedThreadRef;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "environment";
      environmentId: EnvironmentId;
      machine: EnvironmentMachineKind;
      label: string;
      description: string;
    };

export const ComposerCommandMenu = memo(function ComposerCommandMenu(props: {
  listId: string;
  items: ReadonlyArray<ComposerCommandItem>;
  resolvedTheme: "light" | "dark";
  isLoading: boolean;
  triggerKind: ComposerTriggerKind | null;
  emptyStateText?: string;
  activeItemId: string | null;
  onHighlightedItemChange: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- scrolls the highlighted menu item's DOM node into view
  useLayoutEffect(() => {
    if (!props.activeItemId || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-composer-item-id="${CSS.escape(props.activeItemId)}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [props.activeItemId]);

  const sections = props.triggerKind === "slash-command" ? slashCommandSections(props.items) : null;
  const renderItem = (item: ComposerCommandItem) => (
    <ComposerCommandMenuItem
      key={item.id}
      optionId={composerSuggestionOptionId(props.listId, item.id)}
      item={item}
      triggerKind={props.triggerKind}
      resolvedTheme={props.resolvedTheme}
      isActive={props.activeItemId === item.id}
      onHighlight={props.onHighlightedItemChange}
      onSelect={props.onSelect}
    />
  );

  return (
    <Command
      autoHighlight={false}
      mode="none"
      onItemHighlighted={(highlightedValue) => {
        props.onHighlightedItemChange(
          typeof highlightedValue === "string" ? highlightedValue : null,
        );
      }}
    >
      <div
        ref={listRef}
        className={cn(
          overlayMotion,
          "origin-bottom flex min-h-0 w-full flex-col overflow-hidden rounded-lg border border-(--border) bg-(--raised) p-0.5 text-headline shadow-(--shadow-1)",
        )}
        data-composer-command-drawer="true"
      >
        {props.items.length > 0 ? (
          <>
            <CommandList
              id={props.listId}
              aria-label={
                props.triggerKind ? LISTBOX_LABEL_BY_TRIGGER[props.triggerKind] : undefined
              }
              className="max-h-72 min-h-0 scroll-pb-6"
            >
              {sections ? (
                sections.map((section) => (
                  <CommandGroup key={section.id}>
                    <CommandGroupLabel>{section.title}</CommandGroupLabel>
                    {section.items.map(renderItem)}
                  </CommandGroup>
                ))
              ) : (
                <CommandGroup>{props.items.map(renderItem)}</CommandGroup>
              )}
            </CommandList>
            {sections ? <ComposerCommandMenuHints /> : null}
          </>
        ) : (
          <div className="px-3 py-2.5">
            <p className="text-(--houston) text-xs">
              {props.isLoading
                ? props.triggerKind === "skill" || props.triggerKind === "slash-command"
                  ? "Searching workspace skills..."
                  : props.triggerKind === "pull-request"
                    ? "Finding pull request..."
                    : "Searching workspace files..."
                : (props.emptyStateText ??
                  (props.triggerKind === "skill"
                    ? "No skills found. Try / to browse provider commands."
                    : props.triggerKind === "path"
                      ? "No matching files or folders."
                      : "No matching command."))}
            </p>
          </div>
        )}
      </div>
    </Command>
  );
});

const ComposerCommandMenuItem = memo(function ComposerCommandMenuItem(props: {
  optionId: string;
  item: ComposerCommandItem;
  triggerKind: ComposerTriggerKind | null;
  resolvedTheme: "light" | "dark";
  isActive: boolean;
  onHighlight: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const skillSourceKind =
    props.item.type === "skill" ? resolveProviderSkillSourceKind(props.item.skill) : null;
  const isSlashSkill =
    props.triggerKind === "slash-command" && props.item.type === "skill" ? props.item.skill : null;
  const pullRequestPresentation =
    props.item.type === "pull-request" ? resolvePullRequestState(props.item.pullRequest) : null;
  const isPath = props.item.type === "path";

  return (
    <CommandItem
      render={<div id={props.optionId} />}
      aria-selected={props.isActive}
      value={props.item.id}
      data-composer-item-id={props.item.id}
      active={props.isActive}
      onMouseMove={() => {
        if (!props.isActive) props.onHighlight(props.item.id);
      }}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onSelect(props.item);
      }}
      className="grid min-h-7 cursor-pointer grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 rounded-(--r-ctl) px-2 py-1 text-headline leading-4 outline-none sm:text-headline hover:bg-(--hover)! data-[active=true]:bg-(--sel)! data-[active=true]:text-(--t1)!"
    >
      {props.item.type === "path" ? (
        <PierreEntryIcon
          pathValue={props.item.path}
          kind={props.item.pathKind}
          theme={props.resolvedTheme}
          className="col-start-1 row-start-1 size-4 text-(--houston)"
        />
      ) : pullRequestPresentation ? (
        <pullRequestPresentation.Icon
          role="img"
          aria-label={pullRequestPresentation.label}
          className={cn(
            "col-start-1 row-start-1 size-4 text-(--houston)",
            pullRequestPresentation.toneClassName,
          )}
        />
      ) : props.item.type === "environment" ? (
        <EnvironmentMachineIcon
          kind={props.item.machine}
          aria-hidden="true"
          className="col-start-1 row-start-1 size-4 text-(--houston)"
        />
      ) : (
        <ComposerCommandItemGlyph item={props.item} />
      )}
      <span className="col-start-2 row-start-1 min-w-0 truncate text-(--t1) text-headline">
        {isSlashSkill ? (
          <>
            <span className="text-(--houston)">/skill:</span>
            {formatProviderSkillDisplayName(isSlashSkill)}
          </>
        ) : (
          props.item.label
        )}
      </span>
      <ComposerCommandItemDescription
        text={props.item.description}
        className={cn(
          "col-start-2 row-start-2 min-w-0 truncate text-(--houston) text-xs leading-4",
          isPath && "font-mono text-2xs",
        )}
      />
      {skillSourceKind ? <SkillSourceBadge kind={skillSourceKind} /> : null}
    </CommandItem>
  );
});

const ComposerCommandItemDescription = memo(function ComposerCommandItemDescription(props: {
  text: string;
  className: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [isTruncated, setIsTruncated] = useState(false);

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- the tooltip is offered only while the one-line description overflows its cell
  useLayoutEffect(() => {
    const element = ref.current;
    if (element) setIsTruncated(element.scrollWidth > element.clientWidth);
  });

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- a narrower composer can truncate the description without the text changing
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    return observeResize(element, () => {
      setIsTruncated(element.scrollWidth > element.clientWidth);
    });
  }, []);

  const description = (
    <span ref={ref} className={props.className}>
      {props.text}
    </span>
  );
  if (!props.text || !isTruncated) return description;
  return (
    <Tooltip>
      <TooltipTrigger render={description} />
      <TooltipPopup>{props.text}</TooltipPopup>
    </Tooltip>
  );
});

function ComposerCommandMenuHints() {
  return (
    <CommandFooter>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <KbdGroup>
          <Kbd>
            <ArrowUpIcon />
          </Kbd>
          <Kbd>
            <ArrowDownIcon />
          </Kbd>
          <span>Navigate</span>
        </KbdGroup>
        <KbdGroup>
          <Kbd>
            <CornerDownLeftIcon />
          </Kbd>
          <span>Run</span>
        </KbdGroup>
        <KbdGroup>
          <Kbd>Esc</Kbd>
          <span>Close</span>
        </KbdGroup>
      </div>
    </CommandFooter>
  );
}

const MENU_ICON_CLASS = "col-start-1 row-start-1 size-4 text-(--houston)";

function ComposerCommandItemGlyph({ item }: { item: ComposerCommandItem }) {
  switch (item.type) {
    case "thread":
      return <MessagesSquareIcon aria-hidden="true" className={MENU_ICON_CLASS} />;
    case "slash-command":
      return item.command === "model" ? (
        <SparklesIcon aria-hidden="true" className={MENU_ICON_CLASS} />
      ) : item.command === "chrome" ? (
        <ChromeIcon aria-hidden="true" className={MENU_ICON_CLASS} />
      ) : item.command === "plan" ? (
        <PenLineIcon aria-hidden="true" className={MENU_ICON_CLASS} />
      ) : (
        <BotIcon aria-hidden="true" className={MENU_ICON_CLASS} />
      );
    case "provider-slash-command":
      return providerSlashCommandGlyph(item.command.name);
    case "skill":
      return <ZapIcon aria-hidden="true" className={MENU_ICON_CLASS} />;
    default:
      return null;
  }
}

function providerSlashCommandGlyph(name: string) {
  const normalized = name.toLowerCase();
  if (normalized.includes("compact")) {
    return <Maximize2Icon aria-hidden="true" className={MENU_ICON_CLASS} />;
  }
  if (normalized.includes("usage")) {
    return <ChartNoAxesColumnIcon aria-hidden="true" className={MENU_ICON_CLASS} />;
  }
  if (normalized === "review") {
    return <CodeIcon aria-hidden="true" className={MENU_ICON_CLASS} />;
  }
  return <TerminalIcon aria-hidden="true" className={MENU_ICON_CLASS} />;
}

export function composerSuggestionOptionId(listId: string, itemId: string): string {
  // JSON escapes lone UTF-16 surrogates before URI encoding without losing identity.
  return `${listId}-${encodeURIComponent(JSON.stringify(itemId))}`;
}

const LISTBOX_LABEL_BY_TRIGGER: Record<ComposerTriggerKind, string> = {
  path: "Files and folders",
  "pull-request": "Pull requests",
  "slash-command": "Commands",
  skill: "Skills",
};

const SKILL_SOURCE_LABEL_BY_KIND: Record<ProviderSkillSourceKind, string> = {
  app: "App",
  repo: "Repo",
  project: "Project",
  personal: "Personal",
  system: "System",
  other: "Provider",
};

function SkillSourceBadge(props: { kind: ProviderSkillSourceKind }) {
  return (
    <span className="col-start-3 row-span-2 row-start-1 self-center rounded-(--r-badge) border border-(--line-strong) px-1 font-semibold text-(--houston) text-3xs leading-4">
      {SKILL_SOURCE_LABEL_BY_KIND[props.kind]}
    </span>
  );
}
