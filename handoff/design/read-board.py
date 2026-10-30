#!/usr/bin/env python3
"""Print a design board with one CSS declaration and one tag per line.

Boards keep their CSS and markup on a few very long lines, which stall tools that read
line by line. This prints the same content reflowed; the board file itself is not changed.

usage: read-board.py <board.dc.html> [--css | --markup]
"""
import re
import sys


def reflow_css(css: str) -> str:
    css = re.sub(r"\s*{\s*", " {\n  ", css)
    css = re.sub(r";\s*", ";\n  ", css)
    css = re.sub(r"\s*}\s*", "\n}\n", css)
    return re.sub(r"\n\s*\n", "\n", css).strip()


def reflow_markup(html: str) -> str:
    html = re.sub(r">\s*<", ">\n<", html)
    return html.strip()


def main() -> int:
    args = sys.argv[1:]
    if not args or args[0].startswith("-"):
        print(__doc__.strip(), file=sys.stderr)
        return 2
    mode = args[1] if len(args) > 1 else "--all"
    if mode not in ("--css", "--markup", "--all"):
        print(f"read-board: unknown mode {mode!r}; expected --css, --markup or nothing", file=sys.stderr)
        return 2
    text = open(args[0], encoding="utf-8").read()
    styles = re.findall(r"<style[^>]*>(.*?)</style>", text, flags=re.S)
    markup = re.sub(r"<style[^>]*>.*?</style>", "", text, flags=re.S)
    if mode in ("--css", "--all"):
        for block in styles:
            print(reflow_css(block))
    if mode in ("--markup", "--all"):
        print(reflow_markup(markup))
    return 0


if __name__ == "__main__":
    sys.exit(main())
