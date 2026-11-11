// Converts a stored grid tree into a workspace's columns of panes. Used by the migration that
// copies houston_grids; the shapes it cannot keep exactly flatten, and each says so in `notes`.
import type { HoustonLayoutColumn } from "@houston-app/contracts/houston/layoutWorkspaces";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** The stored shape of a grid tree, as an earlier build wrote it. */
export type LegacyGridNode =
  | {
      readonly kind: "thread";
      readonly threadId: string;
      readonly id: string;
      readonly draftId?: string;
    }
  | {
      readonly kind: "split";
      readonly dir: "row" | "col";
      readonly children: ReadonlyArray<LegacyGridNode>;
      readonly weights: ReadonlyArray<number>;
    };

export interface GridConversion {
  readonly gridId: string;
  readonly environmentId: string;
  readonly tree: LegacyGridNode | null;
  /** Thread keys already placed by earlier workspaces; a thread appears in one tab only. Updated here. */
  readonly claimedThreadIds: Set<string>;
}

export interface ConvertedLayout {
  readonly columns: HoustonLayoutColumn[];
  /** What the conversion could not keep, one line each; empty when nothing was lost. */
  readonly notes: string[];
}

const claimKey = (environmentId: string, threadId: string) => `${environmentId}\u0000${threadId}`;

const preorder = (node: LegacyGridNode): string[] =>
  node.kind === "thread" ? [node.threadId] : node.children.flatMap(preorder);

/** Removes the leaves `drop` names, with the weights of children that disappear. */
const prune = (
  node: LegacyGridNode,
  drop: (threadId: string) => boolean,
): LegacyGridNode | null => {
  if (node.kind === "thread") return drop(node.threadId) ? null : node;
  const kept: Array<readonly [LegacyGridNode, number]> = [];
  node.children.forEach((child, index) => {
    const pruned = prune(child, drop);
    if (pruned !== null) kept.push([pruned, node.weights[index] ?? 1]);
  });
  if (kept.length === 0) return null;
  return {
    kind: "split",
    dir: node.dir,
    children: kept.map(([child]) => child),
    weights: kept.map(([, weight]) => weight),
  };
};

const shares = (weights: ReadonlyArray<number>): number[] => {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => weight / total);
};

const fnv1a = (text: string, seed: number): number => {
  let hash = seed;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash;
};

/** A stem short enough to keep ids within the id limit, and distinct per grid (two 32-bit FNV-1a hashes; not a security boundary). */
const stemOf = (gridId: string) =>
  [0x811c9dc5, 0x9747b28c]
    .map((seed) => fnv1a(gridId, seed).toString(16).padStart(8, "0"))
    .join("");

export const convertGridTree = (input: GridConversion): ConvertedLayout => {
  const notes: string[] = [];
  const stem = stemOf(input.gridId);
  const dropped: string[] = [];
  const tree =
    input.tree === null
      ? null
      : prune(input.tree, (threadId) => {
          const key = claimKey(input.environmentId, threadId);
          if (input.claimedThreadIds.has(key)) {
            dropped.push(threadId);
            return true;
          }
          input.claimedThreadIds.add(key);
          return false;
        });
  for (const threadId of dropped) {
    notes.push(`thread ${threadId} is already in an earlier workspace; its tab here was dropped`);
  }
  if (tree === null) return { columns: [], notes };

  const pane = (columnIndex: number, paneIndex: number, threadId: string, size: number) => {
    const tabId = `tab:${stem}:${columnIndex}:${paneIndex}`;
    return {
      id: `pane:${stem}:${columnIndex}:${paneIndex}`,
      size,
      activeTabId: tabId,
      tabs: [
        {
          id: tabId,
          content: {
            kind: "chat" as const,
            target: {
              kind: "server" as const,
              threadRef: { environmentId: input.environmentId, threadId },
            },
          },
        },
      ],
    };
  };

  // One column from a node: a leaf, a col of leaves (exact), or anything deeper (flattened).
  const column = (node: LegacyGridNode, index: number, width: number): HoustonLayoutColumn => {
    const columnId = `column:${stem}:${index}`;
    if (node.kind === "thread") {
      return { id: columnId, width, panes: [pane(index, 0, node.threadId, 1)] };
    }
    if (node.dir === "col" && node.children.every((child) => child.kind === "thread")) {
      const sizes = shares(node.weights);
      return {
        id: columnId,
        width,
        panes: node.children.map((child, paneIndex) =>
          pane(index, paneIndex, (child as { threadId: string }).threadId, sizes[paneIndex]!),
        ),
      };
    }
    const threadIds = preorder(node);
    notes.push(
      `column ${index + 1} flattened ${threadIds.length} threads from nested splits into equal panes`,
    );
    return {
      id: columnId,
      width,
      panes: threadIds.map((threadId, paneIndex) =>
        pane(index, paneIndex, threadId, 1 / threadIds.length),
      ),
    };
  };

  if (tree.kind === "split" && tree.dir === "row") {
    const widths = shares(tree.weights);
    return {
      columns: tree.children.map((child, index) => column(child, index, widths[index]!)),
      notes,
    };
  }
  return { columns: [column(tree, 0, 1)], notes };
};

/** The depth an earlier build allowed a grid tree; a deeper stored tree is refused, not walked. */
const LEGACY_TREE_DEPTH = 8;

const readNode = (value: unknown, depth: number): LegacyGridNode | null => {
  if (depth > LEGACY_TREE_DEPTH || typeof value !== "object" || value === null) return null;
  const node = value as Record<string, unknown>;
  if (node.kind === "thread") {
    return typeof node.threadId === "string" && node.threadId.length > 0
      ? {
          kind: "thread",
          threadId: node.threadId,
          id: typeof node.id === "string" ? node.id : node.threadId,
        }
      : null;
  }
  if (node.kind !== "split" || (node.dir !== "row" && node.dir !== "col")) return null;
  if (!Array.isArray(node.children) || !Array.isArray(node.weights)) return null;
  if (node.children.length === 0 || node.children.length !== node.weights.length) return null;
  if (!node.weights.every((weight) => typeof weight === "number" && weight > 0)) return null;
  const children: LegacyGridNode[] = [];
  for (const child of node.children) {
    const read = readNode(child, depth + 1);
    if (read === null) return null;
    children.push(read);
  }
  return { kind: "split", dir: node.dir, children, weights: node.weights as number[] };
};

export interface LegacyGrid {
  readonly id: string;
  readonly environmentId: string;
  readonly name: string;
  readonly tree: LegacyGridNode | null;
  readonly pinnedAt: string | null;
  readonly hidden: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Reads a stored grid record; null, with no partial result, when it is not one this build can convert. */
export const readLegacyGrid = (json: string): LegacyGrid | null => {
  const decoded = decodeJson(json);
  if (Option.isNone(decoded)) return null;
  const parsed = decoded.value;
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const text = (key: string) =>
    typeof record[key] === "string" && (record[key] as string).length > 0
      ? (record[key] as string)
      : null;
  const id = text("id");
  const environmentId = text("environmentId");
  const name = text("name");
  const createdAt = text("createdAt");
  const updatedAt = text("updatedAt");
  if (
    id === null ||
    environmentId === null ||
    name === null ||
    createdAt === null ||
    updatedAt === null
  ) {
    return null;
  }
  const tree = record.tree === null || record.tree === undefined ? null : readNode(record.tree, 1);
  if (tree === null && record.tree !== null && record.tree !== undefined) return null;
  return {
    id,
    environmentId,
    name,
    tree,
    pinnedAt: typeof record.pinnedAt === "string" ? record.pinnedAt : null,
    hidden: record.hidden === true,
    createdAt,
    updatedAt,
  };
};
