import { scopedThreadKey, scopeThreadRef } from "@houston-app/client-runtime/environment";
import { findForMessageMatch, openThreadFindOnQuery } from "./chat/threadFindStore";
import {
  claimThreadOpen,
  nextShownOrder,
  type EnvironmentThreadSearchMatch,
  type ShownOrder,
} from "@houston-app/client-runtime/state/thread-search";
import {
  foldSearchQuery,
  PALETTE_MESSAGE_LIMIT,
  pickedQuery,
  rankMessageMatches,
} from "@houston-app/shared/paletteSearch";
import type { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { MessageSquareIcon } from "lucide-react";
import { squashAtomCommandFailure } from "@houston-app/client-runtime/state/runtime";
import { connectPairing as connectPairingAtom } from "../connection/onboarding";
import { dispatchCommandPalette } from "../commandPaletteStore";
import { peerLinkEnvironment } from "../state/peerLinks";
import { openThreadInLayout } from "../threads/openThreadInLayout";
import { useState } from "react";
import { CommandResultConnected, CommandResultConnecting } from "./ui/command-result-meta";

import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../providerInstances";
import { useVisibleThreadShells } from "../state/entities";
import {
  useEnvironmentProviders,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../state/environments";
import { useLinkedThreadSearch, useThreadSearch } from "../state/queries";
import { primaryServerProvidersAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { resolveThreadRowState } from "../threads/sidebarModel";
import { ThreadStatusGlyph } from "./sidebar/threadStatusMark";
import { formatRelativeTimeLabel } from "../timestampFormat";
import {
  buildLinkedMachineActionItems,
  buildThreadActionItems,
  ITEM_ICON_CLASS,
} from "./CommandPalette.logic";
import { useEnvironmentLookups, useProjectLookups } from "./CommandPaletteLookups";
import { ThreadCommandSubtitle } from "./ThreadCommandSubtitle";
import { ThreadRowTrailingStatus, ThreadSearchPullRequestNumber } from "./ThreadStatusIndicators";

function useProviderEntryByEnvironmentAndInstanceId() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const providersByEnvironment = useEnvironmentProviders();
  return new Map<string, ProviderInstanceEntry>(
    environments.flatMap((environment) => {
      const serverConfig = environment.serverConfig;
      const derived = deriveProviderInstanceEntries(
        providersByEnvironment.get(environment.environmentId) ??
          (environment.environmentId === primaryEnvironmentId ? providers : []),
      );
      const entries = serverConfig
        ? applyProviderInstanceSettings(derived, serverConfig.settings, null)
        : derived;
      return entries.map(
        (entry) => [`${environment.environmentId}:${entry.instanceId}`, entry] as const,
      );
    }),
  );
}

function useConnectedThreadSearch(query: string) {
  const { environments } = useEnvironments();
  const { projectEnvironmentLocationById } = useEnvironmentLookups();
  const environmentIds: ReadonlyArray<EnvironmentId> = environments
    .filter((environment) => environment.connection.phase === "connected")
    .map((environment) => environment.environmentId);
  // The palette matches environment names when there are several; older rows must match the same.
  const environmentLabels =
    environments.length > 1
      ? Object.fromEntries(
          environmentIds.flatMap((environmentId) => {
            const label = projectEnvironmentLocationById.get(environmentId)?.label;
            return label === undefined || label === null ? [] : [[environmentId, label]];
          }),
        )
      : undefined;
  return useThreadSearch(
    environmentIds,
    query,
    environmentLabels === undefined ? {} : { environmentLabels },
  );
}

/**
 * Every visible thread as a palette item, plus, for a non-empty
 * `threadSearchQuery`, the threads whose messages match, best first.
 */
export function useCommandPaletteThreadItems(input: {
  readonly activeThread: { readonly environmentId: EnvironmentId; readonly id: ThreadId } | null;
  readonly threadSearchQuery: string;
  /** Opens the add-environment dialog with a linked machine's host prefilled. */
  readonly onRequestAddEnvironment?: (host: string) => void;
}) {
  const { activeThread, threadSearchQuery } = input;
  const navigate = useNavigate();
  const router = useRouter();
  const threads = useVisibleThreadShells();
  const { projectEnvironmentLocationById } = useEnvironmentLookups();
  const providerEntryByEnvironmentAndInstanceId = useProviderEntryByEnvironmentAndInstanceId();
  const messageSearch = useConnectedThreadSearch(threadSearchQuery);
  const linkedSearch = useLinkedThreadSearch(threadSearchQuery);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const pairClient = useAtomCommand(peerLinkEnvironment.pairClient, { reportFailure: false });
  const connectPairing = useAtomCommand(connectPairingAtom, { reportFailure: false });
  const [linkedRow, setLinkedRow] = useState<
    | { readonly kind: "connecting"; readonly value: string }
    | { readonly kind: "connected"; readonly value: string }
    | { readonly kind: "failed"; readonly value: string; readonly message: string }
    | null
  >(null);
  const { projectByKey } = useProjectLookups();
  const visitThread = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  // Ranking is relative to when the palette opened, so rows do not reorder as time passes.
  const [now] = useState(() => Date.now());
  const nowIso = new Date(now).toISOString();

  const { environments } = useEnvironments();
  const threadItems = buildThreadActionItems({
    threads,
    ...(environments.length > 1
      ? {
          environmentLabelOf: (thread: (typeof threads)[number]) =>
            projectEnvironmentLocationById.get(thread.environmentId)?.label ?? null,
        }
      : {}),
    ...(activeThread ? { activeThread } : {}),
    projectByKey,
    icon: null,
    renderIcon: (thread) => (
      <ThreadStatusGlyph thread={thread} state={resolveThreadRowState(thread, nowIso)} />
    ),
    renderTrailingContent: (thread) => <ThreadRowTrailingStatus thread={thread} />,
    renderDescription: (thread, { projectTitle }) => {
      const modelInstanceId =
        thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
      const providerEntry =
        providerEntryByEnvironmentAndInstanceId.get(`${thread.environmentId}:${modelInstanceId}`) ??
        null;
      return (
        <ThreadCommandSubtitle
          projectTitle={projectTitle ?? null}
          environmentLabel={
            projectEnvironmentLocationById.get(thread.environmentId)?.label ?? "Remote"
          }
          branch={thread.branch}
          worktreePath={thread.worktreePath}
          isCurrent={
            thread.id === activeThread?.id && thread.environmentId === activeThread.environmentId
          }
          pullRequest={
            thread.linkedPullRequest != null ||
            thread.branchPullRequest != null ||
            (thread.pullRequests?.length ?? 0) > 0 ? (
              <ThreadSearchPullRequestNumber
                thread={thread}
                query={threadSearchQuery}
                always
                settled={thread.settledOverride === "settled"}
              />
            ) : null
          }
          driverKind={providerEntry?.driverKind ?? null}
          providerDisplayName={
            thread.runtime?.providerName ?? providerEntry?.displayName ?? modelInstanceId
          }
          acpRegistryAgentId={providerEntry?.acpRegistryAgentId}
          acpRegistryIconUrl={providerEntry?.acpRegistryIconUrl}
        />
      );
    },
    runThread: async (thread) => {
      // A pick sends its open with the query, always, so the server records
      // it; the thread view then skips its own open. The open thread is no pick.
      const isOpen =
        activeThread?.environmentId === thread.environmentId && activeThread.id === thread.id;
      if (threadSearchQuery.trim().length > 0 && !threadSearchQuery.startsWith(">") && !isOpen) {
        // oxlint-disable-next-line react/purity -- runs in an event handler (oxc#27309)
        claimThreadOpen(thread.environmentId, thread.id, Date.now());
      }
      if (
        threadSearchQuery.trim().length > 0 &&
        !threadSearchQuery.startsWith(">") &&
        thread.lastVisitedAt !== undefined &&
        !isOpen
      ) {
        void visitThread({
          environmentId: thread.environmentId,
          input: {
            threadId: thread.id,
            visitedAt: thread.updatedAt,
            opened: true,
            searchQuery: pickedQuery(threadSearchQuery),
          },
        });
      }
      await openThreadInLayout(
        {
          navigate: (options) => navigate(options),
          pathname: () => router.state.location.pathname,
        },
        scopeThreadRef(thread.environmentId, thread.id),
      );
    },
  });

  const itemByValue = new Map(threadItems.map((item) => [item.value, item]));
  const itemForMatch = (match: EnvironmentThreadSearchMatch) =>
    itemByValue.get(`thread:${match.environmentId}:${match.threadId}`);
  const rankedMessageItems = rankMessageMatches(
    messageSearch.matches,
    (match) => itemForMatch(match)?.threadSearch,
    foldSearchQuery(threadSearchQuery),
    now,
    { withoutTitleMatches: true },
  ).flatMap((match) => {
    const item = itemForMatch(match);
    if (!item) return [];
    // The snippet replaces the project line, so a message row is as tall as a title row.
    const { description: _description, ...rest } = item;
    return [
      {
        ...rest,
        // When the matching message was written, not when the thread last moved.
        ...(match.messageCreatedAt
          ? { timestamp: formatRelativeTimeLabel(match.messageCreatedAt) }
          : {}),
        threadContentMatch: {
          source: match.source,
          snippet: match.snippet,
          query: messageSearch.query,
        },
        // Opens the thread with find on the word at the matched message, so it is in view.
        run: async () => {
          await item.run();
          openThreadFindOnQuery(
            scopedThreadKey(scopeThreadRef(match.environmentId, match.threadId)),
            findForMessageMatch(match, messageSearch.query),
          );
        },
      },
    ];
  });

  // Rows already shown keep their places when a slower environment answers.
  const [shownOrder, setShownOrder] = useState<ShownOrder | null>(null);
  const order = nextShownOrder(
    shownOrder,
    messageSearch.query,
    rankedMessageItems.map((item) => item.value),
    PALETTE_MESSAGE_LIMIT,
  );
  if (order !== shownOrder) setShownOrder(order);
  const messageItemByValue = new Map(rankedMessageItems.map((item) => [item.value, item]));
  const threadMessageItems = order.keys
    .slice(0, order.shown)
    .flatMap((value) => messageItemByValue.get(value) ?? []);

  const connectedEnvironmentIds = new Set(
    environments
      .filter((environment) => environment.connection.phase === "connected")
      .map((environment) => environment.environmentId),
  );
  const openThread = async (environmentId: EnvironmentId, threadId: ThreadId) => {
    await openThreadInLayout(
      {
        navigate: (options) => navigate(options),
        pathname: () => router.state.location.pathname,
      },
      scopeThreadRef(environmentId, threadId),
    );
    dispatchCommandPalette({ _tag: "SetOpen", open: false });
  };
  const openLinkedMachinesSettings = async () => {
    dispatchCommandPalette({ _tag: "SetOpen", open: false });
    await navigate({ to: "/settings/connections", hash: "linked-environments" });
  };
  const failureMessage = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
    const error = squashAtomCommandFailure(result);
    return error instanceof Error ? error.message : "The machine could not be reached.";
  };
  const linkedMachineItems = buildLinkedMachineActionItems({
    query: threadSearchQuery,
    machines: linkedSearch.machines
      .filter((machine) => machine.status === "ok" && machine.matches.length > 0)
      .map((machine) => ({
        environmentId: machine.environmentId,
        label: machine.label,
        access: machine.access,
        host: machine.host,
        matches: machine.matches,
      })),
    icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
    runMatch: async (machine, match) => {
      const value = `linked:${machine.environmentId}:${match.threadId}`;
      // A narrower link cannot pair a client; its row offers the add-environment dialog instead.
      if (machine.access !== "full-access") {
        input.onRequestAddEnvironment?.(machine.host);
        return;
      }
      // A machine already connected here opens its thread like a local row.
      if (connectedEnvironmentIds.has(machine.environmentId)) {
        await openThread(machine.environmentId, match.threadId);
        return;
      }
      if (primaryEnvironmentId === null) return;
      setLinkedRow({ kind: "connecting", value });
      const paired = await pairClient({
        environmentId: primaryEnvironmentId,
        input: { environmentId: machine.environmentId },
      });
      if (paired._tag === "Failure") {
        const message = failureMessage(paired);
        setLinkedRow({ kind: "failed", value, message });
        return;
      }
      const connected = await connectPairing({
        host: paired.value.host,
        pairingCode: paired.value.credential,
        expectedEnvironmentId: machine.environmentId,
      });
      if (connected._tag === "Failure") {
        setLinkedRow({ kind: "failed", value, message: failureMessage(connected) });
        return;
      }
      setLinkedRow({ kind: "connected", value });
      await openThread(machine.environmentId, match.threadId);
    },
  }).map((item) => {
    if (linkedRow === null || linkedRow.value !== item.value) return item;
    if (linkedRow.kind === "connecting") {
      return {
        ...item,
        titleTrailingContent: <CommandResultConnecting />,
      };
    }
    if (linkedRow.kind === "connected") {
      return {
        ...item,
        titleTrailingContent: <CommandResultConnected />,
      };
    }
    const { threadContentMatch: _match, ...rest } = item;
    return {
      ...rest,
      description: linkedRow.message,
      ...(linkedRow.message.toLowerCase().includes("expired")
        ? { linkedActionLabel: "Open linked machines", run: openLinkedMachinesSettings }
        : {}),
    };
  });

  return {
    threadItems,
    threadMessageItems,
    linkedMachineItems,
    linkedSearch,
    now,
    isSearchPending: messageSearch.isPending,
  };
}
