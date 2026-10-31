import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import type { ComposerPathSearchTarget } from "@t3tools/client-runtime/state/threads";
import {
  resolveProviderSkillSourceKind,
  type ProviderSkillSourceKind,
} from "@t3tools/client-runtime/providerSkills";
import {
  type EnvironmentId,
  type EnvironmentMachineKind,
  type ProjectEntry,
  type ProviderDriverKind,
  type PullRequestContextMetadata,
  type ScopedThreadRef,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import {
  BotIcon,
  ChartNoAxesColumnIcon,
  CodeIcon,
  Maximize2Icon,
  MessagesSquareIcon,
  PenLineIcon,
  SparklesIcon,
  TerminalIcon,
  ZapIcon,
} from "lucide-react";
import { memo, useLayoutEffect, useRef } from "react";

import { type ComposerSlashCommand, type ComposerTriggerKind } from "../../composer-logic";
import { cn } from "~/lib/utils";
import { Command, CommandGroup, CommandItem, CommandList } from "../ui/command";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { PierreEntryIcon } from "./PierreEntryIcon";
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
  items: ComposerCommandItem[];
  resolvedTheme: "light" | "dark";
  isLoading: boolean;
  triggerKind: ComposerTriggerKind | null;
  emptyStateText?: string;
  activeItemId: string | null;
  onHighlightedItemChange: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the highlighted menu item's DOM node into view
  useLayoutEffect(() => {
    if (!props.activeItemId || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-composer-item-id="${CSS.escape(props.activeItemId)}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [props.activeItemId]);

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
        className="flex min-h-0 w-full flex-col overflow-hidden rounded-lg border border-(--border) bg-(--raised) p-0.5 text-headline shadow-(--shadow-1)"
        data-composer-command-drawer="true"
      >
        {props.items.length > 0 ? (
          <CommandList
            id={props.listId}
            aria-label={props.triggerKind ? LISTBOX_LABEL_BY_TRIGGER[props.triggerKind] : undefined}
            className="max-h-72 min-h-0 scroll-pb-6"
          >
            <CommandGroup>
              {props.items.map((item) => (
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
              ))}
            </CommandGroup>
          </CommandList>
        ) : (
          <div className="px-3 py-2.5">
            <p className="text-(--t3) text-xs">
              {props.isLoading
                ? props.triggerKind === "skill"
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
          className="col-start-1 row-start-1 size-4 text-(--t3)"
        />
      ) : pullRequestPresentation ? (
        <pullRequestPresentation.Icon
          role="img"
          aria-label={pullRequestPresentation.label}
          className={cn(
            "col-start-1 row-start-1 size-4 text-(--t3)",
            pullRequestPresentation.toneClassName,
          )}
        />
      ) : props.item.type === "environment" ? (
        <EnvironmentMachineIcon
          kind={props.item.machine}
          aria-hidden="true"
          className="col-start-1 row-start-1 size-4 text-(--t3)"
        />
      ) : (
        <ComposerCommandItemGlyph item={props.item} />
      )}
      <span className="col-start-2 row-start-1 min-w-0 truncate text-(--t1) text-headline">
        {isSlashSkill ? (
          <>
            <span className="text-(--t3)">/skill:</span>
            {formatProviderSkillDisplayName(isSlashSkill)}
          </>
        ) : (
          props.item.label
        )}
      </span>
      <span
        className={cn(
          "col-start-2 row-start-2 min-w-0 truncate text-(--t3) text-xs leading-4",
          isPath && "font-mono text-2xs",
        )}
      >
        {props.item.description}
      </span>
      {skillSourceKind ? <SkillSourceBadge kind={skillSourceKind} /> : null}
    </CommandItem>
  );
});

const MENU_ICON_CLASS = "col-start-1 row-start-1 size-4 text-(--t3)";

function ComposerCommandItemGlyph({ item }: { item: ComposerCommandItem }) {
  switch (item.type) {
    case "thread":
      return <MessagesSquareIcon aria-hidden="true" className={MENU_ICON_CLASS} />;
    case "slash-command":
      return item.command === "model" ? (
        <SparklesIcon aria-hidden="true" className={MENU_ICON_CLASS} />
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
    <span className="col-start-3 row-span-2 row-start-1 self-center rounded-(--r-badge) border border-(--line-strong) px-1 font-semibold text-(--t3) text-3xs leading-4">
      {SKILL_SOURCE_LABEL_BY_KIND[props.kind]}
    </span>
  );
}
