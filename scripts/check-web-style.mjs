#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_SRC = path.join(ROOT, "apps/web/src");
const BASELINE_DIR = path.join(ROOT, "scripts/web-style-baseline");
const FIXTURE_DIR = path.join(ROOT, "scripts/web-style-fixtures");

const LAYOUT_CLASS = new RegExp(
  "^(?:" +
    [
      "flex",
      "inline-flex",
      "grid",
      "inline-grid",
      "contents",
      "block",
      "inline",
      "inline-block",
      "hidden",
      "relative",
      "absolute",
      "fixed",
      "sticky",
      "static",
      "isolate",
      "truncate",
      "col-[\\w-]+",
      "row-[\\w-]+",
      "grid-cols-[\\w-]+",
      "grid-rows-[\\w-]+",
      "col-span-[\\w-]+",
      "row-span-[\\w-]+",
      "items-[\\w-]+",
      "justify-[\\w-]+",
      "justify-items-[\\w-]+",
      "self-[\\w-]+",
      "place-[\\w-]+",
      "content-[\\w-]+",
      "order-[\\w-]+",
      "flex-[\\w-]+",
      "basis-[\\w.[\\]()%-]+",
      "shrink(?:-[\\w-]+)?",
      "grow(?:-[\\w-]+)?",
      "min-[wh]-[\\w.[\\]()%-]+",
      "max-[wh]-[\\w.[\\]()%-]+",
      "min-[wh]-0",
      "size-[\\w.[\\]()%-]+",
      "[wh]-[\\w.[\\]()%-]+",
      "overflow(?:-[xy])?-[\\w-]+",
      "inset(?:-[xyse])?-[\\w.[\\]()%-]+",
      "top-[\\w.[\\]()%-]+",
      "right-[\\w.[\\]()%-]+",
      "bottom-[\\w.[\\]()%-]+",
      "left-[\\w.[\\]()%-]+",
      "start-[\\w.[\\]()%-]+",
      "end-[\\w.[\\]()%-]+",
      "z-[\\w-]+",
      "gap(?:-[xy])?-[\\w.[\\]()%-]+",
      "space-[xy]-[\\w.[\\]()%-]+",
      "[pm][xytrblse]?-[\\w.[\\]()%-]+",
      "aspect-[\\w-]+",
      "object-[\\w-]+",
    ].join("|") +
    ")$",
);

const PROPER_NOUN = new RegExp(
  "\\b(?:Houston|Claude|Codex|OpenCode|Cursor|Antigravity|Grok|ZCode|ACP|MCP|PR|UI|API|GitHub|Linux|Windows|macOS|OAuth|PTY|SSH|URL|JSON|SQLite|ID|CPU|RAM|GPU|CLI)\\b",
  "g",
);

function walk(dir, exts) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        stack.push(full);
      } else if (exts.some((ext) => entry.name.endsWith(ext))) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

function relPath(file) {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

function isTestFile(file) {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file);
}

function stripComments(src, isCss) {
  let out = "";
  let i = 0;
  let state = "code";
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (state === "code") {
      if (!isCss && two === "//") {
        state = "line";
        out += "  ";
        i += 2;
        continue;
      }
      if (two === "/*") {
        state = "block";
        out += "  ";
        i += 2;
        continue;
      }
      if (!isCss && (c === "'" || c === '"' || c === "`")) {
        state = c;
        out += c;
        i++;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    if (state === "line") {
      if (c === "\n") {
        state = "code";
        out += c;
      } else {
        out += " ";
      }
      i++;
      continue;
    }
    if (state === "block") {
      if (two === "*/") {
        state = "code";
        out += "  ";
        i += 2;
      } else {
        out += c === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }
    if (c === "\\") {
      out += src.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === state) {
      state = "code";
      out += c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function makeLineOf(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "\n") starts.push(i + 1);
  }
  return (index) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (starts[mid] <= index) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}

function stringLiterals(code) {
  const out = [];
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === "'" || c === '"') {
      const start = i;
      let text = "";
      i++;
      while (i < code.length) {
        const d = code[i];
        if (d === "\\") {
          text += code.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (d === c) {
          i++;
          break;
        }
        text += d;
        i++;
      }
      out.push({ text, index: start });
      continue;
    }
    if (c === "`") {
      const start = i;
      let text = "";
      i++;
      while (i < code.length) {
        const d = code[i];
        if (d === "\\") {
          text += code.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (d === "`") {
          i++;
          break;
        }
        text += d;
        i++;
      }
      out.push({ text, index: start, template: true });
      continue;
    }
    i++;
  }
  return out;
}

function findTagEnd(code, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < code.length; i++) {
    const c = code[i];
    if (quote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "{") {
      depth++;
      continue;
    }
    if (c === "}") {
      depth--;
      continue;
    }
    if (depth <= 0 && c === ">") return i;
  }
  return -1;
}

function jsxTags(code) {
  const literals = stringLiterals(code);
  const ranges = literals.map((lit) => [lit.index, lit.index + lit.text.length + 2]);
  const inLiteral = (index) => ranges.some(([a, b]) => index >= a && index <= b);
  const out = [];
  const re = /<([A-Za-z][\w.-]*)(?=[\s/>])/g;
  let match;
  while ((match = re.exec(code)) !== null) {
    if (inLiteral(match.index)) continue;
    const nameEnd = match.index + 1 + match[1].length;
    const end = findTagEnd(code, nameEnd);
    if (end < 0) continue;
    out.push({
      name: match[1],
      attrs: code.slice(nameEnd, end),
      start: match.index,
      end,
    });
    re.lastIndex = end + 1;
  }
  return out;
}

function hasAttr(attrs, name) {
  return new RegExp(`(?:^|[\\s{])${name}\\s*=`).test(attrs);
}

function classTokens(expr) {
  const tokens = [];
  const literals = stringLiterals(expr);
  const texts = literals.length > 0 ? literals.map((literal) => literal.text) : [expr];
  for (const text of texts) {
    for (const raw of text.split(/\s+/)) {
      if (!raw) continue;
      const token = raw.replace(/^[,;]+|[,;]+$/g, "");
      if (!token) continue;
      if (/^[a-z][a-z0-9-]*(?:-\[[^\]]+\])?(?:\/[\w.]+)?$/.test(token) || /^\[[^\]]+\]$/.test(token)) {
        tokens.push(token);
      }
    }
  }
  return tokens;
}

function stripVariants(token) {
  return token.replace(
    /^(?:(?:sm|md|lg|xl|2xl|dark|light|hover|focus|focus-visible|active|disabled|group-hover|group-focus|peer-hover|peer-focus|wco|tauri|motion-safe|motion-reduce|print|portrait|landscape|any-hover):)+/g,
    "",
  );
}

function classNameExpressions(code) {
  const out = [];
  const re = /\bclassName\s*=\s*(?:"([^"\n]*)"|'([^'\n]*)'|(\{))/g;
  let match;
  while ((match = re.exec(code)) !== null) {
    if (typeof match[3] === "string") {
      const open = re.lastIndex;
      let depth = 1;
      let i = open;
      let quote = null;
      while (i < code.length && depth > 0) {
        const c = code[i];
        if (quote) {
          if (c === "\\") {
            i += 2;
            continue;
          }
          if (c === quote) quote = null;
          i++;
          continue;
        }
        if (c === '"' || c === "'" || c === "`") {
          quote = c;
          i++;
          continue;
        }
        if (c === "{") depth++;
        else if (c === "}") depth--;
        i++;
      }
      out.push({ expr: code.slice(open, i - 1), index: match.index });
      re.lastIndex = i;
      continue;
    }
    const value = match[1] ?? match[2] ?? "";
    out.push({ expr: value, index: match.index });
  }
  return out;
}

function clsConstants(code) {
  const out = [];
  const re = /^(?:export\s+)?const\s+\w+_CLS\s*=\s*([\s\S]*?)(?=^(?:export\s+)?(?:const|function|type|interface)\b|(?![\s\S]))/gm;
  let match;
  while ((match = re.exec(code)) !== null) {
    out.push({ expr: match[1], index: match.index });
  }
  return out;
}

function lucideLocalNames(code) {
  const names = new Set();
  const re = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']lucide-react["']/g;
  let match;
  while ((match = re.exec(code)) !== null) {
    for (const part of match[1].split(",")) {
      const cleaned = part.trim().replace(/^type\s+/, "");
      if (!cleaned) continue;
      const alias = cleaned.split(/\s+as\s+/);
      names.add((alias[1] ?? alias[0]).trim());
    }
  }
  return names;
}

function lucideNamespace(code) {
  const match = /import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["']lucide-react["']/.exec(code);
  return match ? match[1] : null;
}

function countByFile(hits) {
  const counts = new Map();
  for (const hit of hits) {
    counts.set(hit.file, (counts.get(hit.file) ?? 0) + 1);
  }
  return counts;
}

function hitsForPattern(ctx, pattern, valueIndex = 0, filter = null) {
  const hits = [];
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(ctx.code)) !== null) {
    const value = match[valueIndex] ?? match[0];
    if (filter && !filter(match)) continue;
    hits.push({ file: ctx.rel, line: ctx.lineOf(match.index), value });
    if (match[0].length === 0) pattern.lastIndex++;
  }
  return hits;
}

const RULES = [
  {
    id: "native-select",
    decision: "PORT",
    exts: [".ts", ".tsx"],
    expected: "a native <select> is replaced by the Select primitive",
    scan(ctx) {
      if (/\/components\/ui\/select\.tsx$/.test(ctx.rel)) return [];
      return jsxTags(ctx.code)
        .filter((tag) => tag.name === "select")
        .map((tag) => ({ file: ctx.rel, line: ctx.lineOf(tag.start), value: "<select>" }));
    },
  },
  {
    id: "native-input",
    decision: "PORT",
    exts: [".ts", ".tsx"],
    expected: "a native checkbox/radio is replaced by Checkbox, RadioGroup or Switch",
    scan(ctx) {
      if (/\/components\/ui\//.test(ctx.rel)) return [];
      const hits = [];
      for (const tag of jsxTags(ctx.code)) {
        if (tag.name !== "input") continue;
        const match = /\btype\s*=\s*(?:"(checkbox|radio)"|'(checkbox|radio)'|\{\s*["'](checkbox|radio)["']\s*\})/.exec(tag.attrs);
        if (match) {
          hits.push({
            file: ctx.rel,
            line: ctx.lineOf(tag.start),
            value: `<input type="${match[1] ?? match[2] ?? match[3]}">`,
          });
        }
      }
      return hits;
    },
  },
  {
    id: "ellipsis",
    decision: "PORT",
    exts: [".ts", ".tsx"],
    expected: "the ellipsis character (…), never three ASCII dots",
    scan(ctx) {
      return hitsForPattern(ctx, /\.\.\.(?![A-Za-z0-9_$([{)])/g);
    },
  },
  {
    id: "title-tooltip",
    decision: "PORT",
    exts: [".ts", ".tsx"],
    expected: "<Tooltip label=…>, never a native title= hover label",
    scan(ctx) {
      const nativeTitle = new Set(["iframe", "embed", "img", "object", "abbr", "area"]);
      return jsxTags(ctx.code)
        .filter(
          (tag) =>
            /^[a-z]/.test(tag.name) &&
            !nativeTitle.has(tag.name) &&
            hasAttr(tag.attrs, "title"),
        )
        .map((tag) => ({ file: ctx.rel, line: ctx.lineOf(tag.start), value: `<${tag.name} title=…>` }));
    },
  },
  {
    id: "focus-visible",
    decision: "PORT",
    exts: [".ts", ".tsx"],
    expected: "outline-none paired with a visible focus-visible paint, and literal classes instead of interpolated arbitrary values",
    scan(ctx) {
      const hits = [];
      for (const literal of stringLiterals(ctx.code)) {
        if (!/\boutline-none\b/.test(literal.text)) continue;
        const painted =
          /focus-visible:\[?(?:shadow-|ring|border|bg-|outline(?!-none))/.test(literal.text) ||
          /focus-visible:after:/.test(literal.text) ||
          /:focus-visible\]:/.test(literal.text) ||
          /\$\{FOCUS_[A-Z0-9_]*_CLS\}/.test(literal.text);
        if (!painted) {
          hits.push({
            file: ctx.rel,
            line: ctx.lineOf(literal.index),
            value: "outline-none without focus-visible paint",
          });
        }
      }
      return hits.concat(hitsForPattern(ctx, /-\[\$\{/g));
    },
  },
  {
    id: "radius",
    decision: "ADAPT",
    exts: [".ts", ".tsx", ".css"],
    expected: "rounded-[var(--r-role)] or border-radius: var(--r-role)",
    scan(ctx) {
      const hits = hitsForPattern(
        ctx,
        /\brounded(?:-[a-z]{1,2})?-\[([0-9][0-9.]*(?:px|rem|em|pt))\]/g,
        1,
      );
      const arbitrary = hitsForPattern(
        ctx,
        /\[border-radius\s*:\s*([0-9][0-9.]*(?:px|rem|em|pt|%))[^\]]*\]/g,
        1,
      );
      if (ctx.ext === ".css" && !/\/index\.css$/.test(ctx.rel)) {
        hits.push(
          ...hitsForPattern(
            ctx,
            /border-radius\s*:[^;{}]*?(?<![\w.-])([0-9][0-9.]*(?:px|rem|em|pt|%))/g,
            1,
          ),
        );
      }
      return hits.concat(arbitrary);
    },
  },
  {
    id: "shadow",
    decision: "ADAPT",
    exts: [".ts", ".tsx"],
    expected: "a token (shadow-[var(--shadow-N)]) or a complete literal recipe class, never a hand-typed shadow",
    scan(ctx) {
      const hits = [];
      const re = /shadow-\[([^\]]*)\]/g;
      let match;
      while ((match = re.exec(ctx.code)) !== null) {
        let rest = match[1];
        rest = rest.replace(/var\(--[\w-]+(?:,(?:[^()]|\([^()]*\))*)?\)/g, "");
        rest = rest.replace(/(?:--theme|theme)\([^()]*\)/g, "");
        rest = rest.replace(/\$\{[^}]*\}/g, "");
        rest = rest.replace(/[,_\s]/g, "");
        if (rest.length > 0) {
          hits.push({ file: ctx.rel, line: ctx.lineOf(match.index), value: `shadow-[${match[1]}]` });
        }
      }
      const inline = /\bboxShadow\s*:\s*["'`]([^"'`]*)["'`]/g;
      while ((match = inline.exec(ctx.code)) !== null) {
        let rest = match[1]
          .replace(/var\(--[\w-]+(?:,(?:[^()]|\([^()]*\))*)?\)/g, "")
          .replace(/(?:--theme|theme)\([^()]*\)/g, "")
          .replace(/\$\{[^}]*\}/g, "")
          .replace(/[,_\s]/g, "");
        if (rest.length > 0) {
          hits.push({ file: ctx.rel, line: ctx.lineOf(match.index), value: `boxShadow: ${match[1]}` });
        }
      }
      return hits;
    },
  },
  {
    id: "type-scale",
    decision: "ADAPT",
    exts: [".ts", ".tsx", ".css"],
    expected: "a --text-* / text-<token> step instead of a literal font size (absolute floor 11px)",
    scan(ctx) {
      const hits = hitsForPattern(ctx, /text-\[([0-9]+(?:\.[0-9]+)?(?:px|rem|em|pt))\]/g, 1);
      hits.push(
        ...hitsForPattern(ctx, /\[font-size\s*:\s*([0-9]+(?:\.[0-9]+)?(?:px|rem|em|pt))\]/g, 1),
      );
      if (ctx.ext === ".css" && !/\/index\.css$/.test(ctx.rel)) {
        hits.push(
          ...hitsForPattern(
            ctx,
            /(?:^|[;{]\s*|\n\s*)font-size\s*:\s*([0-9]+(?:\.[0-9]+)?(?:px|rem|em|pt))\b/g,
            1,
          ),
        );
      }
      return hits;
    },
  },
  {
    id: "spacing",
    decision: "ADAPT",
    exts: [".ts", ".tsx", ".css"],
    expected: "the Tailwind spacing scale or a --space-* token, not a hand-typed length",
    scan(ctx) {
      const hits = hitsForPattern(
        ctx,
        /\[(?:padding(?:-[a-z]+)?|margin(?:-[a-z]+)?|gap|row-gap|column-gap)\s*:\s*[^\]]*?((?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)(?:px|rem|em|pt))[^\]]*\]/g,
        1,
      );
      hits.push(
        ...hitsForPattern(
          ctx,
          /(?:^|[\s"'`])(-?)(?:p[xytrblse]?|m[xytrblse]?|gap(?:-[xy])?|space-[xy])-\[([0-9][0-9.]*(?:px|rem|em|pt))\]/g,
          2,
          (match) => match[1] !== "-",
        ),
      );
      if (ctx.ext === ".css" && !/\/index\.css$/.test(ctx.rel)) {
        hits.push(
          ...hitsForPattern(
            ctx,
            /(?:^|[;{]\s*|\n\s*)(?:padding(?:-[a-z]+)?|margin(?:-[a-z]+)?|gap|row-gap|column-gap)\s*:\s*[^;{}]*?((?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)(?:px|rem|em|pt))\b/g,
            1,
          ),
        );
      }
      return hits;
    },
  },
  {
    id: "control-metrics",
    decision: "ADAPT",
    exts: [".ts", ".tsx"],
    expected: "h-(--h-ctl) / h-(--h-row) / h-(--h-pane-head) / h-(--h-pill), never a hand-typed control height",
    scan(ctx) {
      const hits = [];
      for (const tag of jsxTags(ctx.code)) {
        if (!["button", "input", "select", "textarea", "a"].includes(tag.name)) continue;
        const re = /(?:(?:min-|max-)?h|size)-\[([0-9.]+(?:px|rem))\]/g;
        let match;
        while ((match = re.exec(tag.attrs)) !== null) {
          hits.push({
            file: ctx.rel,
            line: ctx.lineOf(tag.start),
            value: `${tag.name} ${match[0]}`,
          });
        }
      }
      if (/Chrome\.(?:ts|tsx)$/.test(ctx.rel)) {
        hits.push(...hitsForPattern(ctx, /(?:(?:min-|max-)?h|size)-\[([0-9.]+(?:px|rem))\]/g, 1));
      }
      return hits;
    },
  },
  {
    id: "icon-metrics",
    decision: "ADAPT",
    exts: [".tsx"],
    expected: "icon size and stroke come from the size-* utility or a shared role, never a numeric prop",
    scan(ctx) {
      const names = lucideLocalNames(ctx.code);
      const namespace = lucideNamespace(ctx.code);
      if (names.size === 0 && !namespace) return [];
      const hits = [];
      for (const tag of jsxTags(ctx.code)) {
        const local = tag.name.includes(".") ? tag.name.split(".").pop() : tag.name;
        const isIcon =
          names.has(tag.name) || names.has(local) || (namespace && tag.name.startsWith(`${namespace}.`));
        if (!isIcon) continue;
        const match = /\b(?:size|strokeWidth)\s*=\s*\{\s*([0-9]+(?:\.[0-9]+)?)\s*\}/.exec(tag.attrs);
        if (match) {
          hits.push({
            file: ctx.rel,
            line: ctx.lineOf(tag.start),
            value: `<${tag.name}> ${match[0]}`,
          });
        }
      }
      return hits;
    },
  },
  {
    id: "icon-imports",
    decision: "ADAPT",
    exts: [".ts", ".tsx"],
    expected: "named icon imports; only lib/lucideIconByName.ts may own a namespace or dynamic import",
    scan(ctx) {
      if (/\/lib\/lucideIconByName\.ts$/.test(ctx.rel)) return [];
      const hits = [];
      const namespace = /import\s+\*\s+as\s+[A-Za-z_$][\w$]*\s+from\s+["']lucide-react["']/.exec(ctx.code);
      if (namespace) {
        hits.push({ file: ctx.rel, line: ctx.lineOf(namespace.index), value: "import * as … from lucide-react" });
      }
      const fallback = /import\s+[A-Za-z_$][\w$]*\s+from\s+["']lucide-react["']/.exec(ctx.code);
      if (fallback) {
        hits.push({ file: ctx.rel, line: ctx.lineOf(fallback.index), value: "default import from lucide-react" });
      }
      const dynamic = /from\s+["']lucide-react\/dynamic["']/.exec(ctx.code);
      if (dynamic) {
        hits.push({ file: ctx.rel, line: ctx.lineOf(dynamic.index), value: "lucide-react/dynamic import" });
      }
      return hits;
    },
  },
  {
    id: "copy",
    decision: "ADAPT",
    exts: [".tsx"],
    expected: "sentence case, counts without parentheses, and the approved status vocabulary",
    scan(ctx) {
      const hits = [];
      const re = /\b(title|label|placeholder|aria-label)\s*=\s*["']([^"']*)["']/g;
      let match;
      while ((match = re.exec(ctx.code)) !== null) {
        const [prop, value] = [match[1], match[2]];
        const plain = value.replace(PROPER_NOUN, "");
        if (/\(\d+\)|·\s*\d+/.test(value)) {
          hits.push({ file: ctx.rel, line: ctx.lineOf(match.index), value: `${prop}="${value}" (parenthesized count)` });
        }
        if (prop !== "placeholder" && /\b[A-Z][a-z]+(?:\s+\b[A-Z][a-z]+){1,}\b/.test(plain)) {
          hits.push({ file: ctx.rel, line: ctx.lineOf(match.index), value: `${prop}="${value}" (title case)` });
        }
        if (/^\s*(?:Ok|Not there)\s*$/.test(value)) {
          hits.push({ file: ctx.rel, line: ctx.lineOf(match.index), value: `${prop}="${value}" (banned status)` });
        }
      }
      return hits;
    },
  },
  {
    id: "ui-boundary",
    decision: "ADAPT",
    exts: [".ts", ".tsx"],
    expected: "layout utilities only outside components/ui; wrap the visual recipe in a primitive",
    scan(ctx) {
      if (/\/components\/ui\//.test(ctx.rel)) return [];
      const hits = [];
      const report = (expr, index) => {
        for (const token of classTokens(expr)) {
          const bare = stripVariants(token);
          if (LAYOUT_CLASS.test(bare) || /^gap-\[var\(--space-[\w.-]+\)\]$/.test(bare)) continue;
          hits.push({ file: ctx.rel, line: ctx.lineOf(index), value: token });
        }
      };
      for (const constant of clsConstants(ctx.code)) report(constant.expr, constant.index);
      for (const expression of classNameExpressions(ctx.code)) report(expression.expr, expression.index);
      return hits;
    },
  },
  {
    id: "page-width",
    decision: "ADAPT",
    exts: [".tsx"],
    expected: "WorkspacePageContainer or max-w-[var(--page-w)], never a per-page pixel column",
    scan(ctx) {
      const isPage = ctx.rel.includes("/routes/") || /(?:^|\/)\w*Page\.tsx$/.test(ctx.rel);
      if (!isPage) return [];
      if (/WorkspacePageContainer\.tsx$/.test(ctx.rel)) return [];
      return hitsForPattern(ctx, /max-w-\[([0-9.]+(?:px|rem|em))\]/g, 1);
    },
  },
  {
    id: "label-tracking",
    decision: "ADAPT",
    exts: [".ts", ".tsx"],
    expected: "tracking-wide/wider/widest only on uppercase label text",
    scan(ctx) {
      const hits = [];
      const re = /\btracking-(?:wide|wider|widest)\b/g;
      let match;
      while ((match = re.exec(ctx.code)) !== null) {
        const line = ctx.lineOf(match.index);
        const start = Math.max(0, line - 5);
        const end = Math.min(ctx.lines.length, line + 4);
        const window = ctx.lines.slice(start, end).join("\n");
        if (!/uppercase|text-transform\s*:\s*uppercase/.test(window)) {
          hits.push({ file: ctx.rel, line, value: match[0] });
        }
      }
      return hits;
    },
  },
  {
    id: "empty-state-action",
    decision: "ADAPT",
    exts: [".tsx"],
    expected: "an empty state whose copy names an action must offer the control, or state a fact",
    scan(ctx) {
      const hits = [];
      const re = /<Empty(?:\s[^>]*)?>([\s\S]*?)<\/Empty>/g;
      let match;
      while ((match = re.exec(ctx.code)) !== null) {
        const block = match[1];
        const text = block
          .replace(/<[^>]*>/g, " ")
          .replace(/\{[^}]*\}/g, " ")
          .replace(/\s+/g, " ");
        const imperative = /\b(?:add|start|create|pick|choose|click|open|connect|install|enable|select|run)\s+[a-z]/i;
        const negated = /\b(?:cannot|can't|won't|will not|unable to)\b/i;
        const control = /<(?:Button|Link|button|a)\b|\bonClick=/.test(block);
        if (imperative.test(text) && !negated.test(text) && !control) {
          hits.push({
            file: ctx.rel,
            line: ctx.lineOf(match.index),
            value: "empty state names an action it does not offer",
          });
        }
      }
      return hits;
    },
  },
];

const RULE_BY_ID = new Map(RULES.map((rule) => [rule.id, rule]));
let fileCache = null;

function loadWebFiles() {
  if (fileCache) return fileCache;
  const all = walk(WEB_SRC, [".ts", ".tsx", ".css"]).filter((file) => !isTestFile(file));
  fileCache = all.map((file) => {
    const src = fs.readFileSync(file, "utf8");
    const ext = path.extname(file);
    return {
      file,
      rel: relPath(file),
      src,
      code: stripComments(src, ext === ".css"),
      lines: src.split("\n"),
      ext,
    };
  });
  return fileCache;
}

function scanRule(rule, entries) {
  const hits = [];
  for (const entry of entries) {
    if (!rule.exts.includes(entry.ext) || isTestFile(entry.rel)) continue;
    const ctx = { ...entry, lineOf: makeLineOf(entry.src) };
    hits.push(...rule.scan(ctx));
  }
  return hits;
}

function scanFixture(rule, dir) {
  const files = walk(dir, rule.exts);
  const entries = files.map((file) => {
    const src = fs.readFileSync(file, "utf8");
    const ext = path.extname(file);
    return {
      file,
      rel: relPath(file),
      src,
      code: stripComments(src, ext === ".css"),
      lines: src.split("\n"),
      ext,
    };
  });
  return scanRule(rule, entries);
}

function readBaseline(rule) {
  const file = path.join(BASELINE_DIR, `${rule.id}.baseline`);
  if (!fs.existsSync(file)) return null;
  const counts = new Map();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const match = /^(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    counts.set(match[2], Number(match[1]));
  }
  return counts;
}

function writeBaseline(rule, counts) {
  fs.mkdirSync(BASELINE_DIR, { recursive: true });
  const file = path.join(BASELINE_DIR, `${rule.id}.baseline`);
  const lines = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pathName, count]) => `${count} ${pathName}`);
  fs.writeFileSync(file, `${lines.join("\n")}${lines.length ? "\n" : ""}`);
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  console.log(`wrote ${relPath(file)} (${total} violation(s) in ${counts.size} file(s))`);
}

function reportFailure(rule, hits) {
  console.error(`FAIL: ${rule.id}: ${rule.expected}`);
  for (const hit of hits) {
    console.error(`  ${hit.file}:${hit.line} '${hit.value}'`);
  }
}

function checkRule(rule) {
  const baseline = readBaseline(rule);
  if (!baseline) {
    console.error(`FAIL: ${rule.id}: ${relPath(path.join(BASELINE_DIR, `${rule.id}.baseline`))} is missing; run scripts/check-web-style.sh --update.`);
    return false;
  }
  const hits = scanRule(rule, loadWebFiles());
  const counts = countByFile(hits);
  let ok = true;
  for (const [file, count] of counts) {
    const pin = baseline.get(file);
    if (pin === undefined) {
      ok = false;
      console.error(`FAIL: ${rule.id}: ${file} has ${count} new violation(s) and no baseline entry.`);
      reportFailure(rule, hits.filter((hit) => hit.file === file));
    } else if (count > pin) {
      ok = false;
      console.error(`FAIL: ${rule.id}: ${file} has ${count} violation(s), baseline ${pin}; the ratchet only falls.`);
      reportFailure(rule, hits.filter((hit) => hit.file === file));
    } else if (count < pin) {
      ok = false;
      console.error(`FAIL: ${rule.id}: ${file} has ${count} violation(s), baseline ${pin} (stale); tighten with scripts/check-web-style.sh --update.`);
    }
  }
  for (const [file, pin] of baseline) {
    if (!counts.has(file)) {
      ok = false;
      console.error(`FAIL: ${rule.id}: ${file} is in the baseline (${pin}) but has no violation now; run scripts/check-web-style.sh --update.`);
    }
  }
  if (ok) {
    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
    console.log(`ok: ${rule.id} (${total} baselined violation(s) in ${counts.size} file(s), none added)`);
  }
  return ok;
}

function updateRule(rule) {
  writeBaseline(rule, countByFile(scanRule(rule, loadWebFiles())));
}

function selfTest() {
  let ok = true;
  for (const rule of RULES) {
    const badDir = path.join(FIXTURE_DIR, rule.id, "bad");
    const goodDir = path.join(FIXTURE_DIR, rule.id, "good");
    if (!fs.existsSync(badDir) || !fs.existsSync(goodDir)) {
      console.error(`FAIL: ${rule.id}: fixtures missing at ${relPath(badDir)} and ${relPath(goodDir)}`);
      ok = false;
      continue;
    }
    const bad = scanFixture(rule, badDir);
    const good = scanFixture(rule, goodDir);
    if (bad.length === 0) {
      console.error(`FAIL: ${rule.id}: the bad fixture did not trip the guard (${relPath(badDir)})`);
      ok = false;
    } else if (good.length > 0) {
      console.error(`FAIL: ${rule.id}: the good fixture tripped the guard:`);
      reportFailure(rule, good);
      ok = false;
    } else {
      console.log(`ok: ${rule.id} self-test (bad fixture: ${bad.length} hit(s), good fixture: 0)`);
    }
  }
  return ok;
}

const args = process.argv.slice(2);
const update = args.includes("--update");
const list = args.includes("--list");
const all = args.includes("--all");
const test = args.includes("--self-test");
const print = args.includes("--print");
const named = args.filter((arg) => !arg.startsWith("-"));

if (list) {
  for (const rule of RULES) console.log(`${rule.decision.padEnd(5)} ${rule.id}`);
  process.exit(0);
}

if (test) {
  process.exit(selfTest() ? 0 : 1);
}

if (print) {
  const selected = named.length ? named.map((id) => RULE_BY_ID.get(id)) : RULES;
  for (const rule of selected) {
    if (!rule) {
      console.error(`FAIL: unknown rule '${named.find((id) => !RULE_BY_ID.has(id))}'`);
      process.exit(1);
    }
    for (const hit of scanRule(rule, loadWebFiles())) {
      console.log(`${hit.file}:${hit.line}\t${hit.value}`);
    }
  }
  process.exit(0);
}

if (update) {
  const selected = named.length ? named.map((id) => RULE_BY_ID.get(id)) : RULES;
  for (const rule of selected) {
    if (!rule) {
      console.error(`FAIL: unknown rule '${named.find((id) => !RULE_BY_ID.has(id))}'`);
      process.exit(1);
    }
    updateRule(rule);
  }
  process.exit(0);
}

const selected = named.length ? named.map((id) => RULE_BY_ID.get(id)) : RULES;
for (const rule of selected) {
  if (!rule) {
    console.error(`FAIL: unknown rule '${named.find((id) => !RULE_BY_ID.has(id))}'`);
    process.exit(1);
  }
}
let ok = true;
for (const rule of selected) {
  if (!checkRule(rule)) ok = false;
}
if (!ok && !all && selected.length > 1) {
  console.error("Baselines live in scripts/web-style-baseline/; never edit apps/web to satisfy a new guard in this PR.");
}
process.exit(ok ? 0 : 1);
