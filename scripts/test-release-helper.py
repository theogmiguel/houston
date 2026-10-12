#!/usr/bin/env python3
"""Offline regression tests; fake every gh/git command, never contact GitHub.

Run with python3 scripts/test-release-helper.py.
"""

import contextlib
import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True
_spec = importlib.util.spec_from_file_location("release_helper", Path(__file__).with_name("release-helper.py"))
helper = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(helper)

SOURCE = "a" * 40
OLD = "b" * 40
MERGE = "c" * 40
REPO = "example/houston"


def release(tag, draft=False, prerelease=False):
    return {"tag_name": tag, "draft": draft, "prerelease": prerelease,
            "published_at": "2026-01-01T00:00:00Z"}


def pr(number=1, body=None, title="feat(panes): add layouts", merge=MERGE):
    return {"number": number, "title": title, "body": body,
            "html_url": f"https://github.com/{REPO}/pull/{number}",
            "merged_at": "2026-01-02T00:00:00Z", "base": {"ref": "main"},
            "merge_commit_sha": merge}


def run(run_id=1, sha=SOURCE, branch="main", event="push", status="completed", conclusion="success", pulls=None):
    return {"id": run_id, "head_sha": sha, "head_branch": branch, "event": event,
            "status": status, "conclusion": conclusion, "pull_requests": pulls or [],
            "html_url": f"https://github.com/{REPO}/actions/runs/{run_id}"}


class FakeCommands:
    def __init__(self):
        self.responses = {}
        self.calls = []
        self.git("rev-parse", "--is-shallow-repository", output="false")
        self.git("rev-parse", "--verify", "--end-of-options", f"{SOURCE}^{{commit}}", output=SOURCE)

    def git(self, *args, output="", code=0):
        self.responses[("git", *args)] = (output, code)
        return self

    def api(self, endpoint, rows, page=1, code=0):
        separator = "&" if "?" in endpoint else "?"
        url = f"repos/{REPO}/{endpoint}{separator}per_page=100&page={page}"
        self.responses[("gh", "api", "--method", "GET", url)] = (json.dumps(rows), code)
        return self

    def __call__(self, args, **kwargs):
        self.calls.append(tuple(args))
        if tuple(args) not in self.responses:
            raise AssertionError(f"Unexpected command: {args}")
        output, code = self.responses[tuple(args)]
        return subprocess.CompletedProcess(args, code, output, "simulated API/git failure" if code else "")

    def baseline(self, releases=None):
        self.api("releases", releases if releases is not None else [release("v0.17.0")])
        self.git("rev-parse", "--verify", "--end-of-options", "v0.17.0^{commit}", output=OLD)
        self.git("merge-base", "--is-ancestor", OLD, SOURCE)
        self.git("rev-list", "--count", f"{OLD}..{SOURCE}", output="2")
        return self

    def commits(self, previous=OLD):
        self.git("rev-list", "--reverse", f"{previous}..{SOURCE}" if previous else SOURCE,
                 output=f"{MERGE}\n{SOURCE}")
        self.api(f"commits/{MERGE}/pulls", [])
        self.api(f"commits/{SOURCE}/pulls", [])
        return self

    def ci(self, runs=None, jobs=None):
        self.api("actions/workflows/ci.yml/runs", {"workflow_runs": runs if runs is not None else [run()]})
        self.api("actions/runs/1/jobs?filter=latest", {"jobs": jobs if jobs is not None else [
            {"name": name, "status": "completed", "conclusion": "success"} for name in helper.REQUIRED_JOBS]})
        return self


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeCommands()
        self.mock = patch.object(helper.subprocess, "run", self.fake)
        self.mock.start()
        self.addCleanup(self.mock.stop)
        self.client = helper.Client(REPO)

    def test_pr_check_accepts_internal_notes_without_git_or_api(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "pr.json"
            path.write_text(json.dumps(pr(body="## Release notes\nNone")))
            self.assertEqual(helper.main(["check-pr", "--pr-file", str(path)]), 0)
            self.assertEqual(self.fake.calls, [])

    def test_pr_check_rejects_an_empty_template(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "pr.json"
            path.write_text(json.dumps(pr(body="## Release notes\n<!-- Write notes -->")))
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(helper.main(["check-pr", "--pr-file", str(path)]), 1)

    def test_published_baseline_ignores_abandoned_tag_draft_and_rc(self):
        self.fake.baseline([release("v0.17.0"), release("v0.18.1", draft=True),
                            release("v0.18.0-rc.1", prerelease=True)])
        self.fake.commits().api(f"commits/{MERGE}/pulls", [pr()])
        markdown, metadata = helper.notes(self.client, SOURCE, "v0.19.0")
        self.assertEqual(metadata["previous_tag"], "v0.17.0")
        self.assertIn("add layouts", markdown)
        self.assertFalse(any("v0.18.0^{commit}" in cmd for cmd in self.fake.calls))

    def test_nearest_ancestor_not_highest_version_or_newest_release(self):
        other = "d" * 40
        self.fake.baseline([release("v9.0.0"), release("v0.17.0")])
        self.fake.git("rev-parse", "--verify", "--end-of-options", "v9.0.0^{commit}", output=other)
        self.fake.git("merge-base", "--is-ancestor", other, SOURCE)
        self.fake.git("rev-list", "--count", f"{other}..{SOURCE}", output="8")
        self.assertEqual(helper.baseline(self.client, SOURCE), ("v0.17.0", OLD))

    def test_source_at_published_release_does_not_repeat_old_changes(self):
        self.fake.api("releases", [release("v0.17.0"), release("v0.18.0")])
        self.fake.git("rev-parse", "--verify", "--end-of-options", "v0.17.0^{commit}", output=OLD)
        self.fake.git("merge-base", "--is-ancestor", OLD, SOURCE, code=1)
        self.fake.git("rev-parse", "--verify", "--end-of-options", "v0.18.0^{commit}", output=SOURCE)
        self.fake.git("merge-base", "--is-ancestor", SOURCE, SOURCE)
        self.fake.git("rev-list", "--count", f"{SOURCE}..{SOURCE}", output="0")
        self.fake.git("rev-list", "--reverse", f"{SOURCE}..{SOURCE}", output="")
        markdown, metadata = helper.notes(self.client, SOURCE, "v0.19.0")
        self.assertEqual(metadata["previous_tag"], "v0.18.0")
        self.assertEqual(metadata["prs"], [])
        self.assertIn("No user-facing changes", markdown)

    def test_rc_without_baseline_includes_full_history(self):
        self.fake.baseline([]).commits(previous=None).api(f"commits/{SOURCE}/pulls", [pr()])
        markdown, meta = helper.notes(self.client, SOURCE, "v0.1.0-rc.1")
        self.assertIsNone(meta["previous_tag"])
        self.assertEqual(meta["source_sha"], SOURCE)
        self.assertIn(f"/commits/{SOURCE}", markdown)
        self.assertEqual(meta["fallbacks"], [1])

    def test_pr_pagination_dedup_and_range_membership(self):
        self.fake.commits()
        self.fake.api(f"commits/{MERGE}/pulls", [pr()] * 100)
        unmerged = pr(4)
        unmerged["merged_at"] = None
        other_base = pr(5)
        other_base["base"]["ref"] = "feature"
        self.fake.api(f"commits/{MERGE}/pulls", [pr(2), pr(3, merge=OLD), unmerged, other_base], page=2)
        self.fake.api(f"commits/{SOURCE}/pulls", [pr(2)])
        self.assertEqual([p["number"] for p in helper.merged_prs(self.client, SOURCE, OLD)], [1, 2])

    def test_release_pagination(self):
        self.fake.baseline([release("v0.1.0-rc.1", prerelease=True)] * 100)
        self.fake.api("releases", [release("v0.17.0")], page=2)
        self.assertEqual(helper.baseline(self.client, SOURCE)[0], "v0.17.0")

    def test_mixed_categories_multiple_items_links_and_section_boundary(self):
        body = """## Summary
Ignored
## Release notes
### Features
- Add layouts.
- Add shortcuts.
### Fixes
- Preserve names.
### Performance
- Reduce redraw work.
### Refactoring
- Simplify layout persistence.
### Other
- Improve help.
## Testing
- This must not appear.
"""
        self.fake.baseline().commits().api(f"commits/{MERGE}/pulls", [pr(body=body)])
        markdown, meta = helper.notes(self.client, SOURCE, "v0.19.0")
        for category in helper.CATEGORIES:
            self.assertIn(f"### {category}", markdown)
        self.assertEqual(markdown.count("([#1]"), 6)
        self.assertNotIn("must not appear", markdown)
        self.assertFalse(meta["needs_editorial_review"])
        self.assertIn("/compare/v0.17.0...v0.19.0", markdown)

    def test_legacy_title_categories_and_review_metadata(self):
        self.fake.baseline().commits().api(f"commits/{MERGE}/pulls", [
            pr(i, title=title) for i, title in enumerate([
                "feat(panes)!: layouts", "fix: names", "perf: redraw", "refactor(core): storage", "docs: help"], 1)])
        markdown, meta = helper.notes(self.client, SOURCE, "v0.19.0")
        self.assertEqual(meta["fallbacks"], [1, 2, 3, 4, 5])
        self.assertTrue(meta["needs_editorial_review"])
        for category in helper.CATEGORIES:
            self.assertIn(f"### {category}", markdown)

    def test_explicit_none_internal_only_and_empty_categories(self):
        for text in ("None", "internal only", "- Internal-only.", "### Features\n- None\n### Fixes\nNone"):
            with self.subTest(text=text):
                self.assertEqual(helper.pr_notes(pr(body=f"## Release notes\n{text}")), ({}, False))

    def test_empty_present_notes_refuse_instead_of_title_fallback(self):
        for text in ("", "<!-- add notes -->", "### Features\n### Fixes", "### Features\n- "):
            with self.subTest(text=text), self.assertRaises(helper.Refused):
                helper.pr_notes(pr(body=f"## Release notes\n{text}"))

    def test_malformed_category_and_missing_heading_refuse(self):
        for text in ("### Security\n- Fix issue.", "- Add layouts.", "### Features\nSome prose"):
            with self.subTest(text=text), self.assertRaises(helper.Refused):
                helper.pr_notes(pr(body=f"## Release notes\n{text}"))

    def test_api_errors_never_become_empty_notes(self):
        self.fake.api("releases", [], code=1)
        with self.assertRaisesRegex(helper.Refused, "gh api.*failed"):
            helper.notes(self.client, SOURCE, "v0.19.0")
        self.fake.baseline().commits().api(f"commits/{SOURCE}/pulls", [], code=1)
        with self.assertRaisesRegex(helper.Refused, "simulated API/git failure"):
            helper.notes(self.client, SOURCE, "v0.19.0")

    def test_second_api_page_error_does_not_truncate_evidence(self):
        self.fake.api("releases", [release("v0.1.0-rc.1", prerelease=True)] * 100)
        self.fake.api("releases", [], page=2, code=1)
        with self.assertRaisesRegex(helper.Refused, "page=2.*failed"):
            helper.baseline(self.client, SOURCE)

    def test_internal_only_pr_retained_in_metadata_but_omitted_from_notes(self):
        self.fake.baseline().commits().api(f"commits/{MERGE}/pulls", [
            pr(body="## Release notes\nInternal only"),
            pr(2, body="## Release notes\n### Fixes\n- Keep pane names.")])
        markdown, meta = helper.notes(self.client, SOURCE, "v0.19.0")
        self.assertNotIn("[#1]", markdown)
        self.assertIn("[#2]", markdown)
        self.assertEqual(len(meta["prs"]), 2)
        self.assertEqual(meta["prs"][0]["notes"], {})
        self.assertEqual(meta["fallbacks"], [])

    def test_rc_ci_wrong_base_refuses(self):
        self.fake.ci([run(sha=MERGE, branch="feature", event="pull_request",
                         pulls=[{"head": {"sha": SOURCE}, "base": {"ref": "feature"}}])])
        with self.assertRaisesRegex(helper.Refused, "exact source SHA"):
            helper.preflight(self.client, SOURCE, rc=True)

    def test_missing_local_release_tag_refuses(self):
        self.fake.baseline().git("rev-parse", "--verify", "--end-of-options", "v0.17.0^{commit}", code=128)
        with self.assertRaisesRegex(helper.Refused, "git rev-parse.*failed"):
            helper.baseline(self.client, SOURCE)

    def test_invalid_api_shape_refuses(self):
        self.fake.api("releases", {"message": "rate limited"})
        with self.assertRaisesRegex(helper.Refused, "Expected API array"):
            helper.baseline(self.client, SOURCE)

    def test_main_ci_exact_sha_and_all_seven_jobs(self):
        self.fake.ci()
        result = helper.preflight(self.client, SOURCE)
        self.assertEqual(result["source_sha"], SOURCE)
        self.assertEqual(len(result["required_jobs"]), 7)

    def test_wrong_sha_branch_or_event_ci_refuses(self):
        for fixture in (run(sha=OLD), run(branch="feature"), run(event="pull_request")):
            self.fake.ci([fixture])
            with self.subTest(fixture=fixture), self.assertRaisesRegex(helper.Refused, "exact source SHA"):
                helper.preflight(self.client, SOURCE)

    def test_rc_merge_commit_ci_matches_pr_head_sha(self):
        fixture = run(sha=MERGE, branch="feature", event="pull_request",
                      pulls=[{"head": {"sha": SOURCE}, "base": {"ref": "main"}}])
        self.fake.ci([fixture])
        self.assertEqual(helper.preflight(self.client, SOURCE, rc=True)["run_id"], 1)
        with self.assertRaises(helper.Refused):
            helper.preflight(self.client, SOURCE)
        fixture["pull_requests"][0]["head"]["sha"] = OLD
        self.fake.ci([fixture])
        with self.assertRaises(helper.Refused):
            helper.preflight(self.client, SOURCE, rc=True)

    def test_latest_matching_pending_or_failed_run_refuses(self):
        for status, conclusion in (("in_progress", None), ("queued", None), ("completed", "failure")):
            self.fake.ci([run(), run(2, status=status, conclusion=conclusion)])
            with self.subTest(status=status), self.assertRaisesRegex(helper.Refused, "CI run 2"):
                helper.preflight(self.client, SOURCE)

    def test_missing_skipped_failed_or_pending_required_job_refuses(self):
        good = [{"name": n, "status": "completed", "conclusion": "success"} for n in helper.REQUIRED_JOBS]
        for bad in (good[1:], [dict(j, conclusion="skipped") for j in good],
                    [dict(j, conclusion="failure") for j in good], [dict(j, status="in_progress") for j in good]):
            self.fake.ci(jobs=bad)
            with self.subTest(jobs=bad), self.assertRaisesRegex(helper.Refused, "safety-checks"):
                helper.preflight(self.client, SOURCE)

    def test_runs_and_jobs_paginated(self):
        self.fake.ci([])
        self.fake.api("actions/workflows/ci.yml/runs", {"workflow_runs": [run(sha=OLD)] * 100})
        self.fake.api("actions/workflows/ci.yml/runs", {"workflow_runs": [run()]}, page=2)
        self.fake.api("actions/runs/1/jobs?filter=latest", {"jobs": [{"name": "extra"}] * 100})
        self.fake.api("actions/runs/1/jobs?filter=latest", {"jobs": [
            {"name": n, "status": "completed", "conclusion": "success"} for n in helper.REQUIRED_JOBS]}, page=2)
        self.assertEqual(helper.preflight(self.client, SOURCE)["run_id"], 1)

    def test_ci_api_failure_refuses(self):
        self.fake.ci().api("actions/runs/1/jobs?filter=latest", {"jobs": []}, code=1)
        with self.assertRaisesRegex(helper.Refused, "gh api.*failed"):
            helper.preflight(self.client, SOURCE)

    def test_cli_writes_markdown_and_metadata_and_refuses_without_output(self):
        with tempfile.TemporaryDirectory() as root:
            output, metadata = Path(root) / "notes.md", Path(root) / "notes.json"
            args = ["notes", "--repo", REPO, "--source", SOURCE, "--tag", "v0.19.0",
                    "--output", str(output), "--metadata", str(metadata)]
            self.fake.baseline().commits().api(f"commits/{MERGE}/pulls", [pr()])
            self.assertEqual(helper.main(args), 0)
            self.assertIn("### Features", output.read_text())
            self.assertEqual(json.loads(metadata.read_text())["fallbacks"], [1])
            output.unlink()
            metadata.unlink()
            self.fake.api("releases", [], code=1)
            with contextlib.redirect_stderr(io.StringIO()) as errors:
                self.assertEqual(helper.main(args), 1)
            self.assertIn("refused", errors.getvalue())
            self.assertFalse(output.exists())
            self.assertFalse(metadata.exists())

    def test_cli_preflight_json_and_shallow_refusal(self):
        with tempfile.TemporaryDirectory() as root:
            metadata = Path(root) / "ci.json"
            args = ["preflight", "--repo", REPO, "--source", SOURCE, "--metadata", str(metadata)]
            self.fake.ci()
            self.assertEqual(helper.main(args), 0)
            self.assertEqual(json.loads(metadata.read_text())["run_id"], 1)
            self.fake.git("rev-parse", "--is-shallow-repository", output="true")
            with contextlib.redirect_stderr(io.StringIO()) as errors:
                self.assertEqual(helper.main(args), 1)
            self.assertIn("Full git history", errors.getvalue())


if __name__ == "__main__":
    unittest.main()
