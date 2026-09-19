#!/usr/bin/env python3
"""Remove every comment in the tree that is not a directive to a tool.

Runs once, as a one-off migration. The tree had grown ~40k lines of comment
prose; this strips all of it so the essential ones can be re-added by hand
against a clean slate. Every removed comment is written to `.comment-corpus.tsv`
first, so the re-add pass has the text to mine.

Parsers, not regexes: a `//` inside a string literal is not a comment, and only
a grammar knows the difference. Every language whose grammar exists goes through
tree-sitter; PowerShell and NSIS use a line rule that tracks quoting itself.

Usage:
  comment-reset.py --corpus       write .comment-corpus.tsv, change nothing
  comment-reset.py --strip        write the corpus and rewrite the files
  comment-reset.py --self-test    prove strings survive, against tests/fixtures
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CORPUS = REPO / ".comment-corpus.tsv"

# Directives, not prose: the compiler, the linter or the test runner reads
# these, so deleting one changes behaviour. Matched against the comment's own
# text, after the delimiter.
KEEP = re.compile(
    r"""^\s*(?:
          \#!                      # shebang
        | //!?\s*/?\s*<reference   # /// <reference
        | @vitest-environment
        | eslint-disable
        | eslint-enable
        | @ts-expect-error
        | @ts-ignore
        | @ts-nocheck
        | prettier-ignore
        | biome-ignore
        | oxlint-disable
        | c8\s+ignore
        | v8\s+ignore
        | istanbul\s+ignore
        | SAFETY:
        | \#\s*Safety\b        # rustdoc section clippy requires on an unsafe fn
        | @vite-ignore
        | \#\s*nosec
        | type:\s*ignore
    )""",
    re.X,
)

# Directory prefixes the sweep never enters. Vendored code, generated code,
# fixtures whose comments are the fixture, and anything a patch applies to
# (an edit inside it moves the patch's hunks).
EXCLUDE_DIRS = (
    ".git/",
    ".research/",
    "node_modules/",
    "target/",
    "dist/",
    "ui/dist/",
    "ui/src/renderer/src/ghostty/vendor/",
    "ui/src/renderer/src/houston/generated/",
    "core/houston-core/ghostty-vt/",
    "core/houston-core/ghostty-patches/",
    "scripts/mutations/fixtures/",
)
EXCLUDE_PARTS = ("fixtures",)

# suffix -> tree-sitter language name
TS_LANGS = {
    ".rs": "rust",
    ".ts": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".mjs": "typescript",
    ".js": "typescript",
    ".tsx": "tsx",
    ".jsx": "tsx",
    ".css": "css",
    ".sh": "bash",
    ".bash": "bash",
    ".toml": "toml",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".html": "html",
}

# Languages with no grammar here, handled by a quoting-aware line rule.
LINE_LANGS = {".ps1": "#", ".psm1": "#", ".nsi": ";", ".nsh": ";"}


def tracked_files() -> list[Path]:
    out = subprocess.run(
        ["git", "ls-files", "-z"], cwd=REPO, capture_output=True, check=True
    ).stdout
    paths = []
    for raw in out.split(b"\0"):
        if not raw:
            continue
        rel = raw.decode()
        if any(rel.startswith(d) for d in EXCLUDE_DIRS):
            continue
        if any(part in EXCLUDE_PARTS for part in Path(rel).parts):
            continue
        suffix = Path(rel).suffix
        if suffix in TS_LANGS or suffix in LINE_LANGS:
            paths.append(REPO / rel)
    return sorted(paths)


def comment_nodes(tree, source: bytes):
    """Every comment node in the tree, outermost first, in source order."""
    found = []
    stack = [tree.root_node]
    while stack:
        node = stack.pop()
        if "comment" in node.type:
            found.append(node)
            continue  # a comment has no comment children worth visiting
        stack.extend(reversed(node.children))
    found.sort(key=lambda n: n.start_byte)
    return found


def is_kept(text: str) -> bool:
    body = re.sub(r"^\s*(?://+!?|/\*+|\{/\*+|<!--|#+|;+)", "", text, count=1)
    return bool(KEEP.match(body)) or bool(KEEP.match(text))


def embedded_nodes(tree, source: bytes):
    """Comment nodes inside an HTML <style>/<script> body.

    The HTML grammar hands those bodies back as one opaque `raw_text`, so a
    CSS or TypeScript comment in a page is invisible to an HTML-only pass.
    """
    from tree_sitter_language_pack import get_parser

    found = []
    stack = [tree.root_node]
    while stack:
        node = stack.pop()
        if node.type == "raw_text" and node.parent is not None:
            lang = {"style_element": "css", "script_element": "typescript"}.get(
                node.parent.type
            )
            if lang:
                inner = get_parser(lang).parse(source[node.start_byte : node.end_byte])
                for sub in comment_nodes(inner, source):
                    found.append((node.start_byte + sub.start_byte,
                                  node.start_byte + sub.end_byte,
                                  sub.start_point[0] + node.start_point[0] + 1))
                continue
        stack.extend(node.children)
    return found


def strip_with_grammar(path: Path, lang: str, source: bytes):
    """Returns (new_source, removed) where removed is [(line, text), ...]."""
    from tree_sitter_language_pack import get_parser

    tree = get_parser(lang).parse(source)
    spans = [
        (n.start_byte, n.end_byte, n.start_point[0] + 1)
        for n in comment_nodes(tree, source)
    ]
    if lang == "html":
        spans += embedded_nodes(tree, source)
    spans.sort()

    # A `# Safety` heading is only half a directive: clippy wants the section,
    # and a heading with its body stripped is worse than none. The keep spreads
    # down the contiguous `///` run beneath it.
    sticky = False
    keep = set()
    for start_byte, end_byte, lineno in spans:
        text = source[start_byte:end_byte].decode("utf-8", "replace")
        if is_kept(text):
            keep.add(start_byte)
            sticky = re.match(r"^\s*///\s*#\s*Safety\b", text) is not None
        elif sticky and text.lstrip().startswith("///"):
            keep.add(start_byte)
        else:
            sticky = False

    cuts = []
    removed = []
    for start_byte, end_byte, lineno in spans:
        text = source[start_byte:end_byte].decode("utf-8", "replace")
        if start_byte in keep:
            continue
        removed.append((lineno, text))
        start, end = start_byte, end_byte
        # A comment that is the only thing on its line takes the whole line,
        # its indentation and its newline with it; a trailing comment leaves
        # the code and takes the whitespace before it.
        line_start = source.rfind(b"\n", 0, start) + 1
        if source[line_start:start].strip() == b"":
            start = line_start
            # Some grammars (Rust's `line_comment`) already put the newline
            # inside the node; searching for the next one from there would
            # swallow the line of code that follows.
            if not source[start:end].endswith(b"\n"):
                nl = source.find(b"\n", end)
                tail = source[end:] if nl == -1 else source[end:nl]
                if tail.strip() == b"":
                    end = len(source) if nl == -1 else nl + 1
        else:
            while start > line_start and source[start - 1 : start] in (b" ", b"\t"):
                start -= 1
        cuts.append((start, end))

    if not cuts:
        return source, removed

    out = bytearray()
    pos = 0
    for start, end in cuts:
        if start < pos:  # a nested or overlapping node already covered
            continue
        out += source[pos:start]
        pos = end
    out += source[pos:]

    # A stripped block leaves a hole; collapse a run of blank lines to one.
    text = out.decode("utf-8", "replace")
    text = re.sub(r"\n[ \t]*\n(?:[ \t]*\n)+", "\n\n", text)
    # And no blank line may open a block or a file.
    text = re.sub(r"\{\n(?:[ \t]*\n)+", "{\n", text)
    text = text.lstrip("\n")
    if text and not text.endswith("\n"):
        text += "\n"
    return text.encode(), removed


def strip_by_line(path: Path, marker: str, source: bytes):
    """PowerShell and NSIS: a line rule that tracks quoting itself."""
    removed = []
    out_lines = []
    for lineno, line in enumerate(source.decode("utf-8", "replace").splitlines(True), 1):
        idx = None
        quote = None
        i = 0
        while i < len(line):
            ch = line[i]
            if quote:
                if ch == "`" and quote == '"':
                    i += 2
                    continue
                if ch == quote:
                    quote = None
            elif ch in "\"'":
                quote = ch
            elif line.startswith(marker, i):
                idx = i
                break
            i += 1
        if idx is None:
            out_lines.append(line)
            continue
        text = line[idx:].rstrip("\n")
        if is_kept(text) or lineno == 1 and line.startswith("#!"):
            out_lines.append(line)
            continue
        removed.append((lineno, text))
        head = line[:idx]
        if head.strip() == "":
            continue  # whole-line comment: drop the line
        out_lines.append(head.rstrip() + "\n")
    text = "".join(out_lines)
    text = re.sub(r"\n[ \t]*\n(?:[ \t]*\n)+", "\n\n", text)
    return text.encode(), removed


def sweep(write: bool) -> int:
    rows = []
    changed = 0
    for path in tracked_files():
        source = path.read_bytes()
        suffix = path.suffix
        try:
            if suffix in TS_LANGS:
                new, removed = strip_with_grammar(path, TS_LANGS[suffix], source)
            else:
                new, removed = strip_by_line(path, LINE_LANGS[suffix], source)
        except Exception as exc:  # a grammar that cannot parse a file is a finding
            print(f"SKIPPED {path.relative_to(REPO)}: {exc}", file=sys.stderr)
            continue
        rel = path.relative_to(REPO).as_posix()
        for lineno, text in removed:
            rows.append((rel, lineno, text))
        if write and new != source:
            path.write_bytes(new)
            changed += 1

    with CORPUS.open("w", encoding="utf-8") as fh:
        for rel, lineno, text in rows:
            flat = text.replace("\t", "    ").replace("\n", "\\n")
            fh.write(f"{rel}\t{lineno}\t{flat}\n")

    print(f"{len(rows)} comments recorded in {CORPUS.name}")
    if write:
        print(f"{changed} files rewritten")
    return 0


FIXTURE_TS = '''\
const url = "https://example.com/a//b"
const hash = '#not-a-comment'
const re = /https:\\/\\/x/
// this one goes
const kept = 1 // and this one
/** and this block */
export { url, hash, re, kept }
'''

# Rust is the case that matters most: its grammar puts the trailing newline
# INSIDE the comment node, so a naive whole-line cut eats the line after it.
FIXTURE_RS = '''\
//! module prose
use std::fmt;

/// item prose
/// second line
pub struct Kept {
    /// field prose
    pub url: &'static str,
    /// another
    pub hash: &'static str,
}

pub const A: Kept = Kept {
    url: "https://example.com/a//b",
    hash: "#not-a-comment",
};

pub fn f() -> u8 {
    // SAFETY: kept, it is a directive
    3 // trailing goes
}
'''


def self_test() -> int:
    """Prove strings survive, and that no line of code is taken with a comment."""
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        f = Path(tmp) / "strings.ts"
        f.write_text(FIXTURE_TS)
        text = strip_with_grammar(f, "typescript", f.read_bytes())[0].decode()
        for survivor in ("https://example.com/a//b", "#not-a-comment", "https:\\/\\/x"):
            if survivor not in text:
                print(f"FAIL: string content lost: {survivor}", file=sys.stderr)
                return 1
        for gone in ("this one goes", "and this one", "and this block"):
            if gone in text:
                print(f"FAIL: comment survived: {gone}", file=sys.stderr)
                return 1

        g = Path(tmp) / "shape.rs"
        g.write_text(FIXTURE_RS)
        text = strip_with_grammar(g, "rust", g.read_bytes())[0].decode()
        # Every line of code, in order, and nothing of the prose.
        for survivor in (
            "use std::fmt;",
            "pub struct Kept {",
            "pub url: &'static str,",
            "pub hash: &'static str,",
            "pub const A: Kept = Kept {",
            'url: "https://example.com/a//b",',
            'hash: "#not-a-comment",',
            "pub fn f() -> u8 {",
            "// SAFETY: kept, it is a directive",
            "    3\n",
        ):
            if survivor not in text:
                print(f"FAIL: code lost with a comment: {survivor!r}", file=sys.stderr)
                return 1
        for gone in ("module prose", "item prose", "field prose", "trailing goes"):
            if gone in text:
                print(f"FAIL: comment survived: {gone}", file=sys.stderr)
                return 1
        if text.count("{") != text.count("}"):
            print("FAIL: braces no longer balance", file=sys.stderr)
            return 1
    print("self-test: strings and code survive, comments do not")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--corpus", action="store_true")
    g.add_argument("--strip", action="store_true")
    g.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        return self_test()
    if self_test() != 0:
        return 1
    return sweep(write=args.strip)


if __name__ == "__main__":
    raise SystemExit(main())
