import type {
  DesktopTrayPayload,
  DesktopTraySession,
  DesktopTrayStatus,
} from "@houston-app/contracts";

export type TrayItem =
  | { readonly type: "header"; readonly label: string }
  | { readonly type: "open" }
  | { readonly type: "newThread" }
  | { readonly type: "separator" }
  | { readonly type: "session"; readonly id: string; readonly label: string }
  | { readonly type: "overflow"; readonly label: string }
  | { readonly type: "group"; readonly label: string }
  | { readonly type: "submenu"; readonly label: string; readonly items: readonly TrayItem[] }
  | { readonly type: "quit" };

export type TrayIconState = "idle" | "active" | "attention";

// Caps keep the OS tray menu short and glanceable; the rest collapse into
// an overflow row rather than growing the menu unbounded.
export const ATTENTION_ROW_CAP = 4;
export const GROUP_ROW_CAP = 8;

const STATUS_GLYPHS: Readonly<Record<DesktopTrayStatus, string>> = {
  running: "●",
  idle: "○",
  needsInput: "◐",
  unknown: "?",
  done: "✓",
  error: "✕",
};

const STATUS_RANK: Readonly<Record<DesktopTrayStatus, number>> = {
  needsInput: 0,
  running: 1,
  unknown: 2,
  idle: 3,
  done: 4,
  error: 4,
};

const AGENT_LABELS: Readonly<Record<string, string>> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
  shell: "Shell",
  custom: "Custom",
  opencode: "OpenCode",
  cursor: "Cursor",
  grok: "Grok",
  zcode: "ZCode",
  droid: "Droid",
  copilot: "Copilot",
  aider: "Aider",
  ssh: "SSH",
};

export function statusGlyph(status: DesktopTrayStatus): string {
  return STATUS_GLYPHS[status];
}

export function agentLabel(kind: string): string {
  const known = AGENT_LABELS[kind];
  if (known !== undefined) return known;
  const [first] = kind;
  return first === undefined ? "Agent" : first.toUpperCase() + kind.slice(1);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function isLive(session: DesktopTraySession): boolean {
  return session.status !== "done" && session.status !== "error";
}

function runningCount(payload: DesktopTrayPayload): number {
  return payload.sessions.filter((session) => isLive(session) && session.status === "running")
    .length;
}

function attentionCount(payload: DesktopTrayPayload): number {
  return payload.sessions.filter((session) => isLive(session) && session.needsInput).length;
}

function unknownCount(payload: DesktopTrayPayload): number {
  return payload.sessions.filter((session) => isLive(session) && session.status === "unknown")
    .length;
}

export function headerText(payload: DesktopTrayPayload): string {
  if (payload.connection === "failed") {
    return "Houston · daemon not running";
  }
  if (payload.connection !== "ready") {
    return "Houston · disconnected";
  }
  const liveCount = payload.sessions.filter(isLive).length;
  if (liveCount === 0) {
    return "Houston · idle";
  }
  const parts: string[] = [];
  const running = runningCount(payload);
  if (running > 0) {
    parts.push(`${plural(running, "agent")} running`);
  }
  const attention = attentionCount(payload);
  if (attention > 0) {
    parts.push(attention === 1 ? "1 needs input" : `${attention} need input`);
  }
  const unknown = unknownCount(payload);
  if (unknown > 0) {
    parts.push(`${unknown} status unknown`);
  }
  if (parts.length === 0) {
    parts.push(`${plural(liveCount, "agent")} idle`);
  }
  return `Houston · ${parts.join(" · ")}`;
}

export function iconState(payload: DesktopTrayPayload): TrayIconState {
  if (attentionCount(payload) > 0) {
    return "attention";
  }
  if (payload.connection === "ready" && runningCount(payload) > 0) {
    return "active";
  }
  return "idle";
}

export function sessionLabel(session: DesktopTraySession): string {
  return `${statusGlyph(session.status)} ${agentLabel(session.agent)} · ${session.title}`;
}

function agentsSubmenu(sessions: readonly DesktopTraySession[]): readonly TrayItem[] {
  const order: string[] = [];
  const groups = new Map<string, DesktopTraySession[]>();
  for (const session of sessions) {
    let group = groups.get(session.workspace);
    if (group === undefined) {
      group = [];
      groups.set(session.workspace, group);
      order.push(session.workspace);
    }
    group.push(session);
  }

  const items: TrayItem[] = [];
  order.forEach((workspace, index) => {
    if (index > 0) {
      items.push({ type: "separator" });
    }
    items.push({ type: "group", label: workspace });
    const panes = [...(groups.get(workspace) ?? [])].sort(
      (left, right) => STATUS_RANK[left.status] - STATUS_RANK[right.status],
    );
    for (const session of panes.slice(0, GROUP_ROW_CAP)) {
      items.push({ type: "session", id: session.id, label: sessionLabel(session) });
    }
    if (panes.length > GROUP_ROW_CAP) {
      items.push({ type: "overflow", label: `+${panes.length - GROUP_ROW_CAP} more in Houston` });
    }
  });
  return items;
}

export function menuModel(payload: DesktopTrayPayload): readonly TrayItem[] {
  const items: TrayItem[] = [
    { type: "header", label: headerText(payload) },
    { type: "open" },
    { type: "newThread" },
    { type: "separator" },
  ];

  const live = payload.sessions.filter(isLive);
  const attention = live.filter((session) => session.needsInput);
  for (const session of attention.slice(0, ATTENTION_ROW_CAP)) {
    items.push({ type: "session", id: session.id, label: sessionLabel(session) });
  }
  if (attention.length > ATTENTION_ROW_CAP) {
    items.push({
      type: "overflow",
      label: `+${attention.length - ATTENTION_ROW_CAP} more waiting, in Agents`,
    });
  }

  if (live.length > 0) {
    items.push({ type: "submenu", label: `Agents (${live.length})`, items: agentsSubmenu(live) });
    items.push({ type: "separator" });
  }

  items.push({ type: "quit" });
  return items;
}

export function trayIconFile(state: TrayIconState, size: number): string {
  return `tray/${state}-${size}.png`;
}

export const TRAY_ICON_CUTS: readonly number[] = [16, 20, 22, 24, 32, 40, 44, 48];

export function baseIconSize(platform: NodeJS.Platform, desktop: string | undefined): number {
  if (platform === "win32") return 16;
  if (desktop?.split(":").some((name) => name.toUpperCase() === "GNOME")) return 16;
  return 22;
}

export function iconSizeFor(base: number, scaleFactor: number | undefined): number {
  if (scaleFactor === undefined || !Number.isFinite(scaleFactor)) return base;
  const wanted = Math.round(base * scaleFactor);
  let closest = TRAY_ICON_CUTS[0] ?? base;
  for (const cut of TRAY_ICON_CUTS) {
    if (Math.abs(cut - wanted) < Math.abs(closest - wanted)) closest = cut;
  }
  return closest;
}

export function shouldHideOnClose(input: {
  readonly available: boolean;
  readonly keepInTray: boolean;
  readonly quitting: boolean;
}): boolean {
  return !input.quitting && input.available && input.keepInTray;
}
