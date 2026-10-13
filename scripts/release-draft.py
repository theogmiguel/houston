#!/usr/bin/env python3
"""Preserve reviewed draft notes and synchronize the updater before publication."""
import argparse
import json
import re
from pathlib import Path
import subprocess
import sys


class Refused(RuntimeError):
    pass


def run(args):
    result = subprocess.run(args, text=True, capture_output=True, check=False)
    if result.returncode:
        raise Refused(f"{args[0]} failed: {result.stderr.strip()}")
    return result.stdout


def release(repository, tag):
    # The releases/tags endpoint answers 404 for drafts, so search the full list.
    result = subprocess.run(
        ["gh", "api", "--paginate", f"repos/{repository}/releases",
         "--jq", f".[] | select(.tag_name == {json.dumps(tag)})"],
        text=True, capture_output=True, check=False,
    )
    if result.returncode:
        raise Refused(f"Cannot inspect release {tag}: {result.stderr.strip()}")
    matches = result.stdout.splitlines()
    return json.loads(matches[0]) if matches else None


def require_draft(value, tag):
    if value is None or not value.get("draft"):
        raise Refused(f"Release {tag} must exist and remain a draft")
    return value


def notes(repository, tag, generated, output, resume):
    current = release(repository, tag)
    if current is not None:
        require_draft(current, tag)
        if not resume:
            raise Refused(f"Release {tag} already exists; use resume_tag")
        body = current.get("body", "") or ""
        if not body.strip():
            raise Refused(f"Draft {tag} has empty notes; edit its description before resuming")
    else:
        body = generated.read_text(encoding="utf-8")
    output.write_text(body, encoding="utf-8")


def file_draft(repository, tag, title, artifacts, notes_file, resume, prerelease):
    current = release(repository, tag)
    body = notes_file.read_text(encoding="utf-8").strip()
    if not body:
        raise Refused("Release notes must not be empty")
    files = sorted(path for path in artifacts.iterdir() if path.is_file())
    if not files or not (artifacts / "latest.json").is_file():
        raise Refused("Verified artifacts must include latest.json")
    if current is None:
        args = ["gh", "release", "create", tag, "--repo", repository,
                "--title", title, "--notes-file", str(notes_file), "--verify-tag", "--draft"]
        if prerelease:
            args.append("--prerelease")
        run(args + [str(path) for path in files])
        return
    require_draft(current, tag)
    if not resume:
        raise Refused(f"Release {tag} exists; replacement requires resume_tag")
    if bool(current["prerelease"]) != prerelease:
        raise Refused(f"Draft {tag} prerelease status differs from its tag")
    if (current.get("body") or "").strip() != body:
        raise Refused(f"Draft {tag} notes changed during this run; retry to preserve the edit")
    unexpected = {asset["name"] for asset in current["assets"]} - {path.name for path in files}
    if unexpected:
        raise Refused(f"Draft {tag} has unexpected assets {sorted(unexpected)}; preserve its platform set on resume")
    # The workflow serializes this with promotion using the same per-tag group.
    run(["gh", "release", "upload", tag, "--repo", repository, "--clobber"] + [str(path) for path in files])


def asset_identity(value, exclude_manifest=False):
    return sorted((a["id"], a["name"], a["size"], a.get("digest"), a["updated_at"])
                  for a in value["assets"] if not exclude_manifest or a["name"] != "latest.json")


def promote(repository, tag, assets, shipped_path, notes_path, output, config, snapshot_path):
    if output.name != "latest.json":
        raise Refused("The synchronized manifest must be named latest.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    before = require_draft(json.loads(snapshot_path.read_text(encoding="utf-8")), tag)
    body = before.get("body") or ""
    if not body.strip():
        raise Refused(f"Draft {tag} needs release notes before publication")
    shipped = json.loads(shipped_path.read_text(encoding="utf-8"))
    notes_path.write_text(body, encoding="utf-8")
    args = [sys.executable, str(Path(__file__).with_name("gen-update-manifest.py")),
            "--repository", repository, "--tag", tag, "--version", tag.removeprefix("v"),
            "--notes-file", str(notes_path), "--artifacts-dir", str(assets),
            "--output", str(output), "--tauri-config", str(config)]
    if not any(key.startswith("windows-") for key in shipped["platforms"]):
        args.append("--linux-only")
    run(args)
    regenerated = json.loads(output.read_text(encoding="utf-8"))
    for field in ("version", "platforms"):
        if shipped.get(field) != regenerated.get(field):
            raise Refused(f"Draft {tag} manifest {field} differs from the verified assets")
    regenerated["pub_date"] = shipped["pub_date"]
    output.write_text(json.dumps(regenerated, indent=2) + "\n", encoding="utf-8")
    latest = require_draft(release(repository, tag), tag)
    if latest.get("body") != before.get("body") or asset_identity(latest) != asset_identity(before) or latest["prerelease"] != before["prerelease"]:
        raise Refused(f"Draft {tag} changed during verification; retry publication")
    run(["gh", "release", "upload", tag, "--repo", repository, str(output), "--clobber"])
    current = require_draft(release(repository, tag), tag)
    if (current.get("body") != before.get("body") or current["prerelease"] != before["prerelease"]
            or asset_identity(current, exclude_manifest=True) != asset_identity(before, exclude_manifest=True)):
        raise Refused(f"Draft {tag} changed during synchronization; retry publication")
    args = ["gh", "release", "edit", tag, "--repo", repository, "--draft=false"]
    if before["prerelease"]:
        args.append("--prerelease")
    run(args)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="operation", required=True)
    for name in ("notes", "file", "promote", "check-resume", "snapshot"):
        cmd = sub.add_parser(name)
        cmd.add_argument("--repository", required=True)
        cmd.add_argument("--tag", required=True)
        if name in ("notes", "file"):
            cmd.add_argument("--resume", action="store_true")
        if name == "snapshot":
            cmd.add_argument("--output", type=Path, required=True)
        elif name == "notes":
            cmd.add_argument("--generated", type=Path, required=True)
            cmd.add_argument("--output", type=Path, required=True)
        elif name == "file":
            cmd.add_argument("--title", required=True)
            cmd.add_argument("--artifacts", type=Path, required=True)
            cmd.add_argument("--notes-file", type=Path, required=True)
            cmd.add_argument("--prerelease", action="store_true")
        elif name == "promote":
            cmd.add_argument("--snapshot", type=Path, required=True)
            cmd.add_argument("--assets", type=Path, required=True)
            cmd.add_argument("--shipped", type=Path, required=True)
            cmd.add_argument("--notes-file", type=Path, required=True)
            cmd.add_argument("--output", type=Path, required=True)
            cmd.add_argument("--tauri-config", type=Path, default=Path("src-tauri/tauri.conf.json"))
    args = parser.parse_args()
    try:
        if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+(?:-rc\.[0-9]+)?", args.tag):
            raise Refused(f"Invalid tag {args.tag!r}; expected vX.Y.Z or vX.Y.Z-rc.N")
        if args.operation == "snapshot":
            current = require_draft(release(args.repository, args.tag), args.tag)
            args.output.write_text(json.dumps(current), encoding="utf-8")
        elif args.operation == "notes":
            notes(args.repository, args.tag, args.generated, args.output, args.resume)
        elif args.operation == "file":
            file_draft(args.repository, args.tag, args.title, args.artifacts, args.notes_file, args.resume, args.prerelease)
        elif args.operation == "promote":
            promote(args.repository, args.tag, args.assets, args.shipped, args.notes_file, args.output, args.tauri_config, args.snapshot)
        else:
            current = release(args.repository, args.tag)
            if current is not None:
                require_draft(current, args.tag)
    except (Refused, ValueError, KeyError, OSError) as error:
        parser.exit(1, f"release-draft: {error}\n")


if __name__ == "__main__":
    main()
