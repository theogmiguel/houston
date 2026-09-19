#!/usr/bin/env python3
"""Focused tests for scripts/gen-update-manifest.py.

Run with `python3 scripts/test-update-manifest.py`; nothing here needs network
or a checkout beyond the script beside it.
"""

import base64
import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
# Importing the generator by path would otherwise drop a __pycache__ beside it.
sys.dont_write_bytecode = True
_spec = importlib.util.spec_from_file_location(
    "gen_update_manifest", HERE / "gen-update-manifest.py"
)
manifest = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(manifest)

SIGNATURE = base64.b64encode(
    b"untrusted comment: signature from tauri secret key\nRUQdGVzdCBzaWduYXR1cmU=\n"
).decode()


class ReleaseFixture:
    """A throwaway artifacts directory shaped like a real publish download."""

    def __init__(self, version="1.2.3", tag="v1.2.3"):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.version = version
        self.tag = tag
        self.artifacts = self.root / "artifacts"
        self.artifacts.mkdir()
        self.notes = self.root / "notes.md"
        self.notes.write_text("What changed, in the reader's voice.")

    def close(self):
        self._tmp.cleanup()

    def add_bundle(self, name, signature=SIGNATURE):
        (self.artifacts / name).write_bytes(b"bundle")
        if signature is not None:
            (self.artifacts / f"{name}.sig").write_text(signature)
        return self

    def add_file(self, name, content="x"):
        (self.artifacts / name).write_text(content)
        return self

    def add_all_bundles(self):
        base = self.version.split("+", 1)[0]
        for name in (
            f"Houston_{base}_amd64.AppImage",
            f"Houston_{base}_amd64.deb",
            f"Houston_{base}_aarch64.AppImage",
            f"Houston_{base}_arm64.deb",
            f"Houston_{base}_x64-setup.exe",
        ):
            self.add_bundle(name)
        return self

    def generate(self, **overrides):
        kwargs = {
            "artifacts_dir": self.artifacts,
            "notes_file": self.notes,
            "version": self.version,
            "tag": self.tag,
            "repository": "theogmiguel/houston",
            "pub_date": "2026-09-16T00:00:00Z",
        }
        kwargs.update(overrides)
        return manifest.assemble(**kwargs)


class AssembleTests(unittest.TestCase):
    def setUp(self):
        self.release = ReleaseFixture()
        self.addCleanup(self.release.close)

    def refuse(self, **overrides):
        with self.assertRaises(manifest.Refused) as caught:
            self.release.generate(**overrides)
        return str(caught.exception)

    def test_happy_path_uses_bundle_specific_keys_and_sig_contents(self):
        self.release.add_all_bundles()
        built = self.release.generate()

        self.assertEqual(built["version"], "1.2.3")
        self.assertEqual(built["notes"], "What changed, in the reader's voice.")
        self.assertEqual(built["pub_date"], "2026-09-16T00:00:00Z")
        self.assertEqual(
            list(built["platforms"]),
            [
                "linux-aarch64",
                "linux-aarch64-appimage",
                "linux-aarch64-deb",
                "linux-x86_64",
                "linux-x86_64-appimage",
                "linux-x86_64-deb",
                "windows-x86_64",
                "windows-x86_64-nsis",
            ],
        )
        appimage = built["platforms"]["linux-x86_64-appimage"]
        self.assertEqual(
            appimage["url"],
            "https://github.com/theogmiguel/houston/releases/download/v1.2.3/"
            "Houston_1.2.3_amd64.AppImage",
        )
        self.assertEqual(appimage["signature"], SIGNATURE)
        self.assertEqual(
            built["platforms"]["linux-x86_64"]["signature"], SIGNATURE
        )
        self.assertEqual(
            built["platforms"]["linux-aarch64-appimage"]["url"],
            "https://github.com/theogmiguel/houston/releases/download/v1.2.3/"
            "Houston_1.2.3_aarch64.AppImage",
        )
        self.assertEqual(
            built["platforms"]["linux-aarch64-deb"]["url"],
            "https://github.com/theogmiguel/houston/releases/download/v1.2.3/"
            "Houston_1.2.3_arm64.deb",
        )
        self.assertEqual(
            built["platforms"]["linux-x86_64-deb"]["url"],
            "https://github.com/theogmiguel/houston/releases/download/v1.2.3/"
            "Houston_1.2.3_amd64.deb",
        )
        self.assertEqual(
            built["platforms"]["windows-x86_64-nsis"]["url"],
            "https://github.com/theogmiguel/houston/releases/download/v1.2.3/"
            "Houston_1.2.3_x64-setup.exe",
        )
        self.assertEqual(
            built["platforms"]["windows-x86_64"],
            built["platforms"]["windows-x86_64-nsis"],
        )

    def test_nightly_filenames_carry_the_manifest_version(self):
        self.release = ReleaseFixture(version="0.10.0+nightly.20260916.abcdef1")
        self.addCleanup(self.release.close)
        self.release.add_all_bundles()

        built = self.release.generate()
        self.assertEqual(built["version"], "0.10.0+nightly.20260916.abcdef1")
        self.assertIn("Houston_0.10.0_amd64.AppImage", built["platforms"]["linux-x86_64"]["url"])

    def test_the_nightly_url_is_filed_under_the_nightly_tag(self):
        self.release = ReleaseFixture(
            version="0.10.0+nightly.20260916.abcdef1", tag="nightly"
        )
        self.addCleanup(self.release.close)
        self.release.add_all_bundles()

        built = self.release.generate()
        self.assertIn(
            "/releases/download/nightly/Houston_0.10.0_amd64.AppImage",
            built["platforms"]["linux-x86_64-appimage"]["url"],
        )
        self.assertIn(
            "/releases/download/nightly/Houston_0.10.0_arm64.deb",
            built["platforms"]["linux-aarch64-deb"]["url"],
        )

    def test_the_raw_appimage_serves_both_appimage_keys_in_v2_mode(self):
        self.release.add_all_bundles()

        built = self.release.generate()
        appimage = built["platforms"]["linux-x86_64-appimage"]
        self.assertTrue(
            appimage["url"].endswith("Houston_1.2.3_amd64.AppImage"), appimage["url"]
        )
        self.assertEqual(appimage["url"], built["platforms"]["linux-x86_64"]["url"])
        self.assertEqual(
            appimage["signature"], built["platforms"]["linux-x86_64"]["signature"]
        )

    def test_a_missing_linux_architecture_is_refused(self):
        base = "1.2.3"
        self.release.add_bundle(f"Houston_{base}_amd64.AppImage")
        self.release.add_bundle(f"Houston_{base}_amd64.deb")
        self.release.add_bundle(f"Houston_{base}_x64-setup.exe")

        message = self.refuse()
        self.assertIn("Linux bundles for aarch64", message)

    def test_an_unsupported_linux_architecture_is_refused(self):
        self.release.add_all_bundles()
        self.release.add_bundle("Houston_1.2.3_i686.AppImage")
        self.release.add_bundle("Houston_1.2.3_i386.deb")

        message = self.refuse()
        self.assertIn("unsupported Linux architecture(s) i686", message)

    def test_an_unsupported_windows_architecture_is_refused(self):
        self.release.add_all_bundles()
        self.release.add_bundle("Houston_1.2.3_arm64-setup.exe")

        message = self.refuse()
        self.assertIn("unsupported Windows architecture(s) aarch64", message)

    def test_release_candidate_keeps_its_suffix_in_filenames(self):
        self.release = ReleaseFixture(version="0.11.0-rc.1", tag="v0.11.0-rc.1")
        self.addCleanup(self.release.close)
        self.release.add_all_bundles()

        built = self.release.generate()
        self.assertEqual(built["version"], "0.11.0-rc.1")
        self.assertIn("Houston_0.11.0-rc.1_amd64.AppImage", built["platforms"]["linux-x86_64"]["url"])

    def test_a_manifest_version_with_stable_filenames_is_refused(self):
        self.release.add_all_bundles()

        message = self.refuse(version="1.2.3-rc.1")
        self.assertIn("Houston_1.2.3_aarch64.AppImage", message)
        self.assertIn("1.2.3-rc.1", message)

    def test_a_signature_with_trailing_whitespace_is_accepted(self):
        base = "1.2.3"
        self.release.add_all_bundles()
        (self.release.artifacts / f"Houston_{base}_amd64.AppImage.sig").write_text(
            SIGNATURE + "\n"
        )

        built = self.release.generate()
        self.assertEqual(built["platforms"]["linux-x86_64"]["signature"], SIGNATURE)

    def test_missing_signature_is_refused_by_name(self):
        self.release.add_all_bundles()
        (self.release.artifacts / "Houston_1.2.3_amd64.deb.sig").unlink()

        message = self.refuse()
        self.assertIn("Houston_1.2.3_amd64.deb", message)
        self.assertIn(".sig", message)

    def test_version_mismatch_is_refused(self):
        self.release.add_all_bundles()
        (self.release.artifacts / "Houston_1.2.3_amd64.deb").rename(
            self.release.artifacts / "Houston_1.1.0_amd64.deb"
        )
        (self.release.artifacts / "Houston_1.2.3_amd64.deb.sig").rename(
            self.release.artifacts / "Houston_1.1.0_amd64.deb.sig"
        )

        message = self.refuse()
        self.assertIn("1.1.0", message)
        self.assertIn("1.2.3", message)

    def test_a_missing_deb_for_one_architecture_is_refused(self):
        self.release.add_all_bundles()
        (self.release.artifacts / "Houston_1.2.3_arm64.deb").unlink()
        (self.release.artifacts / "Houston_1.2.3_arm64.deb.sig").unlink()

        message = self.refuse()
        self.assertIn("Linux .deb for aarch64", message)

    def test_a_missing_appimage_for_one_architecture_is_refused(self):
        self.release.add_all_bundles()
        (self.release.artifacts / "Houston_1.2.3_aarch64.AppImage").unlink()
        (self.release.artifacts / "Houston_1.2.3_aarch64.AppImage.sig").unlink()

        message = self.refuse()
        self.assertIn("Linux AppImage for aarch64", message)

    def test_a_missing_windows_installer_is_refused(self):
        base = "1.2.3"
        self.release.add_bundle(f"Houston_{base}_amd64.AppImage")
        self.release.add_bundle(f"Houston_{base}_amd64.deb")
        self.release.add_bundle(f"Houston_{base}_aarch64.AppImage")
        self.release.add_bundle(f"Houston_{base}_arm64.deb")

        message = self.refuse()
        self.assertIn("Windows NSIS", message)

    def test_linux_bundles_alone_are_refused(self):
        base = "1.2.3"
        self.release.add_bundle(f"Houston_{base}_amd64.AppImage")
        self.release.add_bundle(f"Houston_{base}_amd64.deb")

        message = self.refuse()
        self.assertIn("Windows NSIS", message)

    def test_orphan_signature_is_refused(self):
        self.release.add_all_bundles()
        self.release.add_file("Houston_1.2.3_arm64.AppImage.sig", SIGNATURE)

        message = self.refuse()
        self.assertIn("Houston_1.2.3_arm64.AppImage.sig", message)

    def test_unrecognised_artifact_is_refused(self):
        self.release.add_all_bundles()
        self.release.add_file("Houston.AppImage")

        message = self.refuse()
        self.assertIn("Houston.AppImage", message)

    def test_a_pre_existing_latest_json_is_refused(self):
        self.release.add_all_bundles()
        self.release.add_file("latest.json", "{}")

        message = self.refuse()
        self.assertIn("latest.json", message)

    def test_a_wrong_product_name_is_refused(self):
        self.release.add_all_bundles()
        (self.release.artifacts / "Houston_1.2.3_amd64.deb").rename(
            self.release.artifacts / "Other_1.2.3_amd64.deb"
        )
        (self.release.artifacts / "Houston_1.2.3_amd64.deb.sig").rename(
            self.release.artifacts / "Other_1.2.3_amd64.deb.sig"
        )

        message = self.refuse()
        self.assertIn("Other_1.2.3_amd64.deb", message)

    def test_empty_signature_is_refused(self):
        self.release.add_all_bundles()
        (self.release.artifacts / "Houston_1.2.3_amd64.deb.sig").write_text("")

        message = self.refuse()
        self.assertIn("Houston_1.2.3_amd64.deb.sig", message)

    def test_a_non_minisign_signature_is_refused(self):
        self.release.add_all_bundles()
        (self.release.artifacts / "Houston_1.2.3_amd64.deb.sig").write_text(
            base64.b64encode(b"404: Not Found\n").decode()
        )

        message = self.refuse()
        self.assertIn("Minisign", message)

    def test_empty_notes_are_refused(self):
        self.release.add_all_bundles()
        self.release.notes.write_text("\n")

        message = self.refuse()
        self.assertIn("notes.md", message)

    def test_a_non_semver_version_is_refused(self):
        self.release.add_all_bundles()
        message = self.refuse(version="nightly")
        self.assertIn("semver", message)

    def test_a_tag_that_cannot_sit_in_a_url_is_refused(self):
        self.release.add_all_bundles()
        message = self.refuse(tag="v1.2.3 beta")
        self.assertIn("tag", message)

    def test_the_tarball_appimage_wins_for_both_appimage_keys(self):
        base = "1.2.3"
        self.release.add_bundle(f"Houston_{base}_amd64.AppImage")
        self.release.add_bundle(f"Houston_{base}_amd64.AppImage.tar.gz")
        self.release.add_bundle(f"Houston_{base}_amd64.deb")
        self.release.add_bundle(f"Houston_{base}_aarch64.AppImage")
        self.release.add_bundle(f"Houston_{base}_arm64.deb")
        self.release.add_bundle(f"Houston_{base}_x64-setup.exe")

        built = self.release.generate()
        self.assertIn(
            "Houston_1.2.3_amd64.AppImage.tar.gz",
            built["platforms"]["linux-x86_64-appimage"]["url"],
        )
        self.assertIn(
            "Houston_1.2.3_amd64.AppImage.tar.gz",
            built["platforms"]["linux-x86_64"]["url"],
        )


class CommandLineTests(unittest.TestCase):
    def test_cli_writes_the_manifest_and_reports_refusals(self):
        with tempfile.TemporaryDirectory() as tmp:
            release = ReleaseFixture()
            self.addCleanup(release.close)
            release.add_all_bundles()
            output = Path(tmp) / "latest.json"

            status = manifest.main(
                [
                    "--artifacts-dir",
                    str(release.artifacts),
                    "--notes-file",
                    str(release.notes),
                    "--output",
                    str(output),
                    "--version",
                    release.version,
                    "--tag",
                    release.tag,
                    "--repository",
                    "theogmiguel/houston",
                    "--pub-date",
                    "2026-09-16T00:00:00Z",
                ]
            )
            self.assertEqual(status, 0)
            written = json.loads(output.read_text())
            self.assertEqual(written["version"], "1.2.3")
            self.assertEqual(written["platforms"]["linux-x86_64"]["signature"], SIGNATURE)

            (release.artifacts / "Houston_1.2.3_amd64.deb.sig").unlink()
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                status = manifest.main(
                    [
                        "--artifacts-dir",
                        str(release.artifacts),
                        "--notes-file",
                        str(release.notes),
                        "--output",
                        str(output),
                        "--version",
                        release.version,
                        "--tag",
                        release.tag,
                        "--repository",
                        "theogmiguel/houston",
                    ]
                )
            self.assertEqual(status, 1)
            self.assertIn("Houston_1.2.3_amd64.deb", stderr.getvalue())


if __name__ == "__main__":
    unittest.main(verbosity=2)
