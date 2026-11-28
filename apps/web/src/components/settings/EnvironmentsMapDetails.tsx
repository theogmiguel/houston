import { useAtomValue } from "@effect/atom-react";
import { connectionStatusTitle } from "@houston-app/client-runtime/connection";
import type { PeerLinkHealth } from "@houston-app/client-runtime/state/peerLinks";
import { AuthMcpClientAccess, resolveEnvironmentMachineKind } from "@houston-app/contracts";
import * as DateTime from "effect/DateTime";
import { ArrowRightIcon, ClockAlertIcon, PlusIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { LegendList } from "@legendapp/list/react";
import { type ReactNode, useRef, useState } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { type Translate, useLocale, useT } from "~/i18n/useT";
import { cn } from "~/lib/utils";
import type { EnvironmentPresentation } from "~/state/environments";
import { peerLinkEnvironment } from "~/state/peerLinks";
import { useAtomCommand } from "~/state/use-atom-command";
import { accessConfig } from "../auth/ConnectAgentSurface";
import {
  DETAILS_ADDRESS_CLS,
  DETAILS_BLEED_CLS,
  DETAILS_DIVIDED_SECTION_CLS,
  DETAILS_ENDPOINT_CLS,
  DETAILS_FIELDS_CLS,
  DETAILS_FIELD_VALUE_CLS,
  DETAILS_HEADING_CLS,
  DETAILS_LINK_ROW_CLS,
  DETAILS_LINK_TITLE_CLS,
  DETAILS_MEMBER_LIST_CLS,
  DETAILS_MEMBER_ROW_CLS,
  DETAILS_PANEL_CLS,
  DETAILS_REACHABLE_GLYPH_CLS,
  DETAILS_SECONDARY_CLS,
  DETAILS_UNREACHABLE_GLYPH_CLS,
  MAP_FOREGROUND_CLS,
  MAP_MUTED_CLS,
  STRONG_LABEL_CLS,
} from "../ui/environments-map-recipes";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { formatAccessTimestamp } from "./ConnectionsSettings.logic";
import { EnvironmentRow, EnvironmentTransportLabel } from "./EnvironmentRow";
import {
  type FleetEnvironmentNode,
  type FleetFocus,
  type FleetGraph,
  type FleetLinkEdge,
  type FleetNode,
  type FleetStack,
  fleetLinkBackOffered,
  fleetSummary,
  fleetTwoWayLinks,
  isLinkEdge,
  linkNeedsAttention,
  linkTroubleRank,
} from "./environmentsMap.logic";
import { peerLinkStatusText, useForgetPeerLink } from "./LinkedEnvironmentsSettings";
import { savedBackendStatus } from "./SavedEnvironmentRows";

const plural = (count: number, one: string, other: string, t: Translate) =>
  count === 1 ? t(one) : t(other, { count });

export const matchCountText = (count: number, t: Translate) =>
  plural(count, "1 match", "{count} matches", t);
export const machineCountText = (count: number, t: Translate) =>
  plural(count, "1 machine", "{count} machines", t);
export const environmentCountText = (count: number, t: Translate) =>
  plural(count, "1 environment", "{count} environments", t);
export const linkInCount = (count: number, t: Translate) =>
  plural(count, "1 link in", "{count} links in", t);
export const linkOutCount = (count: number, t: Translate) =>
  count === 0 ? t("No links out") : plural(count, "1 link out", "{count} links out", t);
export const reachableText = (count: number, t: Translate) =>
  count === 0 ? t("None reachable") : t("{count} reachable", { count });
export const needsCodeText = (count: number, t: Translate) =>
  plural(count, "1 machine needs a pairing code", "{count} machines each need a pairing code", t);
export const linkToMachinesText = (count: number, t: Translate) =>
  plural(count, "Link to 1 machine", "Link to {count} machines", t);
const needAttentionText = (count: number, t: Translate) =>
  plural(count, "1 needs attention", "{count} need attention", t);
const linksSummaryText = (count: number, t: Translate) =>
  count === 0 ? t("no links") : plural(count, "1 link", "{count} links", t);
const linkedFromText = (count: number, t: Translate) =>
  count === 0
    ? t("No known machine links here")
    : plural(count, "Linked from 1 machine", "Linked from {count} machines", t);
const linksToText = (count: number, t: Translate) =>
  count === 0
    ? t("Links to no one")
    : plural(count, "Links to 1 machine", "Links to {count} machines", t);

const ACCESS_LEVELS = AuthMcpClientAccess.literals;
export const accessLevel = (access: AuthMcpClientAccess) => ACCESS_LEVELS.indexOf(access);

/** Colour says how a link is doing; a healthy one stays neutral so trouble stands out. */
export function healthTone(health: PeerLinkHealth): string {
  if (health.kind === "expired" || health.kind === "failing") return "text-destructive";
  if (health.kind === "unreachable") return "text-muted-foreground";
  return health.expiresInDays === null ? "text-foreground/70" : "text-warning";
}

export function healthLabel(health: PeerLinkHealth, t: Translate): string {
  switch (health.kind) {
    case "expired":
      return t("Expired");
    case "unreachable":
      return t("Not answering");
    case "failing":
      return t("Failing");
    case "reachable":
      return health.expiresInDays === null
        ? t("Reachable")
        : health.expiresInDays === 1
          ? t("Expires in 1 day")
          : t("Expires in {days} days", { days: health.expiresInDays });
  }
}

/** Five rising bars, filled up to the access a link grants: read only is one, full access five. */
export function AccessMeter({
  access,
  className,
}: {
  access: AuthMcpClientAccess;
  className?: string;
}) {
  const level = accessLevel(access);
  return (
    <svg aria-hidden viewBox="0 0 19 12" className={cn("h-3 w-[19px] shrink-0", className)}>
      {ACCESS_LEVELS.map((step, index) => (
        <rect
          key={step}
          x={index * 4}
          y={8 - index * 2}
          width="3"
          height={4 + index * 2}
          rx="0.75"
          fill="currentColor"
          opacity={index <= level ? 1 : 0.22}
        />
      ))}
    </svg>
  );
}

export function HealthGlyph({ health }: { health: PeerLinkHealth }) {
  const tone = healthTone(health);
  if (health.kind === "expired") return <XIcon aria-hidden className={cn("size-3", tone)} />;
  if (health.kind === "failing") {
    return <TriangleAlertIcon aria-hidden className={cn("size-3", tone)} />;
  }
  if (health.kind === "unreachable") {
    return <span aria-hidden className={cn("size-2", DETAILS_UNREACHABLE_GLYPH_CLS)} />;
  }
  return health.expiresInDays === null ? (
    <span aria-hidden className={cn("size-2", DETAILS_REACHABLE_GLYPH_CLS)} />
  ) : (
    <ClockAlertIcon aria-hidden className={cn("size-3", tone)} />
  );
}

export interface FleetDetailsProps {
  readonly graph: FleetGraph;
  readonly stacks: ReadonlyArray<FleetStack>;
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
  readonly selection: FleetFocus | null;
  /** The machine a map search landed on inside the selected stack. */
  readonly found: string | null;
  readonly onSelect: (focus: FleetFocus | null) => void;
  /** Opens the link flow from an environment, with no target picked yet. */
  readonly onLinkFrom: (sourceId: string) => void;
  /** Opens the link flow from a one-way link's target back to its source. */
  readonly onLinkBack: (edge: FleetLinkEdge) => void;
  readonly onToggleStack: (stackId: string) => void;
  /** The list's own row for a saved environment, or null where the list has none. */
  readonly renderSavedEnvironment: (environment: EnvironmentPresentation) => ReactNode;
  readonly onAddEnvironment: (host?: string) => void;
}

const SECTION = "px-3 py-3 sm:px-4";

/** What is selected on the map, with the controls the list keeps on each row. */
export function FleetDetails(props: FleetDetailsProps) {
  const { graph, stacks, selection, onSelect } = props;
  const t = useT();
  const panel = useRef<HTMLDivElement>(null);
  const links = graph.edges.filter(isLinkEdge);
  const node =
    selection?.kind === "node" ? graph.nodes.find((entry) => entry.id === selection.id) : undefined;
  const edge =
    selection?.kind === "edge" ? links.find((entry) => entry.id === selection.id) : undefined;
  const stack =
    selection?.kind === "stack" ? stacks.find((entry) => entry.id === selection.id) : undefined;
  const labelOf = (id: string) => graph.nodes.find((entry) => entry.id === id)?.label ?? "";
  const pair = edge === undefined ? undefined : fleetTwoWayLinks(graph).get(edge.id);
  // Choosing inside the panel replaces the control that was pressed, so focus stays on the panel.
  const selectWithin = (focus: FleetFocus) => {
    onSelect(focus);
    panel.current?.focus();
  };
  return (
    <div
      ref={panel}
      tabIndex={-1}
      role="group"
      aria-label={t("Details")}
      className={cn("min-h-20", DETAILS_PANEL_CLS)}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || selection === null || event.target !== panel.current) return;
        // The dialog closes on a document Escape listener, so the panel keeps this one.
        event.stopPropagation();
        event.preventDefault();
        onSelect(null);
      }}
    >
      {pair ? (
        <div className={SECTION}>
          <div className="space-y-4">
            {[pair.forward, pair.back].map((link) => (
              <LinkDetails
                key={link.id}
                edge={link}
                sourceLabel={labelOf(link.from)}
                targetLabel={labelOf(link.to)}
                onSelect={selectWithin}
                {...(fleetLinkBackOffered(graph, link)
                  ? { onLinkBack: () => props.onLinkBack(link) }
                  : {})}
              />
            ))}
          </div>
        </div>
      ) : edge ? (
        <div className={SECTION}>
          <LinkDetails
            key={edge.id}
            edge={edge}
            sourceLabel={labelOf(edge.from)}
            targetLabel={labelOf(edge.to)}
            onSelect={selectWithin}
            {...(fleetLinkBackOffered(graph, edge)
              ? { onLinkBack: () => props.onLinkBack(edge) }
              : {})}
          />
        </div>
      ) : stack ? (
        <StackDetails
          key={`${stack.id}:${props.found ?? ""}`}
          stack={stack}
          graph={graph}
          links={links}
          environments={props.environments}
          found={props.found}
          onSelect={selectWithin}
          onToggle={() => props.onToggleStack(stack.id)}
        />
      ) : node ? (
        <NodeDetails {...props} key={node.id} node={node} links={links} onSelect={selectWithin} />
      ) : (
        <FleetSummary graph={graph} links={links} />
      )}
    </div>
  );
}

function Heading({ children, detail }: { children: ReactNode; detail?: ReactNode }) {
  return (
    <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <h3 className={DETAILS_HEADING_CLS}>{children}</h3>
      {detail ? <span className={MAP_MUTED_CLS}>{detail}</span> : null}
    </div>
  );
}

function FleetSummary({
  graph,
  links,
}: {
  readonly graph: FleetGraph;
  readonly links: ReadonlyArray<FleetLinkEdge>;
}) {
  const t = useT();
  const summary = fleetSummary(graph);
  const attention = links.filter((edge) => linkNeedsAttention(edge.health)).length;
  const { machines } = summary;
  return (
    <div className={SECTION}>
      <Heading
        detail={
          summary.loading
            ? t("Loading links…")
            : attention > 0
              ? needAttentionText(attention, t)
              : null
        }
      >
        {machines === 0
          ? t("No other machines")
          : summary.links !== null
            ? `${machineCountText(machines, t)}, ${linksSummaryText(summary.links, t)}`
            : machineCountText(machines, t)}
      </Heading>
    </div>
  );
}

/** One link as a row: what it reaches, the access in words, where, and how it is doing. */
function LinkButton({
  edge,
  label,
  onSelect,
}: {
  readonly edge: FleetLinkEdge;
  readonly label: string;
  readonly onSelect: (focus: FleetFocus) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const attention = linkNeedsAttention(edge.health);
  return (
    <li>
      <button
        type="button"
        className={cn("grid w-full items-center gap-x-3 px-1.5 py-1", DETAILS_LINK_ROW_CLS)}
        onClick={() => onSelect({ kind: "edge", id: edge.id })}
      >
        <AccessMeter access={edge.link.access} className={DETAILS_SECONDARY_CLS} />
        <span className={cn("truncate", STRONG_LABEL_CLS)}>{label}</span>
        <span className={cn("truncate", DETAILS_SECONDARY_CLS)}>
          {t(accessConfig[edge.link.access].label)}
        </span>
        <span className={cn("hidden truncate lg:block", DETAILS_ADDRESS_CLS)}>
          {edge.link.urls[0]}
        </span>
        <span
          className={cn(
            "flex shrink-0 items-center gap-1.5",
            attention ? healthTone(edge.health) : MAP_MUTED_CLS,
          )}
        >
          <HealthGlyph health={edge.health} />
          {attention
            ? healthLabel(edge.health, t)
            : t("Expires {date}", {
                date: formatAccessTimestamp(DateTime.formatIso(edge.link.expiresAt), locale),
              })}
        </span>
      </button>
    </li>
  );
}

const MEMBER_ROW_HEIGHT = 28;
const MEMBER_LIST_ROWS = 9;

interface StackMember {
  readonly id: string;
  readonly label: string;
  /** What the row says about the machine: its link's access, or why it is not connected. */
  readonly detail: string;
  readonly address: string | null;
  /** The link that most wants attention, for a machine known through links. */
  readonly worst: FleetLinkEdge | null;
}

/**
 * Every machine a stack stands for, however many: the list mounts only the rows in view, and
 * a machine's own details, with its actions, are one click away.
 */
function StackDetails({
  stack,
  graph,
  links,
  environments,
  found,
  onSelect,
  onToggle,
}: {
  readonly stack: FleetStack;
  readonly graph: FleetGraph;
  readonly links: ReadonlyArray<FleetLinkEdge>;
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
  /** The machine a map search landed on: the list opens narrowed to it. */
  readonly found: string | null;
  readonly onSelect: (focus: FleetFocus) => void;
  readonly onToggle: () => void;
}) {
  const t = useT();
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const [query, setQuery] = useState(found === null ? "" : (nodeById.get(found)?.label ?? ""));
  const memberIds = new Set(stack.memberIds);
  const incoming = new Map<string, FleetLinkEdge[]>();
  for (const edge of links) {
    if (!memberIds.has(edge.to)) continue;
    const into = incoming.get(edge.to);
    if (into === undefined) incoming.set(edge.to, [edge]);
    else into.push(edge);
  }
  const environmentById = new Map(
    environments.map((environment) => [environment.environmentId, environment]),
  );
  const members = stack.memberIds.flatMap((id): StackMember[] => {
    const node = nodeById.get(id);
    if (node === undefined || node.kind === "client") return [];
    if (node.kind === "target") {
      const into = incoming.get(id) ?? [];
      const worst = into.toSorted(
        (left, right) => linkTroubleRank(left.health) - linkTroubleRank(right.health),
      )[0];
      return [
        {
          id,
          label: node.label,
          detail:
            into.length === 1 && worst !== undefined
              ? t(accessConfig[worst.link.access].label)
              : linkInCount(into.length, t),
          address: node.address,
          worst: worst ?? null,
        },
      ];
    }
    const environment = environmentById.get(node.environmentId);
    return [
      {
        id,
        label: node.label,
        detail: environment === undefined ? t("Not added") : savedBackendStatus(environment).text,
        address: null,
        worst: null,
      },
    ];
  });
  const needle = query.trim().toLocaleLowerCase();
  const shown =
    needle === ""
      ? members
      : members.filter((member) => member.label.toLocaleLowerCase().includes(needle));
  const range =
    stack.firstLabel === stack.lastLabel
      ? stack.firstLabel
      : `${stack.firstLabel} … ${stack.lastLabel}`;
  const sources = stack.sources.map((source) => nodeById.get(source.sourceId)?.label ?? "");
  const [only] = stack.sources;
  return (
    <div className={SECTION}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <Heading
          detail={(stack.kind === "environments"
            ? [environmentCountText(members.length, t), t("No links")]
            : [
                machineCountText(members.length, t),
                sources.join(", "),
                ...(stack.sources.length === 1 && only !== undefined
                  ? [t(accessConfig[only.access].label)]
                  : []),
                reachableText(stack.reachable, t),
              ]
          ).join(" · ")}
        >
          {range}
        </Heading>
        <Button size="xs" variant="outline" onClick={onToggle}>
          {stack.expanded ? t("Collapse") : t("Show on map")}
        </Button>
      </div>
      {members.length > MEMBER_LIST_ROWS ? (
        <div className="mb-1.5 flex items-center gap-3">
          <div className="w-56">
            <Input
              size="compact"
              type="text"
              role="searchbox"
              value={query}
              aria-label={t("Filter these machines by name")}
              placeholder={t("Filter by name")}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape" || event.defaultPrevented) return;
                if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
                // An Escape that cancels an IME composition belongs to the IME.
                const composing = event.nativeEvent.isComposing || event.keyCode === 229;
                if (!composing && !query && !event.repeat) return;
                event.stopPropagation();
                if (composing) return;
                event.preventDefault();
                setQuery("");
              }}
            />
          </div>
          {needle === "" ? null : (
            <span role="status" className={MAP_MUTED_CLS}>
              {t("{shown} of {count}", { shown: shown.length, count: members.length })}
            </span>
          )}
        </div>
      ) : null}
      <div
        className={DETAILS_BLEED_CLS}
        style={{ height: Math.min(shown.length, MEMBER_LIST_ROWS) * MEMBER_ROW_HEIGHT }}
      >
        <LegendList<StackMember>
          data={shown}
          keyExtractor={(member) => member.id}
          estimatedItemSize={MEMBER_ROW_HEIGHT}
          drawDistance={MEMBER_ROW_HEIGHT * MEMBER_LIST_ROWS}
          recycleItems
          className={cn("h-full", DETAILS_MEMBER_LIST_CLS)}
          renderItem={({ item }) => <MemberButton member={item} onSelect={onSelect} />}
        />
      </div>
    </div>
  );
}

function MemberButton({
  member,
  onSelect,
}: {
  readonly member: StackMember;
  readonly onSelect: (focus: FleetFocus) => void;
}) {
  const t = useT();
  const { worst } = member;
  const attention = worst !== null && linkNeedsAttention(worst.health);
  return (
    <button
      type="button"
      style={{ height: MEMBER_ROW_HEIGHT }}
      className={cn("grid w-full items-center gap-x-3 px-1.5", DETAILS_MEMBER_ROW_CLS)}
      onClick={() => onSelect({ kind: "node", id: member.id })}
    >
      <span className={cn("truncate", STRONG_LABEL_CLS)}>{member.label}</span>
      <span className={cn("truncate", DETAILS_SECONDARY_CLS)}>{member.detail}</span>
      <span className={cn("hidden truncate lg:block", DETAILS_ADDRESS_CLS)}>{member.address}</span>
      {worst === null ? (
        <span />
      ) : (
        <span
          className={cn(
            "flex shrink-0 items-center gap-1.5",
            attention ? healthTone(worst.health) : MAP_MUTED_CLS,
          )}
        >
          <HealthGlyph health={worst.health} />
          {healthLabel(worst.health, t)}
        </span>
      )}
    </button>
  );
}

function LinkAnother({
  node,
  onLinkFrom,
}: {
  readonly node: FleetEnvironmentNode;
  readonly onLinkFrom: (sourceId: string) => void;
}) {
  const t = useT();
  // The command's own permission, which follows the session as the node's snapshot cannot.
  const canLink = useAtomValue(peerLinkEnvironment.link.permissionAtom(node.environmentId));
  if (!canLink || node.linking !== "ready") return null;
  return (
    <Button size="xs" onClick={() => onLinkFrom(node.id)}>
      <PlusIcon className="size-3" />
      {t("Link")}
    </Button>
  );
}

function Reconnect({ environment }: { readonly environment: EnvironmentPresentation }) {
  const t = useT();
  const retryNow = useAtomCommand(environmentCatalog.retryNow);
  const { phase } = environment.connection;
  if (!environment.entry.enabled || phase === "connected" || phase === "unsupported") return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className={MAP_MUTED_CLS}>{savedBackendStatus(environment).text}</span>
      <Button
        size="xs"
        variant="outline"
        disabled={phase === "connecting"}
        onClick={() => void retryNow(environment.environmentId)}
      >
        {t("Reconnect")}
      </Button>
    </div>
  );
}

function linksNote(node: FleetEnvironmentNode, t: Translate): string | null {
  if (node.phase !== "connected") {
    return t("Not connected, so its links are not shown.");
  }
  switch (node.outgoing) {
    case "off":
      return t("To link from {label}, turn on Linked environments in its Labs settings.", {
        label: node.label,
      });
    case "unknown":
      return t("This app may not read the links {label} holds.", { label: node.label });
    case "error":
      return t("Could not load the links {label} holds: {error}", {
        label: node.label,
        error: node.outgoingError ?? "",
      });
    case "loading":
      return t("Loading linked environments…");
    case "loaded":
      return null;
  }
}

function LinkList({
  title,
  action,
  edges,
  labelOf,
  onSelect,
}: {
  readonly title: string | null;
  readonly action?: ReactNode;
  readonly edges: ReadonlyArray<FleetLinkEdge>;
  readonly labelOf: (edge: FleetLinkEdge) => string;
  readonly onSelect: (focus: FleetFocus) => void;
}) {
  return (
    <section>
      <div className="mb-1 flex min-h-6 items-center gap-3">
        {title === null ? null : <h4 className={STRONG_LABEL_CLS}>{title}</h4>}
        {action}
      </div>
      {edges.length > 0 ? (
        <ul className={cn("max-h-48 overflow-y-auto", DETAILS_BLEED_CLS)}>
          {edges.map((edge) => (
            <LinkButton key={edge.id} edge={edge} label={labelOf(edge)} onSelect={onSelect} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function NodeDetails({
  node,
  graph,
  links,
  environments,
  onSelect,
  onLinkFrom,
  renderSavedEnvironment,
  onAddEnvironment,
}: Omit<FleetDetailsProps, "selection" | "found" | "stacks" | "onToggleStack" | "onSelect"> & {
  readonly node: FleetNode;
  readonly links: ReadonlyArray<FleetLinkEdge>;
  readonly onSelect: (focus: FleetFocus) => void;
}) {
  const t = useT();
  const labelOf = (id: string) => graph.nodes.find((entry) => entry.id === id)?.label ?? "";
  if (node.kind === "client") {
    const hosts = graph.nodes.filter((entry) => entry.kind === "environment");
    return (
      <div className={SECTION}>
        <Heading
          detail={t("{connected} of {total} connected", {
            connected: hosts.filter((entry) => entry.phase === "connected").length,
            total: hosts.length,
          })}
        >
          {node.label}
        </Heading>
        <p className={MAP_MUTED_CLS}>
          {t("Each line from here is a saved route to an environment.")}
        </p>
      </div>
    );
  }
  const out = links.filter((edge) => edge.from === node.id);
  const incoming = links.filter((edge) => edge.to === node.id);
  const linkedFrom = (
    <LinkList
      title={linkedFromText(incoming.length, t)}
      edges={incoming}
      labelOf={(edge) => labelOf(edge.from)}
      onSelect={onSelect}
    />
  );
  if (node.kind === "target") {
    return (
      <div className={SECTION}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <Heading detail={t("Known only through a link")}>{node.label}</Heading>
          <Button
            size="xs"
            variant="outline"
            onClick={() => onAddEnvironment(node.address ?? undefined)}
          >
            <PlusIcon className="size-3" />
            {t("Add environment")}
          </Button>
        </div>
        {/* A machine known only through its links is its links, so each one is shown in full. */}
        <div className="space-y-4">
          {incoming.map((edge) => (
            <LinkDetails
              key={edge.id}
              edge={edge}
              sourceLabel={labelOf(edge.from)}
              targetLabel={node.label}
              onSelect={onSelect}
            />
          ))}
        </div>
        <p className={cn("mt-3 max-w-2xl", MAP_MUTED_CLS)}>
          {t("Not connected, so its links are not shown.")}
        </p>
      </div>
    );
  }
  const environment = environments.find((entry) => entry.environmentId === node.environmentId);
  const saved = environment ? renderSavedEnvironment(environment) : null;
  const note = linksNote(node, t);
  const loaded = node.outgoing === "loaded";
  return (
    <>
      {saved ??
        (environment ? (
          <EnvironmentRow
            kind={resolveEnvironmentMachineKind(environment.serverConfig)}
            label={environment.label}
            subtitle={
              <>
                <EnvironmentTransportLabel environment={environment} />
                {" · "}
                {connectionStatusTitle(environment.connection)}
                {environment.serverConfig
                  ? ` · ${environment.serverConfig.environment.serverVersion}`
                  : ""}
              </>
            }
          />
        ) : null)}
      <div className={cn(SECTION, "space-y-3", DETAILS_DIVIDED_SECTION_CLS)}>
        {environment && saved !== null ? <Reconnect environment={environment} /> : null}
        {note ? <p className={cn("max-w-2xl", MAP_MUTED_CLS)}>{note}</p> : null}
        <LinkList
          title={loaded ? linksToText(out.length, t) : null}
          action={<LinkAnother node={node} onLinkFrom={onLinkFrom} />}
          edges={out}
          labelOf={(edge) => labelOf(edge.to)}
          onSelect={onSelect}
        />
        {linkedFrom}
      </div>
    </>
  );
}

function LinkDetails({
  edge,
  sourceLabel,
  targetLabel,
  onSelect,
  onLinkBack,
}: {
  readonly edge: FleetLinkEdge;
  readonly sourceLabel: string;
  readonly targetLabel: string;
  readonly onSelect: (focus: FleetFocus) => void;
  /** Set where this app can link the target back to the source with no pasted code. */
  readonly onLinkBack?: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const { link, health } = edge;
  const canUnlink = useAtomValue(
    peerLinkEnvironment.unlink.permissionAtom(edge.sourceEnvironmentId),
  );
  const { busy, forget } = useForgetPeerLink(edge.sourceEnvironmentId, link);
  const access = accessConfig[link.access];
  const when = (value: DateTime.Utc) => formatAccessTimestamp(DateTime.formatIso(value), locale);
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className={cn("flex min-w-0 flex-wrap items-center gap-1.5", DETAILS_LINK_TITLE_CLS)}>
          <button
            type="button"
            className={DETAILS_ENDPOINT_CLS}
            onClick={() => onSelect({ kind: "node", id: edge.from })}
          >
            {sourceLabel}
          </button>
          <ArrowRightIcon
            role="img"
            aria-label={t("links to")}
            className={cn("size-3.5", MAP_MUTED_CLS)}
          />
          <button
            type="button"
            className={DETAILS_ENDPOINT_CLS}
            onClick={() => onSelect({ kind: "node", id: edge.to })}
          >
            {targetLabel}
          </button>
        </h3>
        <div className="flex items-center gap-2">
          {onLinkBack ? (
            <Button size="xs" variant="outline" onClick={onLinkBack}>
              {t("Link back…", {})}
            </Button>
          ) : null}
          {canUnlink ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={busy}
              onClick={() => void forget()}
            >
              {busy ? t("Forgetting…") : t("Forget")}
            </Button>
          ) : null}
        </div>
      </div>
      <dl className={cn("grid max-w-2xl gap-x-4 gap-y-1.5", DETAILS_FIELDS_CLS)}>
        <dt className={MAP_MUTED_CLS}>{t("Access")}</dt>
        <dd>
          <span className={cn("flex items-center gap-2", STRONG_LABEL_CLS)}>
            <AccessMeter access={link.access} className={DETAILS_SECONDARY_CLS} />
            {t(access.label)}
          </span>
          <span className={MAP_MUTED_CLS}>{t(access.description)}</span>
        </dd>
        <dt className={MAP_MUTED_CLS}>{t("Status")}</dt>
        <dd
          className={cn(
            "flex items-center gap-1.5",
            linkNeedsAttention(health) ? healthTone(health) : MAP_FOREGROUND_CLS,
          )}
        >
          <HealthGlyph health={health} />
          {peerLinkStatusText(health)}
        </dd>
        <dt className={MAP_MUTED_CLS}>{t("Expires")}</dt>
        <dd className={MAP_FOREGROUND_CLS}>{when(link.expiresAt)}</dd>
        <dt className={MAP_MUTED_CLS}>{t("Addresses")}</dt>
        <dd className={cn("min-w-0", DETAILS_FIELD_VALUE_CLS)}>
          {link.urls.map((url) => (
            <span key={url} className="block">
              {url}
            </span>
          ))}
        </dd>
        <dt className={MAP_MUTED_CLS}>{t("Linked")}</dt>
        <dd className={MAP_FOREGROUND_CLS}>{when(link.linkedAt)}</dd>
        {link.lastReachedAt ? (
          <>
            <dt className={MAP_MUTED_CLS}>{t("Last reached")}</dt>
            <dd className={MAP_FOREGROUND_CLS}>{when(link.lastReachedAt)}</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}
