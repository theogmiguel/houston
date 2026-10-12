#!/usr/bin/env python3
"""Offline regression tests for reviewed notes and draft publication boundaries."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("release_draft", Path(__file__).with_name("release-draft.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class DraftTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.notes = self.root / "notes.md"
        self.notes.write_text("Reviewed notes\n")
        self.assets = self.root / "assets"
        self.assets.mkdir()
        self.manifest = {"version": "1.2.3", "platforms": {"linux-x86_64": {"signature": "sig", "url": "bundle"}}, "notes": "old", "pub_date": "original"}
        self.shipped = self.root / "shipped.json"
        self.shipped.write_text(json.dumps(self.manifest))
        self.output = self.root / "synchronized/latest.json"
        self.draft = {"id": 1, "draft": True, "prerelease": False, "body": "Reviewed notes\n", "assets": []}
        self.snapshot = self.root / "snapshot.json"
        self.snapshot.write_text(json.dumps(self.draft))
        self.commands = []

    def command(self, args):
        self.commands.append(args)
        if "gen-update-manifest.py" in args[1]:
            value = dict(self.manifest, notes=self.notes.read_text().strip(), pub_date="regenerated")
            self.output.write_text(json.dumps(value))
        return ""

    def promote(self):
        m.promote("owner/repo", "v1.2.3", self.assets, self.shipped, self.notes, self.output, self.root / "tauri.json", self.snapshot)

    def test_reviewed_notes_are_uploaded_before_publication_and_date_is_preserved(self):
        with patch.object(m, "release", return_value=self.draft), patch.object(m, "run", side_effect=self.command):
            self.promote()
        self.assertEqual(json.loads(self.output.read_text())["notes"], "Reviewed notes")
        self.assertEqual(json.loads(self.output.read_text())["pub_date"], "original")
        self.assertEqual(self.commands[-2][1:3], ["release", "upload"])
        self.assertIn(str(self.output), self.commands[-2])
        self.assertEqual(self.commands[-1][1:3], ["release", "edit"])
        self.assertIn("--draft=false", self.commands[-1])
        self.assertIn("--linux-only", self.commands[0])

    def test_public_release_is_never_mutated(self):
        with patch.object(m, "release", return_value=dict(self.draft, draft=False)), patch.object(m, "run", side_effect=self.command):
            with self.assertRaises(m.Refused):
                self.promote()
            self.assertFalse(any(args[0] == "gh" for args in self.commands))

    def test_signature_failure_never_uploads_or_publishes(self):
        with patch.object(m, "release", return_value=self.draft), patch.object(m, "run", side_effect=m.Refused("invalid signature")):
            with self.assertRaisesRegex(m.Refused, "invalid signature"):
                self.promote()

    def test_manifest_platform_mismatch_is_refused(self):
        def mismatch(args):
            self.command(args)
            self.output.write_text(json.dumps(dict(self.manifest, platforms={})))
        with patch.object(m, "release", return_value=self.draft), patch.object(m, "run", side_effect=mismatch):
            with self.assertRaisesRegex(m.Refused, "platforms differs"):
                self.promote()
        self.assertEqual(len(self.commands), 1)

    def test_edit_during_verification_requires_retry(self):
        with patch.object(m, "release", side_effect=[dict(self.draft, body="new edit")]), patch.object(m, "run", side_effect=self.command):
            with self.assertRaisesRegex(m.Refused, "changed during verification"):
                self.promote()
        self.assertEqual(len(self.commands), 1)

    def test_edit_after_upload_does_not_publish(self):
        with patch.object(m, "release", side_effect=[self.draft, dict(self.draft, body="new edit")]), patch.object(m, "run", side_effect=self.command):
            with self.assertRaisesRegex(m.Refused, "changed during synchronization"):
                self.promote()
        self.assertFalse(any(args[1:3] == ["release", "edit"] for args in self.commands))

    def test_prerelease_change_after_upload_does_not_publish(self):
        with patch.object(m, "release", side_effect=[self.draft, dict(self.draft, prerelease=True)]), patch.object(m, "run", side_effect=self.command):
            with self.assertRaisesRegex(m.Refused, "changed during synchronization"):
                self.promote()
        self.assertFalse(any(args[1:3] == ["release", "edit"] for args in self.commands))

    def test_rc_remains_prerelease_when_published(self):
        self.snapshot.write_text(json.dumps(dict(self.draft, prerelease=True)))
        with patch.object(m, "release", return_value=dict(self.draft, prerelease=True)), patch.object(m, "run", side_effect=self.command):
            self.promote()
        self.assertIn("--prerelease", self.commands[-1])

    def test_asset_replaced_after_download_is_refused(self):
        changed = dict(self.draft, assets=[{"id": 2, "name": "bundle", "size": 10, "updated_at": "new"}])
        with patch.object(m, "release", return_value=changed), patch.object(m, "run", side_effect=self.command):
            with self.assertRaisesRegex(m.Refused, "changed during verification"):
                self.promote()
        self.assertFalse(any(args[0] == "gh" for args in self.commands))

    def test_asset_replaced_after_manifest_upload_is_refused(self):
        changed = dict(self.draft, assets=[{"id": 2, "name": "bundle", "size": 10, "updated_at": "new"}])
        with patch.object(m, "release", side_effect=[self.draft, changed]), patch.object(m, "run", side_effect=self.command):
            with self.assertRaisesRegex(m.Refused, "changed during synchronization"):
                self.promote()
        self.assertFalse(any(args[1:3] == ["release", "edit"] for args in self.commands))

    def test_resume_uses_reviewed_body_instead_of_generated_copy(self):
        generated = self.root / "generated.md"
        generated.write_text("generated title-only fallback")
        with patch.object(m, "release", return_value=self.draft):
            m.notes("owner/repo", "v1.2.3", generated, self.notes, True)
        self.assertEqual(self.notes.read_text(), self.draft["body"])

    def test_resume_updates_assets_without_deleting_the_release(self):
        (self.assets / "latest.json").write_text(json.dumps(self.manifest))
        with patch.object(m, "release", return_value=self.draft), patch.object(m, "run", side_effect=self.command):
            m.file_draft("owner/repo", "v1.2.3", "Title", self.assets, self.notes, True, False)
        self.assertEqual(len(self.commands), 1)
        self.assertEqual(self.commands[0][1:3], ["release", "upload"])

    def test_resume_refuses_platform_loss(self):
        (self.assets / "latest.json").write_text(json.dumps(self.manifest))
        draft = dict(self.draft, assets=[{"name": "Windows.exe"}])
        with patch.object(m, "release", return_value=draft), patch.object(m, "run") as run:
            with self.assertRaisesRegex(m.Refused, "platform set"):
                m.file_draft("owner/repo", "v1.2.3", "Title", self.assets, self.notes, True, False)
            run.assert_not_called()

    def test_new_release_is_always_a_draft(self):
        (self.assets / "latest.json").write_text(json.dumps(self.manifest))
        with patch.object(m, "release", return_value=None), patch.object(m, "run", side_effect=self.command):
            m.file_draft("owner/repo", "v1.2.3", "Title", self.assets, self.notes, False, False)
        self.assertIn("--draft", self.commands[0])
        self.assertIn("--verify-tag", self.commands[0])

    def test_draft_is_found_although_the_tag_endpoint_hides_it(self):
        def github(args, **kwargs):
            if any("releases/tags/" in arg for arg in args):
                return m.subprocess.CompletedProcess(args, 1, "", "gh: Not Found (HTTP 404)")
            listed = [dict(self.draft, tag_name="v1.2.2", id=0), dict(self.draft, tag_name="v1.2.3")]
            selected = [json.dumps(r) for r in listed if '"v1.2.3"' in args[-1] and r["tag_name"] == "v1.2.3"]
            return m.subprocess.CompletedProcess(args, 0, "\n".join(selected) + "\n", "")
        with patch.object(m.subprocess, "run", side_effect=github):
            self.assertEqual(m.release("owner/repo", "v1.2.3")["id"], 1)


if __name__ == "__main__":
    unittest.main()
