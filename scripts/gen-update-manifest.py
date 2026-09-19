#!/usr/bin/env python3
"""Write latest.json for one release, or refuse the artifact set it was given.

The publish stage runs this after both bundle workflows have uploaded: every
bundle must arrive with the Minisign .sig its own build produced, every
filename must carry the release's version, and anything unrecognised is a
refusal rather than a silent omission. The release notes come from the same
file the same run filed on the GitHub Release, so body and manifest agree.
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

# Debian bundle arch names differ from the platform key's (amd64 -> x86_64).
ARCHES = {
    "amd64": "x86_64",
    "x64": "x86_64",
    "aarch64": "aarch64",
    "arm64": "aarch64",
    "armv7": "armv7",
    "armhf": "armv7",
    "i686": "i686",
    "i386": "i686",
}
EXPECTED_LINUX_ARCHES = {"x86_64", "aarch64"}
EXPECTED_WINDOWS_ARCHES = {"x86_64"}

# Order matters: the .tar.gz suffix is the AppImage updater payload in Tauri's
# v1-compatible mode and would otherwise be read as an unknown artifact.
BUNDLES = (
    (
        "appimage_tar",
        re.compile(
            r"^Houston_(?P<version>[^_]+)_(?P<arch>amd64|aarch64|armv7|i686)\.AppImage\.tar\.gz$"
        ),
    ),
    (
        "appimage",
        re.compile(
            r"^Houston_(?P<version>[^_]+)_(?P<arch>amd64|aarch64|armv7|i686)\.AppImage$"
        ),
    ),
    (
        "deb",
        re.compile(
            r"^Houston_(?P<version>[^_]+)_(?P<arch>amd64|arm64|i386|armhf)\.deb$"
        ),
    ),
    (
        "nsis",
        re.compile(r"^Houston_(?P<version>[^_]+)_(?P<arch>x64|arm64)-setup\.exe$"),
    ),
)

VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$")
REPOSITORY_RE = re.compile(r"^[^/\s]+/[^/\s]+$")
TAG_RE = re.compile(r"^[0-9A-Za-z._+-]+$")


class Refused(Exception):
    """The artifact set or an argument cannot describe a publishable release."""


class Bundle:
    def __init__(self, kind: str, path: Path, version: str, arch: str):
        self.kind = kind
        self.path = path
        self.version = version
        self.arch = arch

    @property
    def name(self) -> str:
        return self.path.name


def match_bundle(name: str):
    for kind, pattern in BUNDLES:
        found = pattern.match(name)
        if found:
            return kind, found.group("version"), ARCHES[found.group("arch")]
    return None


def read_signature(path: Path) -> str:
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        raise Refused(
            f"{path.name} is empty; expected the Minisign signature the bundle build writes beside its bundle"
        )
    try:
        decoded = base64.b64decode("".join(text.split()), validate=True)
    except Exception:
        raise Refused(
            f"{path.name} is not base64; expected the content of the .sig file Tauri's signer writes"
        ) from None
    if not decoded.startswith(b"untrusted comment:"):
        raise Refused(
            f"{path.name} is not a Minisign signature (decoded to {decoded[:24]!r}); expected an `untrusted comment:` header"
        )
    return text


def collect(
    artifacts: Path, version: str, signatures: dict[str, str]
) -> tuple[dict[str, dict[str, Bundle]], dict[str, Bundle]]:
    artifact_version = version.split("+", 1)[0]
    linux: dict[str, dict[str, Bundle]] = {}
    windows: dict[str, Bundle] = {}
    sig_names: set[str] = set()

    for path in sorted(artifacts.iterdir()):
        if not path.is_file():
            continue
        if path.name == "latest.json":
            raise Refused(
                f"{path.name} is already in the artifact set; the publish stage generates it and will not ship a second copy"
            )
        if path.name.endswith(".sig"):
            sig_names.add(path.name[: -len(".sig")])
            signatures[path.name[: -len(".sig")]] = read_signature(path)
            continue
        found = match_bundle(path.name)
        if found is None:
            raise Refused(
                f"unrecognised artifact {path.name}; expected only Houston_<version>_<arch>.AppImage, "
                f"Houston_<version>_<arch>.deb, Houston_<version>_<arch>-setup.exe, their .sig files, and nothing else"
            )
        kind, file_version, arch = found
        if file_version != artifact_version:
            raise Refused(
                f"{path.name} carries version {file_version}, but this release is {version}; "
                f"every filename must carry {artifact_version}"
            )
        bundle = Bundle(kind, path, file_version, arch)
        if kind == "nsis":
            if arch in windows:
                raise Refused(
                    f"two Windows NSIS installers for {arch}: {windows[arch].name} and {path.name}; expected one"
                )
            windows[arch] = bundle
        else:
            by_kind = linux.setdefault(arch, {})
            if kind in by_kind:
                raise Refused(
                    f"two {kind} bundles for {arch}: {by_kind[kind].name} and {path.name}; expected one"
                )
            by_kind[kind] = bundle

    every = [b for by_kind in linux.values() for b in by_kind.values()] + list(windows.values())
    missing_sigs = sorted(b.name for b in every if b.name not in sig_names)
    if missing_sigs:
        raise Refused(
            f"no signature for {', '.join(missing_sigs)}; expected <bundle>.sig beside each bundle, written by a build with the updater key"
        )
    orphan_sigs = sorted(sig_names - {b.name for b in every})
    if orphan_sigs:
        raise Refused(
            f"signature without a bundle: {', '.join(orphan_sigs)}.sig; the artifact set is incomplete"
        )

    problems = []
    for arch in sorted(EXPECTED_LINUX_ARCHES - linux.keys()):
        problems.append(f"missing the Linux bundles for {arch}")
    for arch in sorted(EXPECTED_LINUX_ARCHES & linux.keys()):
        by_kind = linux[arch]
        if not {"appimage", "appimage_tar"} & by_kind.keys():
            problems.append(f"missing the Linux AppImage for {arch}")
        if "deb" not in by_kind:
            problems.append(f"missing the Linux .deb for {arch}")
    for arch in sorted(EXPECTED_WINDOWS_ARCHES - windows.keys()):
        problems.append(f"missing the Windows NSIS setup .exe for {arch}")
    unexpected_linux = sorted(linux.keys() - EXPECTED_LINUX_ARCHES)
    unexpected_windows = sorted(windows.keys() - EXPECTED_WINDOWS_ARCHES)
    if unexpected_linux:
        problems.append(f"unsupported Linux architecture(s) {', '.join(unexpected_linux)}")
    if unexpected_windows:
        problems.append(f"unsupported Windows architecture(s) {', '.join(unexpected_windows)}")
    if problems:
        raise Refused(
            f"invalid artifact set: {', '.join(problems)}; a release carries every official platform's bundle"
        )
    return linux, windows


def assemble(
    *,
    artifacts_dir: Path,
    notes_file: Path,
    version: str,
    tag: str,
    repository: str,
    pub_date: str | None = None,
) -> dict:
    if not VERSION_RE.match(version):
        raise Refused(f"version {version!r} is not semver; expected MAJOR.MINOR.PATCH with optional -rc.N or +build metadata")
    if not REPOSITORY_RE.match(repository):
        raise Refused(f"repository {repository!r} is not owner/name; expected e.g. theogmiguel/houston")
    if not TAG_RE.match(tag):
        raise Refused(f"tag {tag!r} is not a URL-safe git tag; expected e.g. v0.11.0 or nightly")

    signatures: dict[str, str] = {}
    linux, windows = collect(artifacts_dir, version, signatures)

    notes = notes_file.read_text(encoding="utf-8").strip()
    if not notes:
        raise Refused(
            f"{notes_file.name} is empty; expected the generated release notes the release body carries"
        )

    def entry(bundle: Bundle) -> dict:
        return {
            "signature": signatures[bundle.name],
            "url": f"https://github.com/{repository}/releases/download/{tag}/{quote(bundle.name, safe='')}",
        }

    platforms: dict[str, dict] = {}
    for arch in sorted(linux):
        by_kind = linux[arch]
        appimage = by_kind.get("appimage_tar") or by_kind["appimage"]
        platforms[f"linux-{arch}"] = entry(appimage)
        platforms[f"linux-{arch}-appimage"] = entry(appimage)
        platforms[f"linux-{arch}-deb"] = entry(by_kind["deb"])
    for arch in sorted(windows):
        platforms[f"windows-{arch}"] = entry(windows[arch])
        platforms[f"windows-{arch}-nsis"] = entry(windows[arch])

    if pub_date is None:
        pub_date = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "version": version,
        "notes": notes,
        "pub_date": pub_date,
        "platforms": platforms,
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts-dir", type=Path, required=True)
    parser.add_argument("--notes-file", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--pub-date", default=None)
    args = parser.parse_args(argv)

    try:
        manifest = assemble(
            artifacts_dir=args.artifacts_dir,
            notes_file=args.notes_file,
            version=args.version,
            tag=args.tag,
            repository=args.repository,
            pub_date=args.pub_date,
        )
    except Refused as refused:
        print(f"error: {refused}", file=sys.stderr)
        return 1

    args.output.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(
        f"{args.output}: {manifest['version']} for {len(manifest['platforms'])} platform keys "
        f"({', '.join(manifest['platforms'])})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
