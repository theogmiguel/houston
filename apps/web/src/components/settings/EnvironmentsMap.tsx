import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  type ConnectionRouteKind,
  connectionRouteId,
  connectionRouteKind,
  connectionRouteLabel,
  connectionRoutes,
  routeHttpBaseUrl,
} from "@houston-app/client-runtime/connection";
import {
  linkableMachines,
  offersLinkedEnvironments,
} from "@houston-app/client-runtime/link-request";
import type { PeerLinkHealth } from "@houston-app/client-runtime/state/peerLinks";
import { AuthAccessWriteScope, type EnvironmentId } from "@houston-app/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import {
  AppWindowIcon,
  ArrowUpDownIcon,
  CheckIcon,
  CircleHelpIcon,
  FoldVerticalIcon,
  GlobeIcon,
  MaximizeIcon,
  MinusIcon,
  PlusIcon,
  SearchIcon,
  TriangleAlertIcon,
  UnfoldVerticalIcon,
  XIcon,
} from "lucide-react";
import {
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useContext,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";

import { isDesktopHost } from "~/env";
import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useStableCallback } from "~/hooks/useStableCallback";
import { type Translate, useT } from "~/i18n/useT";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { type EnvironmentPresentation, useEnvironments } from "~/state/environments";
import { environmentIdsKey } from "~/state/environmentAtomList";
import { peerLinkEnvironment, peerLinkListsAtom, usePeerLinkHosts } from "~/state/peerLinks";
import { formatEnvironmentQueryError } from "~/state/query";
import { preparedConnectionsAtom, useEnvironmentsWithScope } from "~/state/session";
import { accessConfig } from "../auth/ConnectAgentSurface";
import { connectionPhaseDotClassName } from "../ConnectionStatusDot";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import {
  MAP_ACCENT_INK_CLS,
  MAP_CANVAS_CLS,
  MAP_CAPTION_CLS,
  MAP_CLICKABLE_CLS,
  MAP_CLIENT_LABEL_CLS,
  MAP_CLIENT_NODE_CLS,
  MAP_COLUMN_TITLE_CLS,
  MAP_CONTROLS_BAR_CLS,
  MAP_DASHED_CLS,
  MAP_DIMMED_METER_CLS,
  MAP_DIMMED_TEXT_CLS,
  MAP_DIMMED_TILE_CLS,
  MAP_DOT_CLS,
  MAP_DOT_OFF_CLS,
  MAP_DRAG_HINT_CLS,
  MAP_DROP_TARGET_BORDER_CLS,
  MAP_ENVIRONMENT_BORDER_CLS,
  MAP_ENVIRONMENT_DIMMED_BORDER_CLS,
  MAP_ENVIRONMENT_LABEL_CLS,
  MAP_ENVIRONMENT_NODE_CLS,
  MAP_ERROR_CLS,
  MAP_FOLDED_NODE_CLS,
  MAP_FOREGROUND_CLS,
  MAP_HANDLE_PLUS_CLS,
  MAP_HELP_LIST_CLS,
  MAP_HIDDEN_CLS,
  MAP_LINK_HANDLE_CLS,
  MAP_LINK_NAME_CLS,
  MAP_MACHINE_TILE_CLS,
  MAP_MARQUEE_CLS,
  MAP_METER_INK_CLS,
  MAP_MORE_CHIP_CLS,
  MAP_MUTED_CLS,
  MAP_NODE_CAPTION_CLS,
  MAP_NOTICE_BAR_CLS,
  MAP_PASSIVE_CLS,
  MAP_RAISED_CLS,
  MAP_REACH_FILL_CLS,
  MAP_REACH_TRACK_CLS,
  MAP_ROUTE_PILL_CLS,
  MAP_SCENE_LAYER_CLS,
  MAP_DRAG_LINE_CLS,
  MAP_SELECTED_RING_CLS,
  MAP_SELECTION_COUNT_CLS,
  MAP_STACK_BORDER_CLS,
  MAP_STACK_CAPTION_CLS,
  MAP_STACK_CARD_CLS,
  MAP_STACK_COUNT_BADGE_CLS,
  MAP_STACK_COUNT_CLS,
  MAP_STACK_FACE_CLS,
  MAP_STACK_PARTIAL_BAND_CLS,
  MAP_STACK_PARTIAL_BORDER_CLS,
  MAP_STACK_TITLE_CLS,
  MAP_STACK_TOGGLE_CLS,
  MAP_STACK_TRAY_CLS,
  MAP_STATUS_DOT_CLS,
  MAP_TABULAR_CLS,
  MAP_TARGET_COMPACT_CLS,
  MAP_TARGET_COMPACT_LABEL_CLS,
  MAP_TARGET_FULL_CLS,
  MAP_TARGET_IDLE_BORDER_CLS,
  MAP_TARGET_LABEL_CLS,
  MAP_TARGET_NODE_CLS,
  MAP_TICKED_FRAME_CLS,
  MAP_TICK_BADGE_CLS,
  MAP_TICK_GLYPH_CLS,
  MAP_TOOLBAR_CLS,
  MAP_WARNING_CLS,
  MAP_ZOOM_GROUP_CLS,
} from "../ui/environments-map-recipes";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  buildFleetGraph,
  anchorFleetView,
  fitFleetLayout,
  fleetCanvasHeight,
  FLEET_CLIENT_NODE_ID,
  fleetDrawnLinkId,
  fleetEnvironmentNodeId,
  fleetFocusRects,
  fleetLinkAction,
  fleetLinkOffer,
  fleetMoreNodeId,
  fleetNeighborhood,
  fleetNodesInBox,
  fleetSearch,
  fleetLayoutWidth,
  fleetShapeKey,
  fleetStackPartial,
  fleetStacks,
  fleetTwoWayLinks,
  type FleetArrow,
  type FleetDirection,
  type FleetEnvironmentInput,
  type FleetEnvironmentNode,
  type FleetFocus,
  type FleetFoldGroup,
  type FleetGraph,
  type FleetHeldView,
  type FleetLayout,
  type FleetLinkAction,
  type FleetLinkEdge,
  type FleetLinkOffer,
  type FleetRect,
  type FleetRouteEdge,
  type FleetRouteState,
  type FleetStack,
  type FleetViewTransform,
  isLinkEdge,
  isRouteEdge,
  layoutFleetGraph,
  linkNeedsAttention,
  linkTroubleRank,
  worseLinkHealth,
  zoomFleetView,
  nextFleetNode,
} from "./environmentsMap.logic";
import {
  AccessMeter,
  accessLevel,
  FleetDetails,
  type FleetDetailsProps,
  HealthGlyph,
  healthLabel,
  healthTone,
  linkInCount,
  linkOutCount,
  linkToMachinesText,
  machineCountText,
  matchCountText,
  needsCodeText,
  reachableText,
} from "./EnvironmentsMapDetails";
import { LinkEnvironmentDialog, type LinkEnvironmentPrefill } from "./LinkedEnvironmentsSettings";
import { ANOTHER_ADDRESS } from "./LinkMachineSelect";
import { LinkSeveralEnvironmentsDialog } from "./LinkSeveralEnvironments";
import { savedBackendStatus } from "./SavedEnvironmentRows";
import { SettingsSearchTarget } from "./settingsLayout";

/** One ordinal scale for access, read only to full access: a link's line gets heavier and darker. */
const ACCESS_STROKE_WIDTHS = [1.25, 1.75, 2.25, 2.75, 3.5];
const ACCESS_STROKE_OPACITIES = [0.4, 0.5, 0.62, 0.76, 0.9];
/** Short maps get a short canvas; a tall one grows to this, then the fit shrinks it or it pans. */
const CANVAS_HEIGHT = { min: 180, max: 840 };
const ARROW_ROVE: Record<string, FleetDirection> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};
const NO_STACKS: ReadonlySet<string> = new Set();
const NO_SELECTION: ReadonlySet<string> = new Set();
/** Search centres a machine at a scale it can be read at, however far out the map was. */
const FOUND_MIN_SCALE = 0.85;

/** What an opened stack adds fades in over the same time the view takes to make room for it. */
const APPEAR = "transition-opacity duration-(--motion-list-in) ease-standard starting:opacity-0";

/** Dashes repeat a link's health without colour, one pattern per kind of trouble. */
function healthDash(health: PeerLinkHealth): string | undefined {
  if (health.kind === "expired") return "1 5";
  if (health.kind === "failing") return "8 3 1 3";
  return health.kind === "unreachable" ? "5 4" : undefined;
}

/** Worst first: a machine several hosts link to wears the health of its most troubled link. */
const byTrouble = (left: FleetLinkEdge, right: FleetLinkEdge) =>
  linkTroubleRank(left.health) - linkTroubleRank(right.health);

/** A machine's outline carries its link's health too. */
function healthBorder(health: PeerLinkHealth): string {
  if (health.kind === "expired") return "border-dotted border-destructive/70";
  if (health.kind === "failing") return "border-destructive/70";
  if (health.kind === "unreachable") return "border-dashed border-foreground/35";
  return health.expiresInDays === null ? "border-border" : "border-warning/70";
}

/** How each route state is drawn: the one in use stands out, the rest stay quiet. */
const ROUTE_STYLES: Record<
  FleetRouteState,
  { readonly wire: string; readonly width: number; readonly dash?: string; readonly pill: string }
> = {
  "in-use": {
    wire: "text-success",
    width: 1.75,
    pill: "border-success/70 font-medium text-foreground",
  },
  standby: { wire: "text-muted-foreground/60", width: 1, pill: "border-border" },
  trying: { wire: "text-warning", width: 1, dash: "1 4", pill: "border-warning/60" },
  down: { wire: "text-muted-foreground/60", width: 1, dash: "4 4", pill: "border-dashed" },
  idle: { wire: "text-muted-foreground/40", width: 1, dash: "4 4", pill: "border-dashed" },
};

/** Below this a route's own name no longer fits whole, so its kind stands in for it. */
const ROUTE_NAME_FULL_WIDTH = 100;
/** Below this the client's label keeps the room its icon would take. */
const CLIENT_ICON_MIN_WIDTH = 140;
/** Below this the longest card status no longer fits whole, so a shorter wording stands in. */
const STATUS_FULL_WIDTH = 160;

function routeKindLabel(kind: ConnectionRouteKind, t: Translate): string {
  switch (kind) {
    case "loopback":
      return t("This device");
    case "lan":
      return "LAN";
    case "tailnet":
      return "Tailscale";
    case "vpn":
      return "VPN";
    case "ssh":
      return "SSH";
    case "public":
      return t("Public");
  }
}

function routeStateLabel(state: FleetRouteState, t: Translate): string {
  switch (state) {
    case "in-use":
      return t("In use");
    case "standby":
      return t("Standby");
    case "trying":
      return t("Connecting");
    case "down":
      return t("Not connected");
    case "idle":
      return t("Not in use");
  }
}

function useFleetGraph() {
  const t = useT();
  const { environments } = useEnvironments();
  const hosts = usePeerLinkHosts();
  const nowMinute = useNowMinute();
  const hostsKey = environmentIdsKey(hosts.map((host) => host.environmentId));
  const lists = useAtomValue(peerLinkListsAtom(hostsKey));
  const registry = useContext(RegistryContext);
  // Links made from another client or the CLI bump nothing these lists read, so coming back to
  // the window asks again, as the list view does, and so does a change in which machines can be
  // asked. Listing probes every linked machine: too costly for a timer.
  useLiveRefresh(
    () => {
      for (const host of hosts) {
        const list = peerLinkEnvironment.list({ environmentId: host.environmentId, input: {} });
        if (!registry.get(list).waiting) registry.refresh(list);
      }
    },
    { key: `environments-map:${hostsKey}`, intervalMs: null, refreshOnShow: true },
  );
  const prepared = useAtomValue(
    preparedConnectionsAtom(
      environmentIdsKey(environments.map((environment) => environment.environmentId)),
    ),
  );
  const writable = useEnvironmentsWithScope(environments, AuthAccessWriteScope);
  const machines = linkableMachines({ environments, threadEnvironmentId: null, links: [] });
  const machineById = new Map(machines.map((machine) => [machine.environmentId, machine]));
  const listByHost = new Map(hosts.map((host, index) => [host.environmentId, lists[index]]));
  const inputs = environments.map((environment, index): FleetEnvironmentInput => {
    const list = listByHost.get(environment.environmentId);
    const connected = environment.connection.phase === "connected";
    const active = connected ? Option.getOrNull(prepared[index] ?? Option.none()) : null;
    const offersLinks = offersLinkedEnvironments(environment.serverConfig);
    return {
      environmentId: environment.environmentId,
      label: environment.label,
      machine: machineById.get(environment.environmentId)?.machine ?? null,
      phase: environment.connection.phase,
      enabled: environment.entry.enabled,
      routes: connectionRoutes(environment.entry).map((route) => ({
        id: connectionRouteId(route.target),
        kind: connectionRouteKind(route),
        ...(connectionRouteKind(route) === "tailnet" &&
        routeHttpBaseUrl(route)?.startsWith("https:") === true
          ? { label: connectionRouteLabel(route) }
          : {}),
      })),
      activeRouteId: active === null ? null : connectionRouteId(active.target),
      offersLinks,
      canWriteAccess: writable.has(environment.environmentId),
      hasLinkAddress: (machineById.get(environment.environmentId)?.urls.length ?? 0) > 0,
      outgoing:
        list === undefined
          ? { state: connected && !offersLinks ? "off" : "unknown" }
          : list._tag === "Success"
            ? { state: "loaded", links: list.value.links }
            : list._tag === "Failure"
              ? { state: "error", message: formatEnvironmentQueryError(list.cause) }
              : { state: "loading" },
    };
  });
  const graph = buildFleetGraph({
    clientLabel: isDesktopHost ? t("This device") : t("This browser"),
    environments: inputs,
    now: DateTime.makeUnsafe(nowMinute),
  });
  return { graph, environments };
}

/**
 * The layout for the graph's current shape at the canvas's width; a health or status change
 * reuses the last one.
 */
function useFleetLayout(
  graph: FleetGraph,
  stacks: ReadonlyArray<FleetStack>,
  shapeKey: string,
  canvasWidth: number | null,
) {
  const width = canvasWidth === null ? undefined : fleetLayoutWidth(canvasWidth);
  const key = `${shapeKey}\n${width}`;
  const [laid, setLaid] = useState(() => ({ key, layout: layoutFleetGraph(graph, stacks, width) }));
  if (laid.key === key) return laid;
  const next = { key, layout: layoutFleetGraph(graph, stacks, width) };
  setLaid(next);
  return next;
}

interface LinkRequest {
  readonly serial: number;
  readonly environmentId: EnvironmentId;
  readonly prefill: LinkEnvironmentPrefill;
  readonly open: boolean;
}

interface BatchRequest {
  readonly serial: number;
  readonly environmentId: EnvironmentId;
  readonly preset: ReadonlyArray<EnvironmentId>;
  /** The machines were dropped on or selected for this link, so the dialog lists only them. */
  readonly presetOnly: boolean;
  readonly open: boolean;
}

/** A drop the client cannot link in one go, explained where it happened. */
type CodeOnlyDrop = Extract<FleetLinkAction, { kind: "code-only" }>;

/**
 * Every machine this app knows about, how it reaches each one, and which of them are linked.
 * Selecting a machine shows the controls the list has for it.
 */
export function EnvironmentsMap(
  props: Pick<FleetDetailsProps, "renderSavedEnvironment" | "onAddEnvironment"> & {
    readonly footerId?: string;
  },
) {
  const { graph, environments } = useFleetGraph();
  const [expanded, setExpanded] = useState(NO_STACKS);
  const stacks = fleetStacks(graph, expanded);
  const key = fleetShapeKey(graph, stacks);
  const [picked, setPicked] = useState<FleetFocus | null>(null);
  // Machines ticked for a batch link: apart from `picked`, which is what the details show.
  const [ticked, setTicked] = useState(NO_SELECTION);
  // The machine a search landed on inside a stack, for the stack's list to scroll to.
  const [found, setFound] = useState<string | null>(null);
  const [linkRequest, setLinkRequest] = useState<LinkRequest | null>(null);
  const [batchRequest, setBatchRequest] = useState<BatchRequest | null>(null);
  const [dropped, setDropped] = useState<CodeOnlyDrop | null>(null);
  const pairs = fleetTwoWayLinks(graph);
  const present =
    picked === null
      ? null
      : (picked.kind === "stack"
            ? stacks
            : picked.kind === "node"
              ? graph.nodes
              : graph.edges
          ).some((item) => item.id === picked.id)
        ? picked
        : null;
  // Either link of a two-way link selects the one line drawn for both.
  const selection =
    present?.kind === "edge" ? { ...present, id: fleetDrawnLinkId(pairs, present.id) } : present;
  // A machine that left the map leaves the selection with it.
  const selected =
    ticked.size === 0
      ? NO_SELECTION
      : new Set(graph.nodes.filter((node) => ticked.has(node.id)).map((node) => node.id));
  const toggleStack = (stackId: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(stackId)) next.add(stackId);
      return next;
    });
  const tick = (ids: ReadonlyArray<string>, mode: "toggle" | "add") =>
    setTicked((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (mode === "toggle" && next.delete(id)) continue;
        next.add(id);
      }
      return next;
    });
  const openLinkDialog = (
    environmentId: EnvironmentId,
    offer: Extract<FleetLinkOffer, { kind: "link" }> | null,
  ) => {
    setDropped(null);
    setLinkRequest((current) => ({
      serial: (current?.serial ?? 0) + 1,
      environmentId,
      open: true,
      prefill:
        offer === null
          ? { choice: null }
          : offer.target.kind === "machine"
            ? { choice: offer.target.environmentId }
            : { choice: ANOTHER_ADDRESS, address: offer.target.address ?? "" },
    }));
  };
  /** One link from `sourceId` to `targetId`, whatever is selected. */
  const requestOneLink = (sourceId: string, targetId: string) => {
    const offer = fleetLinkOffer(graph, sourceId, targetId);
    if (offer.kind === "link") openLinkDialog(offer.sourceEnvironmentId, offer);
  };
  // One way in for every gesture: the handle, a drop, the details and the toolbar.
  const requestLink = (sourceId: string, targetId: string | null) => {
    const action = fleetLinkAction(graph, stacks, selected, sourceId, targetId);
    if (action === null) return;
    if (action.kind === "code-only") {
      setDropped(action);
      return;
    }
    if (action.kind === "batch") {
      setDropped(null);
      setBatchRequest((current) => ({
        serial: (current?.serial ?? 0) + 1,
        environmentId: action.sourceEnvironmentId,
        preset: action.environmentIds,
        presetOnly: true,
        open: true,
      }));
      return;
    }
    openLinkDialog(action.sourceEnvironmentId, action.offer);
  };
  const requestBatch = (sourceId: string) => {
    const source = graph.nodes.find((node) => node.id === sourceId);
    if (source?.kind !== "environment" || source.linking !== "ready") return;
    const action = fleetLinkAction(graph, stacks, selected, sourceId, null);
    setDropped(null);
    setBatchRequest((current) => ({
      serial: (current?.serial ?? 0) + 1,
      environmentId: source.environmentId,
      preset: action?.kind === "batch" ? action.environmentIds : [],
      presetOnly: false,
      open: true,
    }));
  };
  const select = (focus: FleetFocus | null) => {
    setPicked(focus);
    setFound(null);
  };
  return (
    <>
      <FleetCanvas
        graph={graph}
        stacks={stacks}
        shapeKey={key}
        environments={environments}
        selection={selection}
        selected={selected}
        onSelect={select}
        onTick={tick}
        onClearTicked={() => setTicked(NO_SELECTION)}
        onLink={requestLink}
        onLinkSeveral={requestBatch}
        dropped={dropped}
        onLinkOne={requestOneLink}
        onDismissDropped={() => setDropped(null)}
        onToggleStack={toggleStack}
        onFind={(stackId, memberId) => {
          setPicked({ kind: "stack", id: stackId });
          setFound(memberId);
        }}
      />
      <SettingsSearchTarget id={props.footerId}>
        <FleetDetails
          {...props}
          graph={graph}
          stacks={stacks}
          environments={environments}
          selection={selection}
          found={found}
          onSelect={select}
          onLinkFrom={(sourceId) => requestLink(sourceId, null)}
          onLinkBack={(edge) => requestOneLink(edge.to, edge.from)}
          onToggleStack={toggleStack}
        />
      </SettingsSearchTarget>
      {linkRequest ? (
        <LinkEnvironmentDialog
          key={linkRequest.serial}
          environmentId={linkRequest.environmentId}
          open={linkRequest.open}
          prefill={linkRequest.prefill}
          onOpenChange={(open) =>
            setLinkRequest((current) => (current === null ? null : { ...current, open }))
          }
        />
      ) : null}
      {batchRequest ? (
        <LinkSeveralEnvironmentsDialog
          key={batchRequest.serial}
          environmentId={batchRequest.environmentId}
          open={batchRequest.open}
          preset={batchRequest.preset}
          presetOnly={batchRequest.presetOnly}
          onOpenChange={(open) =>
            setBatchRequest((current) => (current === null ? null : { ...current, open }))
          }
        />
      ) : null}
    </>
  );
}

interface FleetSceneProps {
  readonly graph: FleetGraph;
  readonly stacks: ReadonlyArray<FleetStack>;
  readonly layout: FleetLayout;
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
  readonly selection: FleetFocus | null;
  /** Machines ticked for a batch link. */
  readonly selected: ReadonlySet<string>;
  readonly onSelect: (focus: FleetFocus | null) => void;
  readonly onTick: (ids: ReadonlyArray<string>, mode: "toggle" | "add") => void;
  readonly onLink: (sourceId: string, targetId: string | null) => void;
  readonly onToggleStack: (stackId: string) => void;
}

interface FleetCanvasProps extends Omit<FleetSceneProps, "layout"> {
  /** The graph's shape. The canvas lays it out at its own width. */
  readonly shapeKey: string;
  readonly onClearTicked: () => void;
  readonly onLinkSeveral: (sourceId: string) => void;
  readonly dropped: CodeOnlyDrop | null;
  readonly onLinkOne: (sourceId: string, targetId: string) => void;
  readonly onDismissDropped: () => void;
  /** A search landed on a machine drawn only inside a stack. */
  readonly onFind: (stackId: string, memberId: string) => void;
}

function FleetCanvas({
  shapeKey: graphKey,
  onClearTicked,
  onLinkSeveral,
  dropped,
  onLinkOne,
  onDismissDropped,
  onFind,
  ...scene
}: FleetCanvasProps) {
  const t = useT();
  const { graph, stacks, selection, selected, onSelect, onTick } = scene;
  const [canvas, setCanvas] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  const { key: layoutKey, layout } = useFleetLayout(graph, stacks, graphKey, width);
  const [query, setQuery] = useState("");
  // A held view lasts while the map keeps its shape, whatever the width; otherwise it fits itself.
  const [manual, setManual] = useState<FleetHeldView | null>(null);
  // What was last drawn, to tell a stack opening or closing from any other change of shape.
  const [drawn, setDrawn] = useState({ graphKey, layoutKey, layout, stacks });
  const [dragging, setDragging] = useState(false);
  // The selection box, in canvas pixels, while Shift is held through a drag on empty canvas.
  const [box, setBox] = useState<FleetRect | null>(null);
  const drag = useRef<{
    readonly pointerId: number;
    readonly key: string;
    readonly mode: "pan" | "box";
    readonly x: number;
    readonly y: number;
    readonly left: number;
    readonly top: number;
    readonly origin: FleetViewTransform;
    moved: boolean;
  } | null>(null);
  if (drawn.layoutKey !== layoutKey) {
    setDrawn({ graphKey, layoutKey, layout, stacks });
    if (drawn.graphKey !== graphKey) {
      const toggled = stacks.find((stack) =>
        drawn.stacks.some((was) => was.id === stack.id && was.expanded !== stack.expanded),
      );
      const before = toggled === undefined ? undefined : drawn.layout.stacks.get(toggled.id);
      const after = toggled === undefined ? undefined : layout.stacks.get(toggled.id);
      if (width !== null && before !== undefined && after !== undefined) {
        // The stack stays where it is and the rest makes room, in the one render that opens it.
        const was = manual?.key === drawn.graphKey ? manual : null;
        const from = {
          width,
          height: was?.height ?? fleetCanvasHeight(drawn.layout, width, CANVAS_HEIGHT),
        };
        setManual(
          anchorFleetView({
            key: graphKey,
            from: {
              key: drawn.graphKey,
              held: was,
              view: was?.view ?? fitFleetLayout(drawn.layout, from),
              size: from,
              face: before.face,
            },
            stack: after,
            layout,
            bounds: CANVAS_HEIGHT,
          }),
        );
      } else if (manual !== null && manual.key !== "") {
        // Any other new shape drops the held view for good: returning to an old shape must
        // fit, not restore a pan made before the map changed.
        setManual({ ...manual, key: "" });
      }
    }
  }
  const held = manual?.key === graphKey ? manual : null;
  // Not measured: the height follows from the layout and the view, so it never feeds back.
  const size =
    width === null
      ? null
      : { width, height: held?.height ?? fleetCanvasHeight(layout, width, CANVAS_HEIGHT) };
  const view = held?.view ?? (size === null ? null : fitFleetLayout(layout, size));
  const glide = manual !== null && (held === null || held.glide);
  const setView = (next: FleetViewTransform, eased: boolean) => {
    if (size === null) return;
    setManual({ key: graphKey, view: next, height: size.height, glide: eased, undo: null });
  };
  const zoom = (
    factor: number,
    anchor?: { readonly x: number; readonly y: number },
    eased = true,
  ) => {
    if (view === null || size === null) return;
    setView(
      zoomFleetView(
        view,
        factor,
        anchor ?? { x: size.width / 2, y: size.height / 2 },
        fitFleetLayout(layout, size).scale,
      ),
      eased,
    );
  };
  // Keeps the entry so the scene eases back to the fit; its stale key marks it as not held.
  const fit = () => setManual((current) => (current === null ? null : { ...current, key: "" }));
  const onWheel = useEffectEvent((event: WheelEvent) => {
    // Plain scrolling stays the page's; a pinch or Ctrl/Cmd + wheel zooms the map.
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    zoom(
      Math.exp(-event.deltaY * 0.01),
      { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
      false,
    );
  });
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- measures the canvas with ResizeObserver, and React's wheel listener is passive so it cannot stop the page zooming
  useEffect(() => {
    if (canvas === null) return;
    const stopObserving = observeResize(canvas, ([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      stopObserving();
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [canvas]);

  // Reads the view inside the updater so the scene's props stay the same while panning.
  const reveal = useStableCallback((rect: FleetRect) => {
    if (size === null) return;
    setManual((current) => {
      const shown = current?.key === graphKey ? current.view : fitFleetLayout(layout, size);
      const left = rect.x * shown.scale + shown.x;
      const top = rect.y * shown.scale + shown.y;
      const inside =
        left >= 0 &&
        top >= 0 &&
        left + rect.width * shown.scale <= size.width &&
        top + rect.height * shown.scale <= size.height;
      if (inside) return current;
      return {
        key: graphKey,
        height: size.height,
        glide: true,
        undo: null,
        view: {
          scale: shown.scale,
          x: size.width / 2 - (rect.x + rect.width / 2) * shown.scale,
          y: size.height / 2 - (rect.y + rect.height / 2) * shown.scale,
        },
      };
    });
  });
  const centre = (rect: FleetRect) => {
    if (size === null || view === null) return;
    const scale = Math.max(view.scale, FOUND_MIN_SCALE);
    setView(
      {
        scale,
        x: size.width / 2 - (rect.x + rect.width / 2) * scale,
        y: size.height / 2 - (rect.y + rect.height / 2) * scale,
      },
      true,
    );
  };

  const matchIds = fleetSearch(graph, query);
  const matches = query.trim() === "" ? null : new Set(matchIds);
  const goToFirstMatch = () => {
    const first = matchIds[0];
    if (first === undefined) return;
    const rect = layout.nodes.get(first);
    if (rect !== undefined) {
      onSelect({ kind: "node", id: first });
      centre(rect);
      canvas
        ?.querySelector<HTMLElement>(`[data-fleet-node="${CSS.escape(first)}"]`)
        ?.focus({ preventScroll: true });
      return;
    }
    // Folded away: its stack's list in the details scrolls to it.
    const stack = stacks.find((entry) => entry.memberIds.includes(first));
    const face = stack === undefined ? undefined : layout.stacks.get(stack.id)?.face;
    if (stack === undefined || face === undefined) return;
    onFind(stack.id, first);
    centre(face);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // One pointer owns a drag: a second finger neither restarts it nor ends it.
    if (event.button !== 0 || view === null || drag.current !== null) return;
    if ((event.target as Element).closest("[data-fleet-item]")) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    drag.current = {
      pointerId: event.pointerId,
      key: layoutKey,
      mode: event.shiftKey ? "box" : "pan",
      x: event.clientX,
      y: event.clientY,
      left: bounds.left,
      top: bounds.top,
      origin: view,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const boxAt = (current: NonNullable<typeof drag.current>, event: PointerEvent): FleetRect => ({
    x: Math.min(current.x, event.clientX) - current.left,
    y: Math.min(current.y, event.clientY) - current.top,
    width: Math.abs(event.clientX - current.x),
    height: Math.abs(event.clientY - current.y),
  });
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    // The map was laid out again mid-drag, so the origin belongs to a view that is gone.
    if (current.key !== layoutKey) {
      drag.current = null;
      setDragging(false);
      setBox(null);
      return;
    }
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (!current.moved && Math.hypot(dx, dy) < 4) return;
    current.moved = true;
    if (current.mode === "box") {
      setBox(boxAt(current, event));
      return;
    }
    setDragging(true);
    setView({ ...current.origin, x: current.origin.x + dx, y: current.origin.y + dy }, false);
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const current = drag.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    setBox(null);
    if (cancelled) return;
    if (!current.moved) {
      if (current.mode === "pan") onSelect(null);
      return;
    }
    if (current.mode !== "box" || current.key !== layoutKey) return;
    const drawn = boxAt(current, event);
    // The box is in screen space: a zoom made mid-drag moved the map under it.
    const origin = view ?? current.origin;
    onTick(
      fleetNodesInBox(layout, {
        x: (drawn.x - origin.x) / origin.scale,
        y: (drawn.y - origin.y) / origin.scale,
        width: drawn.width / origin.scale,
        height: drawn.height / origin.scale,
      }),
      "add",
    );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "+" || event.key === "=") zoom(1.25);
    else if (event.key === "-") zoom(0.8);
    else if (event.key === "0") fit();
    else if (event.key === "Escape" && selection !== null) {
      // The dialog closes on a document Escape listener, so the map keeps this one.
      event.stopPropagation();
      onSelect(null);
    } else return;
    event.preventDefault();
  };

  const sources = graph.nodes.filter(
    (node): node is FleetEnvironmentNode => node.kind === "environment" && node.linking === "ready",
  );
  // The environment in the details is the one the user means; a lone one needs no asking.
  const source =
    sources.find((node) => selection?.kind === "node" && node.id === selection.id) ??
    (sources.length === 1 ? sources[0] : undefined);

  return (
    <>
      <div
        className={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-1.5", MAP_TOOLBAR_CLS)}
      >
        <div className="w-48">
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon aria-hidden />
            </InputGroupAddon>
            <InputGroupInput
              size="compact"
              type="text"
              role="searchbox"
              enterKeyHint="search"
              value={query}
              aria-label={t("Find a machine on the map")}
              placeholder={t("Find a machine")}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                // An Enter or Escape that belongs to an IME must not drive the map or close Settings.
                if (event.nativeEvent.isComposing || event.keyCode === 229) {
                  event.stopPropagation();
                  return;
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  goToFirstMatch();
                } else if (event.key === "Escape" && query !== "") {
                  event.preventDefault();
                  event.stopPropagation();
                  setQuery("");
                }
              }}
            />
          </InputGroup>
        </div>
        <p role="status" className={cn("min-w-0", MAP_CAPTION_CLS)}>
          {matches === null
            ? null
            : matchIds.length === 0
              ? t("No machine by that name")
              : matchCountText(matchIds.length, t)}
        </p>
        <div className="ml-auto flex items-center gap-2">
          {selected.size > 0 ? (
            <span className={cn("flex items-center gap-1", MAP_SELECTION_COUNT_CLS)}>
              <span role="status" className={MAP_TABULAR_CLS}>
                {t("{count} selected", { count: selected.size })}
              </span>
              <Button size="xs" variant="ghost-muted" onClick={onClearTicked}>
                {t("Clear")}
              </Button>
            </span>
          ) : null}
          {sources.length === 0 ? null : source !== undefined ? (
            <Button size="xs" variant="outline" onClick={() => onLinkSeveral(source.id)}>
              {t("Link several…")}
            </Button>
          ) : (
            <Menu>
              <MenuTrigger
                render={
                  <Button size="xs" variant="outline">
                    {t("Link several…")}
                  </Button>
                }
              />
              <MenuPopup align="end">
                {sources.map((node) => (
                  <MenuItem key={node.id} onClick={() => onLinkSeveral(node.id)}>
                    {t("From {source}", {
                      source: node.label,
                    })}
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
          )}
          <Popover>
            <PopoverTrigger
              render={
                <Button size="icon-xs" variant="ghost" aria-label={t("How to use the map")}>
                  <CircleHelpIcon />
                </Button>
              }
            />
            <PopoverPopup align="end" width="sm" padding="compact">
              <ul className={cn("space-y-1 pl-4", MAP_HELP_LIST_CLS)}>
                <li>{t("Select a machine to manage it.")}</li>
                {sources.length === 0 ? null : (
                  <>
                    <li>{t("Drag a plus onto a machine to link them.")}</li>
                    <li>{t("Shift-click or Shift-drag to select several")}</li>
                  </>
                )}
                <li>{t("A link reaches one machine and stops there.")}</li>
              </ul>
            </PopoverPopup>
          </Popover>
        </div>
      </div>
      {dropped === null ? null : (
        <CodeOnlyNotice
          graph={graph}
          dropped={dropped}
          onLinkOne={onLinkOne}
          onDismiss={onDismissDropped}
        />
      )}
      <div
        ref={setCanvas}
        data-dragging={dragging || undefined}
        data-glide={glide || undefined}
        className={cn("relative min-h-45 overflow-clip", MAP_CANVAS_CLS)}
        style={view === null || size === null ? undefined : { height: size.height }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => endDrag(event, false)}
        onPointerCancel={(event) => endDrag(event, true)}
        onLostPointerCapture={(event) => endDrag(event, true)}
        onKeyDown={onKeyDown}
        // Safari does not focus a clicked button, so its keys would skip the map.
        onClick={(event) =>
          (event.target as Element)
            .closest<HTMLElement>("button[data-fleet-item]")
            ?.focus({ preventScroll: true })
        }
      >
        {view === null ? null : (
          <div
            data-fleet-scene
            className={cn("absolute top-0 left-0", MAP_SCENE_LAYER_CLS)}
            style={{
              width: layout.width,
              height: layout.height,
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            }}
          >
            <FleetScene {...scene} layout={layout} matches={matches} onReveal={reveal} />
          </div>
        )}
        {box === null ? null : (
          <div
            aria-hidden
            style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
            className={cn("absolute", MAP_MARQUEE_CLS)}
          />
        )}
      </div>
      {/* Below the canvas, not over it: nothing on the map can end up under the controls. */}
      <div className={cn("flex items-center justify-end gap-3 px-3 py-1", MAP_CONTROLS_BAR_CLS)}>
        <div className={cn("flex shrink-0 items-center gap-1 p-0.5", MAP_ZOOM_GROUP_CLS)}>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={t("Zoom out")}
            onClick={() => zoom(0.8)}
          >
            <MinusIcon />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={t("Zoom in")}
            onClick={() => zoom(1.25)}
          >
            <PlusIcon />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={t("Fit the map to view")}
            disabled={held === null}
            onClick={fit}
          >
            <MaximizeIcon />
          </Button>
        </div>
      </div>
    </>
  );
}

/** A state short enough for a card. The reason behind it is in the details and the name. */
const wireTone = (selected: boolean, health: PeerLinkHealth) =>
  selected
    ? MAP_ACCENT_INK_CLS
    : linkNeedsAttention(health)
      ? healthTone(health)
      : MAP_FOREGROUND_CLS;

const isQuietHealth = (health: PeerLinkHealth) =>
  health.kind === "reachable" && health.expiresInDays === null;

const outgoingFailed = (node: FleetEnvironmentNode) =>
  node.outgoing === "error" && node.phase === "connected";

function connectionStateText(node: FleetEnvironmentNode, t: Translate): string {
  if (!node.enabled && node.phase !== "unsupported") {
    return t("Off");
  }
  switch (node.phase) {
    case "connected":
      return t("Connected");
    case "connecting":
      return t("Connecting…");
    case "reconnecting":
      return t("Reconnecting…");
    case "unsupported":
      return t("Client not supported");
    case "error":
      return t("Connection failed");
    case "offline":
      return t("Offline");
    case "available":
      return t("Not connected");
  }
}

function environmentStatusText(
  node: FleetEnvironmentNode,
  linkCount: number,
  t: Translate,
): string {
  if (node.phase !== "connected") return connectionStateText(node, t);
  switch (node.outgoing) {
    case "loading":
      return t("Loading links…");
    case "error":
      return t("Links could not be loaded");
    case "off":
      return t("Linked environments is off");
    case "unknown":
      return t("Links not readable from here");
    case "loaded":
      return linkOutCount(linkCount, t);
  }
}

function linkSummary(edge: FleetLinkEdge, t: Translate): string {
  return `${t(accessConfig[edge.link.access].label)}, ${healthLabel(edge.health, t)}`;
}

/** A link in words, for the pointer and for assistive tech. A two-way link names each direction. */
function linkName(
  edge: FleetLinkEdge,
  back: FleetLinkEdge | undefined,
  labelOf: (id: string) => string,
  t: Translate,
): string {
  const source = labelOf(edge.from);
  const target = labelOf(edge.to);
  return back === undefined
    ? t("Link from {source} to {target}: {summary}", {
        source,
        target,
        summary: linkSummary(edge, t),
      })
    : t(
        "Two-way link between {source} and {target}, {access}. {source} to {target}: {forward}. {target} to {source}: {back}",
        {
          source,
          target,
          access: t(accessConfig[edge.link.access].label),
          forward: healthLabel(edge.health, t),
          back: healthLabel(back.health, t),
        },
      );
}

/**
 * Says in place why a drop cannot be linked in one go, and offers what works: one machine at
 * a time, with a pairing code from it.
 */
function CodeOnlyNotice({
  graph,
  dropped,
  onLinkOne,
  onDismiss,
}: {
  readonly graph: FleetGraph;
  readonly dropped: CodeOnlyDrop;
  readonly onLinkOne: (sourceId: string, targetId: string) => void;
  readonly onDismiss: () => void;
}) {
  const t = useT();
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const source = byId.get(dropped.sourceId);
  const machines = dropped.machineIds.flatMap((id) => byId.get(id) ?? []);
  if (source === undefined || machines.length === 0) return null;
  return (
    <div
      role="status"
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2", MAP_NOTICE_BAR_CLS)}
    >
      <p className={cn("min-w-0 flex-1 basis-64", MAP_MUTED_CLS)}>
        {needsCodeText(machines.length, t)}
      </p>
      {/* Linking through an environment that already reaches these machines would be offered here. */}
      <Menu>
        <MenuTrigger
          render={
            <Button size="xs" variant="outline">
              {t("Link one with a code…")}
            </Button>
          }
        />
        <MenuPopup align="end">
          {machines.map((machine) => (
            <MenuItem key={machine.id} onClick={() => onLinkOne(dropped.sourceId, machine.id)}>
              {machine.label}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
      <Button size="icon-xs" variant="ghost" aria-label={t("Dismiss")} onClick={onDismiss}>
        <XIcon />
      </Button>
    </div>
  );
}

function actionText(action: FleetLinkAction | null, target: string, t: Translate): string {
  if (action === null) return t("Cannot link to this");
  if (action.kind === "code-only") return needsCodeText(action.machineIds.length, t);
  if (action.kind === "batch") {
    return linkToMachinesText(action.environmentIds.length, t);
  }
  const { offer } = action;
  if (offer === null) return t("Cannot link to this");
  if (offer.path === "code-less") {
    return offer.renews
      ? t("Renew link to {target}", { target })
      : t("Link to {target}", { target });
  }
  return offer.renews
    ? t("Renew link to {target} with a pairing code", { target })
    : t("Link to {target} with a pairing code", { target });
}

function foldGroupLabel(group: FleetFoldGroup, t: Translate): string {
  switch (group) {
    case "offline":
      return t("Offline");
    case "off":
      return t("Switched off");
    case "update":
      return t("Need an update");
  }
}

interface LinkDrag {
  readonly sourceId: string;
  readonly x: number;
  readonly y: number;
  readonly overId: string | null;
}

function FleetScene({
  graph,
  stacks,
  layout,
  environments,
  selection,
  selected,
  matches,
  onSelect,
  onTick,
  onLink,
  onToggleStack,
  onReveal,
}: FleetSceneProps & {
  /** Machines a search names; the rest step back. Null when nothing is searched for. */
  readonly matches: ReadonlySet<string> | null;
  readonly onReveal: (rect: FleetRect) => void;
}) {
  const t = useT();
  const [hover, setHover] = useState<FleetFocus | null>(null);
  const [roving, setRoving] = useState(FLEET_CLIENT_NODE_ID);
  const [linkDrag, setLinkDrag] = useState<LinkDrag | null>(null);
  const handleDrag = useRef<{
    readonly pointerId: number;
    readonly x: number;
    readonly y: number;
    moved: boolean;
  } | null>(null);
  // A drag ends with a click on the handle it started from; that click must not open the dialog.
  const swallowClick = useRef(false);
  const focus = linkDrag === null ? (hover ?? selection) : null;
  const lit = focus === null ? null : fleetNeighborhood(graph, stacks, focus);
  const hasFocus = lit !== null;
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const environmentById = new Map(
    environments.map((environment) => [
      fleetEnvironmentNodeId(environment.environmentId),
      environment,
    ]),
  );
  const links = graph.edges.filter(isLinkEdge);
  const pairs = fleetTwoWayLinks(graph);
  const labelOf = (id: string) => nodeById.get(id)?.label ?? "";
  /** The other link of the two-way link `edge` is drawn for. */
  const backOf = (edge: FleetLinkEdge) => pairs.get(edge.id)?.back;
  const routeEdges = graph.edges.filter(isRouteEdge);
  const focusRects = fleetFocusRects(layout);
  const tabStop = focusRects.has(roving) ? roving : FLEET_CLIENT_NODE_ID;
  const isSelected = (kind: FleetFocus["kind"], id: string) =>
    selection?.kind === kind && selection.id === id;
  const fade = (dimmed: boolean) =>
    cn(
      "transition-opacity duration-(--motion-feedback) ease-standard",
      dimmed && "opacity-40 forced-colors:opacity-60",
    );
  // Lines run the length of the map and cross each other, so one out of focus fades further
  // than a machine does.
  const fadeLine = (dimmed: boolean) =>
    cn(
      "transition-opacity duration-(--motion-feedback) ease-standard",
      dimmed && "opacity-25 forced-colors:opacity-40",
    );
  // A name on a line stays solid when out of focus, so the lines under it never show through:
  // its text and outline step back instead.
  const fadeName = (dimmed: boolean) =>
    cn("", dimmed && "border-border/50 font-normal text-muted-foreground/45");
  const routeLit = (edge: FleetRouteEdge) => lit === null || lit.edges.has(edge.id);
  // Painted last, so the routes in focus lie over the ones that are not.
  const routePaintOrder =
    lit === null ? routeEdges : routeEdges.toSorted((a, b) => +routeLit(a) - +routeLit(b));
  const linkLit = (edge: FleetLinkEdge) =>
    isSelected("edge", edge.id) || (lit?.edges.has(edge.id) ?? false);
  // Painted last, so the links in focus lie over the ones that are not.
  const paintOrder = lit === null ? links : links.toSorted((a, b) => +linkLit(a) - +linkLit(b));
  const dragAction = (targetId: string) =>
    linkDrag === null
      ? null
      : fleetLinkAction(graph, stacks, selected, linkDrag.sourceId, targetId);
  // A stack fades as a whole, by the links and machines it stands for.
  const nodeDimmed = (id: string) =>
    layout.stacks.has(id)
      ? false
      : linkDrag !== null
        ? id !== linkDrag.sourceId && dragAction(id) === null
        : (lit !== null && !lit.nodes.has(id)) || (matches !== null && !matches.has(id));
  // By the links it stands for: a host and a member can both be lit through other links.
  const stackLit = (stack: FleetStack) =>
    lit === null || stack.edgeIds.some((id) => lit.edges.has(id));
  const stackDimmed = (stack: FleetStack) =>
    linkDrag !== null
      ? false
      : !stackLit(stack) || (matches !== null && !stack.memberIds.some((id) => matches.has(id)));
  // A machine drawn on its own can be ticked for a batch link; the client and stacks cannot.
  const tickable = (id: string) => id !== FLEET_CLIENT_NODE_ID && layout.nodes.has(id);
  // A machine shown in the details but folded into a stack marks the stack it is in.
  const holdsSelection = (stack: FleetStack) =>
    selection?.kind === "node" &&
    !layout.nodes.has(selection.id) &&
    stack.memberIds.includes(selection.id);
  const hoverProps = (target: FleetFocus) => ({
    onPointerEnter: () => setHover(target),
    onPointerLeave: () => setHover(null),
  });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const direction = ARROW_ROVE[event.key];
    const from = (event.target as HTMLElement).closest<HTMLElement>("[data-fleet-node]");
    if (event.key === " " && from !== null && tickable(from.dataset.fleetNode ?? "")) {
      // Space ticks the machine for a batch link; Enter still opens its details.
      event.preventDefault();
      if (!event.repeat) onTick([from.dataset.fleetNode ?? ""], "toggle");
      return;
    }
    if (direction === undefined || from === null) return;
    event.preventDefault();
    const next = nextFleetNode(focusRects, from.dataset.fleetNode ?? "", direction);
    const rect = next === null ? undefined : focusRects.get(next);
    if (next === null || rect === undefined) return;
    event.currentTarget
      .querySelector<HTMLElement>(`[data-fleet-node="${CSS.escape(next)}"]`)
      ?.focus({ preventScroll: true });
    onReveal(rect);
  };

  const focusProps = (target: FleetFocus, rect: FleetRect, label: string) => ({
    type: "button" as const,
    "data-fleet-item": "",
    "data-fleet-node": target.id,
    "aria-label": selected.has(target.id) ? t("{label}, selected", { label }) : label,
    "aria-pressed": isSelected(target.kind, target.id),
    tabIndex: target.id === tabStop ? 0 : -1,
    style: { left: rect.x, top: rect.y, width: rect.width, height: rect.height },
    onClick: (event: MouseEvent<HTMLElement>) => {
      if ((event.shiftKey || event.metaKey || event.ctrlKey) && tickable(target.id)) {
        onTick([target.id], "toggle");
        return;
      }
      onSelect(isSelected(target.kind, target.id) ? null : target);
    },
    // The keydown ticked the machine; without this the button would also click.
    onKeyUp: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === " " && tickable(target.id)) event.preventDefault();
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      setRoving(target.id);
      setHover(target);
      // Tabbing back in can land on a machine panned out of view; a click cannot.
      if (event.currentTarget.matches(":focus-visible")) onReveal(rect);
    },
    onBlur: () => setHover(null),
    ...hoverProps(target),
  });
  const nodeClass = (id: string) =>
    cn(
      "absolute flex cursor-pointer items-center text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-pressed:ring-2 aria-pressed:ring-primary aria-pressed:ring-inset forced-colors:focus-visible:outline-2 forced-colors:aria-pressed:outline-2",
      fade(nodeDimmed(id)),
      linkDrag?.overId === id && "ring-2 ring-primary ring-inset",
    );

  const toScene = (event: PointerEvent<HTMLElement>) => {
    const bounds = event.currentTarget.closest("[data-fleet-scene]")?.getBoundingClientRect();
    if (!bounds || bounds.width === 0) return null;
    const scale = bounds.width / layout.width;
    return { x: (event.clientX - bounds.left) / scale, y: (event.clientY - bounds.top) / scale };
  };
  const dropTargetAt = (sourceId: string, event: PointerEvent<HTMLElement>) => {
    const over = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-fleet-node]")?.dataset.fleetNode;
    return over !== undefined && fleetLinkAction(graph, stacks, selected, sourceId, over) !== null
      ? over
      : null;
  };
  const handleProps = (sourceId: string) => ({
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0 || handleDrag.current !== null) return;
      swallowClick.current = false;
      handleDrag.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        moved: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: PointerEvent<HTMLButtonElement>) => {
      const current = handleDrag.current;
      if (current === null || current.pointerId !== event.pointerId) return;
      if (!current.moved && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 4) {
        return;
      }
      current.moved = true;
      const point = toScene(event);
      if (point === null) return;
      setLinkDrag({ sourceId, ...point, overId: dropTargetAt(sourceId, event) });
    },
    onPointerUp: (event: PointerEvent<HTMLButtonElement>) => {
      const current = handleDrag.current;
      if (current === null || current.pointerId !== event.pointerId) return;
      handleDrag.current = null;
      if (!current.moved) return;
      swallowClick.current = true;
      // Asked again at release: the map can move under a pointer that has stopped.
      const overId = dropTargetAt(sourceId, event);
      setLinkDrag(null);
      if (overId !== null) onLink(sourceId, overId);
    },
    onLostPointerCapture: () => {
      if (handleDrag.current === null) return;
      handleDrag.current = null;
      setLinkDrag(null);
    },
    onClick: () => {
      if (swallowClick.current) {
        swallowClick.current = false;
        return;
      }
      onLink(sourceId, null);
    },
  });

  const dragSource = linkDrag === null ? undefined : layout.handles.get(linkDrag.sourceId);
  const dragOver = linkDrag?.overId ?? null;

  return (
    <div
      role="group"
      aria-label={t("Map of your machines")}
      aria-description={t(
        "Arrow keys move between machines. Enter opens a machine's details, with its routes and links. Space selects a machine for linking several at once. Tab from an environment reaches its link button. Plus and minus zoom, zero fits the map.",
      )}
      onKeyDown={onKeyDown}
    >
      {layout.columns
        .filter((column) => column.id === "targets")
        .map((column) => (
          <p
            key={column.id}
            aria-hidden
            style={{ left: column.x }}
            className={cn("absolute top-0", MAP_COLUMN_TITLE_CLS)}
          >
            {t("Linked machines")}
          </p>
        ))}
      <svg
        width={layout.width}
        height={layout.height}
        className="absolute top-0 left-0 overflow-visible"
        fill="none"
        strokeLinecap="round"
      >
        {routePaintOrder.map((edge) => {
          const geometry = layout.routes.get(edge.id);
          if (geometry === undefined) return null;
          const style = ROUTE_STYLES[edge.state];
          return (
            <path
              key={edge.id}
              d={geometry.d}
              stroke="currentColor"
              strokeWidth={style.width}
              strokeDasharray={style.dash}
              className={cn(style.wire, fadeLine(!routeLit(edge)))}
            />
          );
        })}
        {stacks.map((stack) => {
          const geometry = layout.stacks.get(stack.id);
          if (geometry === undefined) return null;
          const onPath = stackLit(stack);
          return geometry.lines.map((line) => {
            // A folded group of environments has one wire for all its routes, none in use.
            if (line.access === null) {
              return (
                <path
                  key={`${stack.id}:routes`}
                  d={line.d}
                  stroke="currentColor"
                  strokeWidth={ROUTE_STYLES.idle.width}
                  strokeDasharray={ROUTE_STYLES.idle.dash}
                  className={cn(ROUTE_STYLES.idle.wire, fadeLine(hasFocus && !onPath))}
                />
              );
            }
            const level = accessLevel(line.access);
            const mine = lit === null || lit.nodes.has(line.sourceId ?? "");
            return (
              <g
                key={`${stack.id}:${line.sourceId}`}
                className={cn(MAP_FOREGROUND_CLS, fadeLine(hasFocus && !(onPath && mine)))}
                opacity={lit !== null && onPath && mine ? 1 : ACCESS_STROKE_OPACITIES[level]}
              >
                <path d={line.d} stroke="currentColor" strokeWidth={ACCESS_STROKE_WIDTHS[level]} />
                {line.arrow === null ? null : (
                  <path
                    d={`M${line.arrow.x - 8} ${line.arrow.y - 4.5}L${line.arrow.x} ${line.arrow.y}L${line.arrow.x - 8} ${line.arrow.y + 4.5}Z`}
                    fill="currentColor"
                  />
                )}
              </g>
            );
          });
        })}
        {paintOrder.map((edge) => {
          const geometry = layout.links.get(edge.id);
          if (geometry === undefined) return null;
          const selected = isSelected("edge", edge.id);
          const level = accessLevel(edge.link.access);
          const back = backOf(edge);
          // A two-way link is drawn in halves, each leading into the machine its link reaches,
          // so a direction in trouble shows at its own end.
          const parts: ReadonlyArray<readonly [string, FleetArrow, PeerLinkHealth]> =
            geometry.twoWay !== null && back !== undefined
              ? [
                  [geometry.twoWay.forward, geometry.arrow, edge.health],
                  [geometry.twoWay.back, geometry.twoWay.backArrow, back.health],
                ]
              : [[geometry.d, geometry.arrow, edge.health]];
          return (
            <g
              key={edge.id}
              className={cn(MAP_PASSIVE_CLS, fadeLine(hasFocus && !linkLit(edge)))}
              opacity={linkLit(edge) ? 1 : ACCESS_STROKE_OPACITIES[level]}
            >
              {parts.map(([d, arrow, health]) => (
                <g key={d} className={wireTone(selected, health)}>
                  <path
                    d={d}
                    stroke="currentColor"
                    // Selection also thickens the line, for when colour is forced.
                    strokeWidth={(ACCESS_STROKE_WIDTHS[level] ?? 2) + (selected ? 1 : 0)}
                    strokeDasharray={healthDash(health)}
                  />
                  <path
                    d={`M${arrow.x - arrow.dir * 7} ${arrow.y - 4}L${arrow.x} ${arrow.y}L${arrow.x - arrow.dir * 7} ${arrow.y + 4}Z`}
                    fill="currentColor"
                  />
                </g>
              ))}
            </g>
          );
        })}
        {/* Pointer shortcut only: each link is also a row in its machines' details. Kept in a
            fixed order apart from the painted lines, so focus never moves one under the pointer. */}
        {links.map((edge) => {
          const geometry = layout.links.get(edge.id);
          if (geometry === undefined) return null;
          const selected = isSelected("edge", edge.id);
          return (
            <path
              key={edge.id}
              aria-hidden
              data-fleet-item=""
              d={geometry.d}
              stroke="transparent"
              strokeWidth="14"
              className={MAP_CLICKABLE_CLS}
              onClick={() => onSelect(selected ? null : { kind: "edge", id: edge.id })}
              {...hoverProps({ kind: "edge", id: edge.id })}
            >
              <title>{linkName(edge, backOf(edge), labelOf, t)}</title>
            </path>
          );
        })}
        {linkDrag !== null && dragSource !== undefined ? (
          <path
            d={`M${dragSource.x} ${dragSource.y}C${dragSource.x + 48} ${dragSource.y} ${linkDrag.x - 48} ${linkDrag.y} ${linkDrag.x} ${linkDrag.y}`}
            stroke="currentColor"
            strokeWidth="1.75"
            strokeDasharray="5 4"
            className={MAP_DRAG_LINE_CLS}
          />
        ) : null}
      </svg>
      {routeEdges.map((edge) => {
        const geometry = layout.routes.get(edge.id);
        if (geometry === undefined) return null;
        const { pill } = geometry;
        return (
          <span
            key={edge.id}
            aria-hidden
            style={{ left: pill.x, top: pill.y, width: pill.width, height: pill.height }}
            className={cn(
              "absolute flex items-center justify-center px-1.5",
              MAP_ROUTE_PILL_CLS,
              routeLit(edge) && ROUTE_STYLES[edge.state].pill,
              // Lit routes sit over the others, whose wires pass beside them on the way in.
              routeLit(edge) && "z-1",
              fadeName(!routeLit(edge)),
            )}
          >
            <span className="truncate">
              {pill.width < ROUTE_NAME_FULL_WIDTH
                ? routeKindLabel(edge.routeKind, t)
                : (edge.routeLabel ?? routeKindLabel(edge.routeKind, t))}
            </span>
          </span>
        );
      })}
      {links.map((edge) => {
        const badge = layout.links.get(edge.id)?.badge;
        if (!badge) return null;
        const target = { kind: "edge", id: edge.id } as const;
        const back = backOf(edge);
        const health = back === undefined ? edge.health : worseLinkHealth(edge.health, back.health);
        // With no clear place of its own, the name shows only while its link is the one in focus.
        if (
          badge.onDemand &&
          !isSelected("edge", edge.id) &&
          !(focus?.kind === "edge" && focus.id === edge.id)
        ) {
          return null;
        }
        return (
          <button
            key={edge.id}
            type="button"
            data-fleet-item=""
            tabIndex={-1}
            aria-pressed={isSelected("edge", edge.id)}
            aria-label={linkName(edge, back, labelOf, t)}
            // Hangs off its own lane and grows away from the lanes beside it.
            style={{
              top: badge.y,
              height: badge.height,
              maxWidth: badge.width,
              ...(badge.side === 1
                ? { left: badge.x }
                : { right: layout.width - badge.x - badge.width }),
            }}
            className={cn(
              "absolute flex items-center gap-1.5 px-1.5",
              MAP_LINK_NAME_CLS,
              lit === null || lit.edges.has(edge.id) ? healthTone(health) : null,
              badge.onDemand && cn("z-10", MAP_RAISED_CLS),
              fadeName(lit !== null && !lit.edges.has(edge.id)),
            )}
            onClick={() => onSelect(isSelected("edge", edge.id) ? null : target)}
            onFocus={() => setHover(target)}
            onBlur={() => setHover(null)}
            {...hoverProps(target)}
          >
            {back === undefined ? null : (
              <ArrowUpDownIcon aria-hidden className="size-3 shrink-0" />
            )}
            <AccessMeter
              access={edge.link.access}
              className={cn(hasFocus && !lit?.edges.has(edge.id) && MAP_DIMMED_METER_CLS)}
            />
            <span className="truncate">{t(accessConfig[edge.link.access].label)}</span>
          </button>
        );
      })}
      {stacks.map((stack) => {
        const geometry = layout.stacks.get(stack.id);
        if (geometry === undefined) return null;
        const { face, tray, more } = geometry;
        const count = stack.memberIds.length;
        const range =
          stack.firstLabel === stack.lastLabel
            ? stack.firstLabel
            : `${stack.firstLabel} … ${stack.lastLabel}`;
        const group = stack.group === null ? null : foldGroupLabel(stack.group, t);
        const [only] = stack.sources;
        const summary =
          group !== null
            ? range
            : stack.sources.length === 1 && only !== undefined
              ? t("{access}. {reachable} of {count} reachable", {
                  access: t(accessConfig[only.access].label),
                  reachable: stack.reachable,
                  count,
                })
              : t("{reachable} of {count} reachable, from {sources} environments", {
                  reachable: stack.reachable,
                  count,
                  sources: stack.sources.length,
                });
        const spoken =
          group !== null
            ? t("{group}: {count} environments with no links, {range}", { group, count, range })
            : t("{range}, {count} machines linked from {sources}. {summary}", {
                range,
                count,
                sources: stack.sources
                  .map((source) => nodeById.get(source.sourceId)?.label ?? "")
                  .join(", "),
                summary,
              });
        const partial = fleetStackPartial(stack);
        // The room the card adds below its name when some machines do not answer.
        const partialBand = partial ? 20 : 0;
        const ToggleIcon = stack.expanded ? FoldVerticalIcon : UnfoldVerticalIcon;
        const hidden = count - stack.shownIds.length;
        return (
          <div key={stack.id} className={fade(stackDimmed(stack))}>
            {/* The card is the same open or closed, so it does not change under the pointer. */}
            {[8, 4].map((lift) => (
              <div
                key={lift}
                aria-hidden
                style={{
                  left: face.x + lift,
                  top: face.y - lift,
                  width: face.width,
                  height: face.height,
                }}
                className={cn(
                  "absolute",
                  MAP_STACK_CARD_CLS,
                  group !== null && MAP_DASHED_CLS,
                  stack.expanded && MAP_HIDDEN_CLS,
                )}
              />
            ))}
            {tray === null ? null : (
              <div
                aria-hidden
                style={{ left: tray.x, top: tray.y, width: tray.width, height: tray.height }}
                className={cn("absolute", MAP_STACK_TRAY_CLS, APPEAR)}
              />
            )}
            <button
              {...focusProps({ kind: "stack", id: stack.id }, face, spoken)}
              className={cn(
                nodeClass(stack.id),
                "flex-col items-stretch overflow-clip",
                MAP_STACK_FACE_CLS,
                partialBand > 0 ? MAP_STACK_PARTIAL_BORDER_CLS : MAP_STACK_BORDER_CLS,
                group !== null && MAP_DASHED_CLS,
                holdsSelection(stack) && MAP_SELECTED_RING_CLS,
              )}
            >
              <span className="flex min-h-0 min-w-0 flex-1 flex-col justify-center px-2.5 pr-8">
                <span className="flex items-center gap-1.5">
                  <span className={cn("truncate", MAP_STACK_TITLE_CLS)}>{group ?? range}</span>
                  {group === null ? null : (
                    <span className={cn("shrink-0 px-1.5", MAP_STACK_COUNT_BADGE_CLS)}>
                      {count}
                    </span>
                  )}
                </span>
                {group !== null ? (
                  <span className={cn("block truncate", MAP_STACK_CAPTION_CLS)}>{range}</span>
                ) : (
                  <span className={cn("flex items-center gap-1.5", MAP_STACK_CAPTION_CLS)}>
                    {only !== undefined && stack.sources.length === 1 ? (
                      <AccessMeter access={only.access} className={MAP_METER_INK_CLS} />
                    ) : null}
                    <span className={MAP_STACK_COUNT_CLS}>{machineCountText(count, t)}</span>
                  </span>
                )}
              </span>
              {partialBand === 0 ? null : (
                // The headline of a stack that is partly down: its own band, never cut short.
                <span
                  style={{ height: partialBand }}
                  className={cn(
                    "flex shrink-0 items-center gap-1.5 px-2.5",
                    MAP_STACK_PARTIAL_BAND_CLS,
                  )}
                >
                  <TriangleAlertIcon
                    aria-hidden
                    className={cn("size-3 shrink-0", MAP_WARNING_CLS)}
                  />
                  <span className={cn("shrink-0", MAP_STACK_COUNT_CLS)}>
                    {reachableText(stack.reachable, t)}
                  </span>
                  <span className={cn("h-1 min-w-0 flex-1 overflow-clip", MAP_REACH_TRACK_CLS)}>
                    <span
                      className={cn("block h-full", MAP_REACH_FILL_CLS)}
                      style={{ width: `${(stack.reachable / count) * 100}%` }}
                    />
                  </span>
                </span>
              )}
            </button>
            <button
              type="button"
              data-fleet-item=""
              tabIndex={stack.id === tabStop ? 0 : -1}
              aria-label={
                stack.expanded
                  ? t("Collapse these machines")
                  : hidden > 0
                    ? t("Show the first {shown} machines on the map", {
                        shown: stack.shownIds.length,
                      })
                    : t("Show each machine on the map")
              }
              aria-expanded={stack.expanded}
              style={{
                left: face.x + face.width - 28,
                top: face.y + (face.height - partialBand) / 2 - 11,
              }}
              className={cn(
                "absolute flex size-5.5 items-center justify-center",
                MAP_STACK_TOGGLE_CLS,
              )}
              onClick={() => onToggleStack(stack.id)}
            >
              <ToggleIcon aria-hidden className="size-3.5" />
            </button>
            {more === null ? null : (
              // The rest are never drawn: the details list every machine, and can be searched.
              <button
                type="button"
                data-fleet-item=""
                data-fleet-node={fleetMoreNodeId(stack.id)}
                tabIndex={fleetMoreNodeId(stack.id) === tabStop ? 0 : -1}
                style={{ left: more.x, top: more.y, width: more.width, height: more.height }}
                className={cn("absolute flex items-center px-2", MAP_MORE_CHIP_CLS, APPEAR)}
                onClick={() => onSelect({ kind: "stack", id: stack.id })}
                onFocus={() => setRoving(fleetMoreNodeId(stack.id))}
              >
                <span className="truncate">
                  {t("and {count} more", {
                    count: hidden,
                  })}
                </span>
              </button>
            )}
          </div>
        );
      })}
      {graph.nodes.map((node) => {
        const rect = layout.nodes.get(node.id);
        if (rect === undefined) return null;
        const target = { kind: "node", id: node.id } as const;
        if (node.kind === "client") {
          const ClientIcon = isDesktopHost ? AppWindowIcon : GlobeIcon;
          return (
            <button
              key={node.id}
              {...focusProps(target, rect, node.label)}
              className={cn(nodeClass(node.id), "gap-2 px-3.5", MAP_CLIENT_NODE_CLS)}
            >
              {rect.width < CLIENT_ICON_MIN_WIDTH ? null : (
                <ClientIcon aria-hidden className={cn("size-4 shrink-0", MAP_MUTED_CLS)} />
              )}
              <span className={cn("truncate", MAP_CLIENT_LABEL_CLS)}>{node.label}</span>
            </button>
          );
        }
        const incoming = links.filter((edge) => edge.to === node.id);
        if (node.kind === "target") {
          // One link in names its access here. Several are told apart by the one in focus:
          // hovering or selecting a host shows what that host may do on this machine.
          const focused = incoming.filter((edge) => lit?.edges.has(edge.id));
          const shown =
            incoming.length === 1 ? incoming[0] : focused.length === 1 ? focused[0] : undefined;
          const first = shown ?? incoming.toSorted(byTrouble)[0];
          const compact = rect.height < 32;
          return (
            <button
              key={node.id}
              {...focusProps(
                target,
                rect,
                [
                  node.label,
                  t("known only through a link"),
                  ...incoming.map((edge) =>
                    t("from {source}: {summary}", {
                      source: nodeById.get(edge.from)?.label ?? "",
                      summary: linkSummary(edge, t),
                    }),
                  ),
                ].join(", "),
              )}
              className={cn(
                nodeClass(node.id),
                "gap-2",
                MAP_TARGET_NODE_CLS,
                compact
                  ? cn("px-2", MAP_TARGET_COMPACT_CLS, APPEAR)
                  : cn("px-2.5", MAP_TARGET_FULL_CLS),
                first ? healthBorder(first.health) : MAP_TARGET_IDLE_BORDER_CLS,
              )}
            >
              <span className="flex w-3 shrink-0 justify-center">
                {first ? <HealthGlyph health={first.health} /> : null}
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    "block truncate",
                    compact ? MAP_TARGET_COMPACT_LABEL_CLS : MAP_TARGET_LABEL_CLS,
                  )}
                >
                  {node.label}
                </span>
                {compact || !first ? null : (
                  <span
                    className={cn(
                      "block truncate",
                      MAP_NODE_CAPTION_CLS,
                      isQuietHealth(first.health) ? MAP_MUTED_CLS : healthTone(first.health),
                    )}
                  >
                    {shown === undefined
                      ? linkInCount(incoming.length, t)
                      : isQuietHealth(first.health)
                        ? t(accessConfig[first.link.access].label)
                        : healthLabel(first.health, t)}
                  </span>
                )}
              </span>
              {compact || !shown ? null : (
                <AccessMeter access={shown.link.access} className={MAP_METER_INK_CLS} />
              )}
            </button>
          );
        }
        if (rect.height < 32) {
          // Inside an open group of environments: its name and state; the details have the rest.
          const state = connectionStateText(node, t);
          const dotClass =
            node.kind === "environment" && node.enabled
              ? connectionPhaseDotClassName(node.phase)
              : MAP_DOT_OFF_CLS;
          return (
            <button
              key={node.id}
              {...focusProps(target, rect, `${node.label}, ${state}`)}
              className={cn(nodeClass(node.id), "gap-1.5 px-2", MAP_FOLDED_NODE_CLS, APPEAR)}
            >
              <span aria-hidden className={cn("size-2 shrink-0", MAP_DOT_CLS, dotClass)} />
              <span className={cn("truncate", MAP_TARGET_COMPACT_LABEL_CLS)}>{node.label}</span>
            </button>
          );
        }
        const environment = environmentById.get(node.id);
        const routes = routeEdges.filter((edge) => edge.to === node.id);
        const fullStatus = environmentStatusText(
          node,
          links.filter((edge) => edge.from === node.id).length,
          t,
        );
        const status =
          rect.width < STATUS_FULL_WIDTH && fullStatus === t("Client not supported")
            ? t("Not supported")
            : fullStatus;
        // The card's state is short; the name carries the reason and what it leaves unknown.
        const spoken =
          node.phase === "connected"
            ? status
            : t("{status}. Links unknown", {
                status: environment ? savedBackendStatus(environment).text : status,
              });
        const dimmed = !node.enabled || node.phase === "unsupported";
        const handle = layout.handles.get(node.id);
        const over = linkDrag?.overId === node.id;
        return (
          <div key={node.id}>
            <button
              {...focusProps(
                target,
                rect,
                [
                  node.label,
                  spoken,
                  ...routes.map(
                    (edge) =>
                      `${edge.routeLabel ?? routeKindLabel(edge.routeKind, t)}: ${routeStateLabel(edge.state, t)}`,
                  ),
                ].join(", "),
              )}
              className={cn(
                nodeClass(node.id),
                "gap-2 px-2.5",
                MAP_ENVIRONMENT_NODE_CLS,
                dimmed ? MAP_ENVIRONMENT_DIMMED_BORDER_CLS : MAP_ENVIRONMENT_BORDER_CLS,
                over && MAP_DROP_TARGET_BORDER_CLS,
              )}
            >
              <span
                className={cn(
                  "relative flex size-6 shrink-0 items-center justify-center",
                  MAP_MACHINE_TILE_CLS,
                  dimmed && MAP_DIMMED_TILE_CLS,
                )}
              >
                <EnvironmentMachineIcon kind={node.machine ?? "server"} className="size-3.5" />
                <span
                  aria-hidden
                  className={cn(
                    "absolute size-2.5",
                    MAP_STATUS_DOT_CLS,
                    node.enabled ? connectionPhaseDotClassName(node.phase) : MAP_DOT_OFF_CLS,
                  )}
                />
              </span>
              <span className={cn("min-w-0 flex-1 pr-1.5", dimmed && MAP_DIMMED_TEXT_CLS)}>
                <span className={MAP_ENVIRONMENT_LABEL_CLS}>{node.label}</span>
                <span
                  className={cn(
                    "block truncate",
                    MAP_NODE_CAPTION_CLS,
                    outgoingFailed(node) ? MAP_ERROR_CLS : MAP_MUTED_CLS,
                  )}
                >
                  {status}
                </span>
              </span>
            </button>
            {handle !== undefined && node.linking === "ready" ? (
              <button
                type="button"
                data-fleet-item=""
                tabIndex={node.id === tabStop ? 0 : -1}
                aria-label={t("Link {label} to another machine", { label: node.label })}
                style={{ left: handle.x - 9, top: handle.y - 9 }}
                onFocus={(event) => {
                  // Its own bounds: it straddles the card's edge, so the card can be in view
                  // while half the handle is not.
                  if (event.currentTarget.matches(":focus-visible")) {
                    onReveal({ x: handle.x - 9, y: handle.y - 9, width: 18, height: 18 });
                  }
                }}
                className={cn(
                  "absolute flex size-4.5 items-center justify-center",
                  MAP_LINK_HANDLE_CLS,
                  fade(nodeDimmed(node.id)),
                )}
                {...handleProps(node.id)}
              >
                <PlusIcon aria-hidden className={cn("size-3", MAP_HANDLE_PLUS_CLS)} />
              </button>
            ) : null}
          </div>
        );
      })}
      {[...selected].map((id) => {
        const rect = layout.nodes.get(id);
        if (rect === undefined) return null;
        return (
          <span
            key={id}
            aria-hidden
            style={{
              left: rect.x - 3,
              top: rect.y - 3,
              width: rect.width + 6,
              height: rect.height + 6,
            }}
            className={cn("absolute", MAP_TICKED_FRAME_CLS)}
          >
            <span
              className={cn("absolute flex size-4 items-center justify-center", MAP_TICK_BADGE_CLS)}
            >
              <CheckIcon className={cn("size-2.5", MAP_TICK_GLYPH_CLS)} />
            </span>
          </span>
        );
      })}
      {linkDrag !== null ? (
        <DragHint x={linkDrag.x} y={linkDrag.y}>
          {dragOver !== null
            ? actionText(dragAction(dragOver), nodeById.get(dragOver)?.label ?? "", t)
            : t("Drop on a machine to link")}
        </DragHint>
      ) : null}
    </div>
  );
}

function DragHint({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return (
    <p
      role="status"
      style={{ left: x + 14, top: y + 14 }}
      className={cn("absolute z-10 px-2 py-1", MAP_DRAG_HINT_CLS)}
    >
      {children}
    </p>
  );
}
