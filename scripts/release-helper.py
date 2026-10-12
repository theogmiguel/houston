#!/usr/bin/env python3
"""Read-only release notes and CI preflight using gh REST APIs and local git.

Requires gh authentication and a full checkout with fetched release tags. Notes
consume English PR copy; missing sections use titles and flag editorial review.
No version allocation, GitHub writes, fetching, or language-model calls occur.
Run either subcommand with --help for its workflow-facing contract.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote

CATEGORIES = ("Features", "Fixes", "Performance", "Refactoring", "Other")
REQUIRED_JOBS = (
    "safety-checks", "renderer-checks", "core-checks", "linux-native-checks",
    "windows-renderer-checks", "windows-checks", "licence-inventory",
)
STABLE_TAG = re.compile(r"v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)")
NONE = re.compile(r"(?:none|internal[ -]only)[.!]?", re.IGNORECASE)


class Refused(Exception):
    """Input or remote evidence cannot support the requested release operation."""


class Client:
    def __init__(self, repository):
        self.repository = repository

    def command(self, args, allowed=(0,)):
        try:
            result = subprocess.run(args, text=True, capture_output=True, check=False)
        except OSError as exc:
            raise Refused(f"Cannot run {args[0]}: {exc}") from exc
        if result.returncode not in allowed:
            raise Refused(f"{' '.join(args)} failed ({result.returncode}): "
                          f"{result.stderr.strip() or result.stdout.strip()}")
        return result

    def git(self, *args):
        return self.command(["git", *args]).stdout.strip()

    def resolve(self, ref):
        return self.git("rev-parse", "--verify", "--end-of-options", f"{ref}^{{commit}}")

    def ancestor(self, before, after):
        return self.command(["git", "merge-base", "--is-ancestor", before, after],
                            allowed=(0, 1)).returncode == 0

    def pages(self, endpoint, key=None):
        """Explicit pages keep both list and object-shaped REST responses simple."""
        page = 1
        while True:
            separator = "&" if "?" in endpoint else "?"
            url = f"repos/{self.repository}/{endpoint}{separator}per_page=100&page={page}"
            raw = self.command(["gh", "api", "--method", "GET", url]).stdout
            try:
                value = json.loads(raw)
                rows = value[key] if key else value
            except (ValueError, KeyError, TypeError) as exc:
                raise Refused(f"Invalid API response for {url}") from exc
            if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
                raise Refused(f"Expected API array of objects for {url}")
            yield from rows
            if len(rows) < 100:
                return
            page += 1


def baseline(client, source):
    candidates = []
    for release in client.pages("releases"):
        tag = release.get("tag_name", "")
        if (release.get("draft") is not False or release.get("prerelease") is not False
                or not release.get("published_at") or not STABLE_TAG.fullmatch(tag)):
            continue
        commit = client.resolve(tag)
        if commit != source and client.ancestor(commit, source):
            distance = int(client.git("rev-list", "--count", f"{commit}..{source}"))
            candidates.append((distance, tag, commit))
    if not candidates:
        return None, None
    _, tag, commit = min(candidates)
    return tag, commit


def merged_prs(client, source, previous):
    commits = client.git("rev-list", "--reverse", f"{previous}..{source}" if previous else source).splitlines()
    commit_set = set(commits)
    prs = {}
    for commit in commits:
        for pr in client.pages(f"commits/{commit}/pulls"):
            if (pr.get("merged_at") and pr.get("base", {}).get("ref") == "main"
                    and pr.get("merge_commit_sha") in commit_set):
                prs[pr["number"]] = pr
    return [prs[number] for number in sorted(prs)]


def title_category(title):
    prefix = re.match(r"^(\w+)(?:\([^)]*\))?!?:", title)
    return {"feat": "Features", "fix": "Fixes", "perf": "Performance",
            "refactor": "Refactoring"}.get(prefix[1].lower() if prefix else "", "Other")


def pr_notes(pr):
    """Missing legacy sections fall back; present but empty/malformed copy refuses."""
    body = (pr.get("body") or "").replace("\r\n", "\n")
    body = re.sub(r"<!--.*?-->", "", body, flags=re.DOTALL)
    match = re.search(r"^## Release notes\s*$", body, re.MULTILINE | re.IGNORECASE)
    if not match:
        return {title_category(pr["title"]): [pr["title"]]}, True
    section = re.split(r"^#{1,2}\s+", body[match.end():], maxsplit=1, flags=re.MULTILINE)[0].strip()
    if NONE.fullmatch(section):
        return {}, False
    items = {}
    category = None
    for raw in section.splitlines():
        line = raw.strip()
        if not line:
            continue
        heading = re.fullmatch(r"###\s+(.+)", line)
        if heading:
            category = next((c for c in CATEGORIES if c.lower() == heading[1].lower()), None)
            if category is None:
                raise Refused(f"PR #{pr['number']}: unknown release notes category {heading[1]!r}")
            continue
        text = re.sub(r"^(?:[-*+] |\d+[.)] )", "", line).strip()
        if NONE.fullmatch(text):
            continue
        if not category:
            raise Refused(f"PR #{pr['number']}: release notes require ### category headings")
        if not re.match(r"^(?:[-*+] |\d+[.)] )", line):
            raise Refused(f"PR #{pr['number']}: expected a release notes list item, got {line!r}")
        if text:
            items.setdefault(category, []).append(text)
    if not items:
        # An empty template is different from an explicit internal-only decision.
        markers = [re.sub(r"^(?:[-*+] |\d+[.)] )", "", line.strip())
                   for line in section.splitlines() if line.strip() and not line.strip().startswith("### ")]
        if not markers or not all(NONE.fullmatch(marker) for marker in markers):
            raise Refused(f"PR #{pr['number']}: empty Release notes; write items or explicit None/internal only")
    return items, False


def notes(client, source, tag):
    previous_tag, previous = baseline(client, source)
    prs = merged_prs(client, source, previous)
    grouped = {category: [] for category in CATEGORIES}
    metadata_prs = []
    for pr in prs:
        items, fallback = pr_notes(pr)
        url = pr["html_url"]
        for category, entries in items.items():
            grouped[category].extend(f"- {entry} ([#{pr['number']}]({url}))" for entry in entries)
        metadata_prs.append({"number": pr["number"], "title": pr["title"], "url": url,
                             "fallback": fallback, "needs_editorial_review": fallback,
                             "notes": items})
    lines = [f"## {tag}", ""]
    for category, entries in grouped.items():
        if entries:
            lines.extend([f"### {category}", "", *entries, ""])
    if not any(grouped.values()):
        lines.extend(["No user-facing changes.", ""])
    repo_url = f"https://github.com/{client.repository}"
    changelog = (f"{repo_url}/compare/{quote(previous_tag, safe='')}...{quote(tag, safe='')}"
                 if previous_tag else f"{repo_url}/commits/{source}")
    lines.append(f"**Full changelog:** [View changes]({changelog})")
    fallbacks = [pr["number"] for pr in metadata_prs if pr["fallback"]]
    return "\n".join(lines) + "\n", {
        "previous_tag": previous_tag, "source_sha": source, "tag": tag,
        "prs": metadata_prs, "fallbacks": fallbacks,
        "needs_editorial_review": bool(fallbacks), "changelog_url": changelog,
    }


def preflight(client, source, rc=False, workflow="ci.yml", required=REQUIRED_JOBS):
    runs = list(client.pages(f"actions/workflows/{quote(workflow, safe='')}/runs", "workflow_runs"))
    matches = []
    for run in runs:
        main = (run.get("head_sha") == source and run.get("head_branch") == "main"
                and run.get("event") in ("push", "workflow_dispatch"))
        pull = (rc and run.get("event") == "pull_request"
                and any(pr.get("head", {}).get("sha") == source
                        and pr.get("base", {}).get("ref") == "main"
                        for pr in run.get("pull_requests", [])))
        if main or pull:
            matches.append(run)
    if not matches:
        raise Refused(f"No {workflow} CI run for exact source SHA {source} on main"
                      + (" or an RC pull request targeting main" if rc else ""))
    run = max(matches, key=lambda value: (value["id"], value.get("run_attempt", 1)))
    if run.get("status") != "completed" or run.get("conclusion") != "success":
        raise Refused(f"CI run {run['id']} for {source}: status={run.get('status')}, "
                      f"conclusion={run.get('conclusion')}; require completed/success")
    jobs = list(client.pages(f"actions/runs/{run['id']}/jobs?filter=latest", "jobs"))
    problems = []
    for name in required:
        matching = [job for job in jobs if job.get("name") == name]
        if not matching:
            problems.append(f"{name}: missing")
        elif any(job.get("status") != "completed" or job.get("conclusion") != "success" for job in matching):
            problems.append(f"{name}: " + ", ".join(f"{job.get('status')}/{job.get('conclusion')}" for job in matching))
    if problems:
        raise Refused(f"CI run {run['id']} lacks successful required jobs: " + "; ".join(problems))
    return {"source_sha": source, "run_id": run["id"], "run_url": run.get("html_url"),
            "workflow": workflow, "required_jobs": list(required), "rc": rc}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("notes", "preflight"):
        command = commands.add_parser(name)
        command.add_argument("--repo", required=True, help="GitHub OWNER/REPO")
        command.add_argument("--source", required=True, help="local commit/ref; resolved to exact SHA")
        command.add_argument("--metadata", required=True, type=Path, help="output JSON path (written only on success)")
        if name == "notes":
            command.add_argument("--tag", required=True, help="planned vVERSION tag, including RC suffix if applicable")
            command.add_argument("--output", required=True, type=Path, help="output notes Markdown path")
        else:
            command.add_argument("--rc", action="store_true", help="also accept PR CI with matching pull_requests.head.sha")
            command.add_argument("--workflow", default="ci.yml", help="CI workflow filename or ID")
            command.add_argument("--required-job", action="append", help="override required job names; repeat for every job")
    args = parser.parse_args(argv)
    try:
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repo):
            raise Refused(f"Invalid repository {args.repo!r}; expected OWNER/REPO")
        client = Client(args.repo)
        if client.git("rev-parse", "--is-shallow-repository") != "false":
            raise Refused("Full git history required; use checkout fetch-depth: 0 with release tags")
        source = client.resolve(args.source)
        if args.command == "notes":
            if not re.fullmatch(r"v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", args.tag):
                raise Refused(f"Invalid release tag {args.tag!r}; expected vMAJOR.MINOR.PATCH[-PRERELEASE]")
            if args.output.resolve() == args.metadata.resolve():
                raise Refused("Notes and metadata output paths must differ")
            markdown, metadata = notes(client, source, args.tag)
            args.output.write_text(markdown, encoding="utf-8")
        else:
            metadata = preflight(client, source, args.rc, args.workflow, args.required_job or REQUIRED_JOBS)
        args.metadata.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    except (Refused, OSError, KeyError, TypeError, ValueError) as exc:
        print(f"release-helper: refused: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
