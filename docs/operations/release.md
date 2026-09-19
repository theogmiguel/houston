# Releasing

## Two pipelines

There are two pipelines under `.github/workflows/`, and only one of them
ships anything:

- **`ci.yml`** is the gate. It runs four jobs — `safety-checks` (the
  hermetic text-search scripts), `renderer-checks` (`ui`'s `bun run
  typecheck` and `bun run test`), `core-checks` (`cargo fmt`, `cargo
  clippy`, `cargo test --lib`, against `core/Cargo.toml`) and
  `licence-inventory` (the committed third-party inventory still matches
  both dependency graphs) — on every pull
  request, and on every push to `main` except a docs-only change. The
  integration suites, the `src-tauri` gates and the load-sensitive gates
  still run locally by whoever lands the work, per
  [`docs/operations/development.md`](development.md). `ci.yml` never builds
  an installer and never reads or bumps a version. Push to `main` as often as
  you like; no release comes out of it.
- **`release.yml`** is the release. It runs only on a `v*` tag push, or by
  hand (`gh workflow run release.yml`, `dry_run=true` builds without filing a
  release). It builds both Linux architectures (x86_64 and aarch64) and the
  Windows NSIS installer, then files a **draft** GitHub Release.
- **`release-publish.yml`** is the one place that files a release, called by
  every release workflow. It refuses a bundle set that is missing an artifact
  or its `.sig`, generates the release notes once and reuses them, and writes
  `latest.json` with each signature embedded. A real release refuses to build
  without the updater signing secrets; only a dry run builds unsigned.

So "a new commit on main" and "a new version" are different acts. The only
thing that releases is a tag matching the manifest version, pushed on
purpose. Never push a `v*` tag casually; nothing else in the repo can undo
the build it starts.

## The rule: PRs land work, a release names a version

Every change reaches `main` through a pull request, merged once
`safety-checks` is green and the author has run the full local gates
(`docs/operations/development.md`). Branch protection requires a pull request
and the four CI jobs before `main` can move.

A version means an installable artifact, nothing less. Feature PRs therefore
never bump a version, and nobody writes release notes by hand: the notes for a
release are generated from the merged pull requests at cut time. A PR's title
is the note its reader gets, so it is written in user voice.

When it is time to ship, one **Cut release** run does the whole bump and
nothing else — see "How a release happens" below. Ten PRs and one release in a
week is the normal shape; traceability comes from the PR number on every merge
commit, not from a version number nobody can install.

## Versions

Four files carry the version, and `release.yml`'s `version-guard` job checks
they agree before anything builds:

- `src-tauri/tauri.conf.json` (`.version`) — the bundle filenames and the
  deb/NSIS metadata come from here
- `src-tauri/Cargo.toml` (`version`) — the app crate
- `ui/package.json` (`.version`) — the renderer
- `core/Cargo.toml` (`[workspace.package] version`) — inherited by every core
  crate, `tr-helper` included

On a tag push, `GITHUB_REF_NAME` stripped of its `v` prefix must equal them
too.

Nothing in the tree forces the four to track each other, so **nothing edits
them by hand**:

```
./scripts/set-version.sh 0.11.0
```

writes all four plus both `Cargo.lock` files in one go, and refuses a string
that is not `X.Y.Z` or `X.Y.Z-rc.N` before it writes anything. The lockfiles
are updated with `cargo update --workspace`, which rewrites the workspace
crates' own entries and no dependency, so a version bump can never become a
dependency bump by accident. `version-guard` stays as the check that nothing
drifted afterwards.

The guard reads `core/Cargo.toml`'s version *scoped to the
`[workspace.package]` table* — an unscoped first-match read would pick up a
`version = ` line under `[workspace.dependencies]` instead.

Tag format: `v*` (e.g. `v0.6.0`), matching `on: push: tags: ['v*']`.

## Release notes

When a release is cut, `release-publish.yml` calls GitHub's `generate-notes`
API once for that tag, starting the range at the previous stable tag, and
writes the answer to a notes file. That one file is the release body *and* the
`notes` field in `latest.json`, so the two surfaces cannot disagree. If GitHub
returns an empty body the run warns and uses one plain fallback line rather
than filing a blank description.

The notes are only as good as the merged PRs: GitHub lists each one by its
title, and the body is not part of the generated notes. A title is therefore
the copy a reader sees on the release page.

## How a release happens

Run **Cut release** from the Actions tab. That is the whole procedure.

| Input | Value |
|---|---|
| `kind` | `patch`, `minor`, `major` or `rc` |
| `ref` | what to cut from; `main` by default |

It reads the tags to decide the next version, writes it with
`scripts/set-version.sh`, commits, tags, pushes, builds every bundle job in
parallel and files a **draft** release whose body is the generated notes. Then
you download the artifacts, install and run them, and publish the draft
yourself — see "Smoke-test the bundle" below. A draft is where every release
stops until a person has run it.

Before `publish` runs, the Linux bundle workflow boots the built x86_64 AppImage
on Ubuntu 22.04, Ubuntu 24.04, Debian 12 and current Fedora, headlessly: each
job installs only the runtime libraries a desktop install already has, extracts
the AppImage and runs `--version`, so a missing host dependency or a build that
overran the glibc floor fails there. It runs for every caller — cut, tag push
and nightly — and `publish` waits for it. A graphical run is still a person's
job: a runner has no display.

Before any of that, it refuses a run whose secrets are missing. A real release
needs `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to sign its artifacts, plus
`RELEASE_PUSH_SSH_KEY` to write the version commit through protected `main`.
The run stops before the version is computed and before anything is pushed.

**What it refuses, and why each refusal exists.**

- **Missing updater signing secrets.** A release nobody can verify is not a
  release; the error names the missing secret and where to set it.
- **Missing release push key.** The version commit cannot bypass protected
  `main` without the dedicated deploy key, so the cut stops before it creates
  a commit or tag.
- **A stable that is not strictly greater than the latest stable tag.** The
  arithmetic alone would not catch a repository whose tags and manifests have
  drifted, so the comparison is explicit and the error names the computed
  version, the latest stable and the `kind` that was asked for.
- **A tag that already exists.** A tag is the one act here that nothing can
  undo; re-cutting one silently would be the worst way to find that out.
- **A stable from anything but the tip of `main`.** A release candidate may
  come off a side ref — that is what candidates are for — but a stable is cut
  from `main`'s tip and nothing else.
- **Moving `main` from a ref that is not its tip.** When the cut ref is not
  `main`'s current commit, the workflow pushes the tag and nothing else, and
  says so in the run summary. `main` is never fast-forwarded from somewhere
  else and is never force-pushed, under any input.
- **A half-pushed stable cut.** The version commit and its tag are one atomic
  push, so a rejected ref leaves neither one behind on the remote.
- **An incomplete or mismatched artifact set.** `release-publish.yml` refuses
  a bundle with no `.sig`, either official Linux architecture missing its
  AppImage or deb, the Windows x86_64 installer missing, a filename from
  another version, and any file the release does not expect; the error names
  the offending file and what was expected.

An `rc` continues an open series rather than starting a new one: if a
`vX.Y.Z-rc.N` exists whose base is above the latest stable, the next is
`-rc.(N+1)` on that same base. With no open series it starts at the next minor,
`-rc.1`. The notes for a candidate span the last stable tag to the candidate.

An `rc` is filed as a **prerelease** (and still as a draft, until a person
smoke-tests it). Publishing a candidate as a normal release would make
`releases/latest` offer it to every stable install, so the flag follows the
`kind` that was asked for — or, for a hand-pushed `v*-rc.*` tag, the version's
own `-rc.` suffix.

**Why the tag carries a workflow marker:** Cut release pushes through its
deploy key so it can update protected `main`. Unlike `GITHUB_TOKEN`, that push
does trigger `release.yml`. The annotated tag therefore carries
`Managed-By: cut-release`; the triggered workflow verifies the tag and exits,
while the Cut release run owns the one set of builds and the publication.

`release.yml` is still there and still fires on a `v*` tag pushed by a person,
which is the path a release cut by hand takes.

Pushing a `v*` tag triggers a real run, so don't push one before you mean it.
To exercise the build without cutting a release, run the workflow from the
Actions tab with `dry_run=true` (the default for a manual run): both bundle
workflows run and upload their artifacts, and `publish` is skipped.

### One workflow file per OS

| File | Holds | Trigger |
|---|---|---|
| `release.yml` | `version-guard`, the two `workflow_call`s, `publish` | `v*` tag, or manual |
| `cut-release.yml` | `prepare` (version, commit, tag, push), the two `workflow_call`s, `publish` | manual |
| `nightly.yml` | `guard`, the two `workflow_call`s, `roll`, `publish` | schedule, or manual |
| `release-linux.yml` | the AppImage and `.deb` bundle jobs, one per architecture, plus the headless AppImage smoke matrix | `workflow_call` only |
| `release-windows.yml` | the NSIS `.exe` bundle job | `workflow_call` only |
| `release-publish.yml` | the `publish` job all three callers share | `workflow_call` only |

Each OS file is self-contained: it declares its own runner pins, its own
toolchain, its own caches and its own pinned Tauri CLI version, and takes the
release version as an input. That is the point of the split — one OS's build
can be re-run on its own after a flake without paying for the other, and a
change to the Linux packaging cannot accidentally move the Windows one.

The two bundle workflows only read the tree and upload artifacts, so they
carry the narrowest permissions they need; they receive the signing secrets
through `secrets: inherit`. `release-publish.yml` is the one job that writes
anything outward-facing, and it writes a draft for a stable cut and a
prerelease for the nightly.

### Nightly

`nightly.yml` builds `main` once a day at 03:37 UTC — off the hour and off
midnight, where GitHub's shared cron queue is contended — and by hand from the
Actions tab. It refuses to run anywhere but this repository, so a fork that
copied the tree does not start publishing nightlies.

It republishes one rolling `nightly` tag and one `nightly` **prerelease**,
replacing both each night. Prerelease is not a detail: Houston's stable check
reads `releases/latest`, which is documented to skip prereleases, so a nightly
published any other way would be offered to every user on stable. The nightly
channel fetches `releases/tags/nightly` by name for the same reason.

The tag moves only after every bundle job succeeds. The release itself is
replaced by the publish job, and only after the notes and `latest.json` have
been generated and verified — so a failed build, a failed notes call or a
manifest refusal all leave last night's release and its assets in place instead
of a gap. The first night has no previous tag or release; both steps say so and
carry on, and the notes fall back to everything since the last stable tag (or
the first commit). If the replacement itself is interrupted between its delete
and its create, re-running the failed jobs files it; the bundles are still
attached to the run.

A nightly is signed like any other release: it carries the same per-artifact
`.sig` files and its own `latest.json`, and the guard refuses the run without
the updater secrets rather than publishing a manifest nothing can verify.

Moving that tag is the one place in this repository where a ref that already
exists is moved, and it is safe only because `nightly` is not a version anybody
installs by name. `main` is never force-pushed by anything.

A user opts in at Settings ▸ About ▸ Channel. An unrecognised or absent stored
value reads as stable, so nothing puts somebody on untested builds by accident.

The rolling tag does not carry a version, so its release title has the exact
shape `Houston nightly <version>`. The version includes the build's short commit
SHA; after installation the running build recognises that suffix and does not
offer the same nightly again. A moved nightly at the same base version remains
a different release and is offered normally.

### Windows signing: two paths, one secret

The installer gets two independent signatures. The updater one is not optional:
every real release signs the `.exe` with the Minisign key and publishes the
`.sig`, and without it `latest.json` cannot be built at all. The Authenticode
one is the optional half, and `release-windows.yml` takes one path or the other
on the presence of a single secret, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`:

- **Absent** — the installer is built unsigned, SmartScreen warns on first run,
  and the job summary says so and names the missing secret. This is the
  documented normal state and it never fails the build. `README.md` and
  `docs/user/install.md` tell downloaders to expect the warning.
- **Present** — `azure/trusted-signing-action` signs the bundled `.exe` in
  place. That rewrites the file's bytes, which is why the order matters:
  Authenticode first, then `cargo tauri signer sign` for the updater. A
  Minisign signature over the pre-Authenticode bytes would never verify, so a
  stale `.sig` is removed before the updater signs. Both paths produce the
  same `.exe` and `.exe.sig` names, and nothing downstream changes.

**The maintainer's decision**, and the only one: whether to buy Azure Trusted
Signing. It is the cheaper of the two ways to get a signature a fresh Windows
install trusts — the other is an EV certificate from a CA, which needs an
organisation, costs several times more and arrives on a hardware token that a
CI runner cannot hold. Trusted Signing needs an Azure subscription and an
identity validation, and it is billed monthly whether or not a release is cut.

Turning it on is six secrets and nothing else: `AZURE_TENANT_ID`,
`AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TRUSTED_SIGNING_ENDPOINT`,
`AZURE_TRUSTED_SIGNING_ACCOUNT_NAME` and
`AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`. No file in the tree changes.
Choosing not to buy it is a decision too, and it is the one in force: the tree
is wired for both and running the unsigned one.

### Houston checks for a release; you click to install it

The daemon asks the releases API once at start, once a day, and whenever the
About panel's **Check now** is pressed, and broadcasts what it found. The panel
names the release, shows a teaser of its notes and links to the release page.

**Install update** is the other half: the app fetches the channel's fixed
manifest (`releases/latest/download/latest.json` on stable,
`releases/download/nightly/latest.json` on nightly), picks the entry for this
exact bundle (`linux-x86_64-deb`, `linux-x86_64-appimage`, `windows-x86_64-nsis`),
downloads it, verifies the artifact's signature against the public key in
`src-tauri/tauri.conf.json`, and installs. It refuses by name when the manifest
publishes nothing for this bundle, when the signature does not verify, when the
manifest's version is no longer the one the panel showed, and — on Windows —
when the channel's daemon has live sessions, because the installer replaces the
`houston-core.exe` they run on.

On Linux a deb install runs the system package manager's usual privileged
install, and the app then asks the running daemon to hand its sessions to the
newly installed `houston-core`; a handoff the daemon refuses leaves every
session on the current daemon and says why. An AppImage install replaces the
running file and relaunches into the new mount. On Windows the NSIS installer
runs; the progress and the outcome appear in the panel. Nothing installs
without a click, and nothing unsigned or unverifiable installs at all.

**Getting the keypair in place** is one maintainer sitting, and releases do not
run without it:

1. `cargo tauri signer generate -w ~/.houston-updater.key`, with a passphrase.
   It prints a public key and writes a private key. The private key never
   enters the repository and never leaves the maintainer's keychain or password
   manager.
2. Repository → Settings → Secrets and variables → Actions: add
   `TAURI_SIGNING_PRIVATE_KEY` (the file's contents) and
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (the passphrase). Every release
   workflow refuses a run without them — a cut stops before it pushes anything,
   and nightly fails rather than publishing an unsigned manifest.
3. Paste the **public** key into `src-tauri/tauri.conf.json` under
   `plugins → updater → pubkey` (a public key is not a secret and belongs in
   the tree). If the committed key and the signing secret are a different pair,
   the bundler only warns — the first end-to-end update is what proves them.

### Public update feed

The updater uses public release assets at
`https://github.com/theogmiguel/houston/releases/latest/download/latest.json`
(stable) and `.../download/nightly/latest.json` (nightly). Each published
release attaches `latest.json` with the signatures of its release artifacts,
so installed copies can select and verify the matching installer. The first published release establishes this
feed; an end-to-end update is exercised by installing that release and moving
to a subsequent stable release or nightly.

What every release carries:

1. The bundle workflows sign what they build. On Windows that is
   `cargo tauri signer sign` after the optional Authenticode step; on Linux the
   bundler signs the AppImage and the deb as it writes them, and the workflow
   signs any it left unsigned.
2. `release-publish.yml` verifies the set — one AppImage family and one deb for
   Linux x86_64 and ARM64, one Windows x86_64 NSIS installer, a `.sig` beside
   each, every filename carrying the release's version — and refuses anything
   else.
3. `latest.json` embeds each `.sig` file's contents under both the bare
   `linux-<arch>` / `windows-<arch>` key and the bundle-specific
   `-appimage`, `-deb` and `-nsis` keys, so a deb install and an AppImage
   install each resolve their own payload.
4. The manifest is published as a release asset, which is what makes the two
   URLs above resolvable.

### Repository settings a maintainer sets by hand

None of these live in the tree; they are GitHub settings, and a fresh clone of
the repo does not carry them.

- **Branch protection on `main`**: require a pull request, and require the
  status checks `safety-checks`, `renderer-checks`, `core-checks` and
  `licence-inventory`. Every pull request must run all four — a required check
  that never runs stays pending and blocks the merge for ever, which is why
  `ci.yml` no longer skips jobs on a docs-only change. Give deploy keys the
  ruleset bypass; do not give users one. **Cut release** authenticates with the
  sole write-enabled deploy key and remains the only path around the PR rule.
- **Discussions**: on, with an **Ideas** category. Feature requests are routed
  there by `.github/ISSUE_TEMPLATE/config.yml`, which points at it by URL.
- **Private vulnerability reporting**: on. `SECURITY.md` sends reporters to the
  advisory form, and that form only exists once the setting is enabled.
- **Description, homepage and topics**: set all three so the repository is
  identifiable in search and its metadata matches the project page.
- **Release push key.** Generate a dedicated Ed25519 key with no passphrase,
  add its public half as the write-enabled deploy key `Houston Cut release`,
  and store its private half as the Actions secret `RELEASE_PUSH_SSH_KEY`.
  Remove both halves together when rotating it.
- **Secrets.** `TAURI_SIGNING_PRIVATE_KEY` and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` are **required**: every release workflow
  refuses a run without them, because a release without a verifiable signature
  is not a release. The six `AZURE_TRUSTED_SIGNING_*` / `AZURE_*` values are
  optional and turn on Authenticode signing of the Windows installer; with
  none of them set, the installer carries the updater signature only and
  SmartScreen still warns on first run.

## Fallback: cut locally

When hosted release automation is unavailable, build and publish locally. The
tag still uses the `v*` shape, so a later workflow re-run targets the same
release:

### 1. Gate it

Linux, from a Windows host, via the WSL2 testbed:

```
./scripts/linux-vm.sh gate
```

Or natively on Linux, the same commands `docs/operations/development.md` names for
`core`/`src-tauri`/`ui`.

`linux-vm.sh gate` runs seven of the twenty-five CI safety scripts. It does
not replace the complete local gate in
[`docs/operations/development.md`](development.md); a release must run the
remaining checks as well.

Windows: natively, the same `cargo test && cargo clippy --all-targets -- -D
warnings && cargo fmt` / `bun run typecheck && bun run test && bun run build
&& bun run check:css` commands — typed by hand, not wrapped in a script.

### 2. Build artifacts

Linux, via the testbed:

```
./scripts/linux-vm.sh build
./scripts/linux-vm.sh wait build
```

This calls `scripts/build-app.sh --bundles appimage,deb` on the VM. Use that
script rather than invoking `cargo tauri build` directly: it builds the
renderer, checks generated protocol bindings and stages every required Linux
sidecar before bundling.

**The testbed's distro is the artifact's glibc floor.** It defaults to Ubuntu
24.04, which builds bundles needing glibc 2.38 or newer — AppImage included,
because the bundler copies the host's libraries — and that breaks the promise
CI keeps by building on 22.04. Before a local cut, gate the result from the
repo root inside the VM:

```
./scripts/check-linux-abi.sh <deb> x86_64
```

It refuses a too-new bundle and prints the symbol versions that caused it. A
`LINUX_VM_DISTRO=Ubuntu-22.04` testbed is the other way to keep the floor.

`build-app.sh`, unpacked:

1. Re-execs itself under `scripts/oom-shield.sh` (`-j 3`) unless already
   shielded, so the **whole pipeline** — renderer build included — is one
   serialized unit. Concurrent runs can race while `vite build` applies
   `emptyOutDir: true`.
2. `cd ui && bun run build` (unless `--skip-renderer`).
3. `./scripts/check-renderer-fresh.sh` — unconditional, not skippable by any
   flag.
4. Builds and stages `tr-helper`, `houston-core` and `houston-supervisor` at
   `src-tauri/binaries/<name>-<host target triple>`, where Tauri's
   `bundle.externalBin` expects them. This runs **before** the bundle: a
   missing external binary fails the `src-tauri` build outright.
5. `CARGO_BUILD_JOBS=3 cargo tauri build --bundles <targets>`, then copies the
   un-suffixed helper beside the app binary in `target/release` for the
   un-bundled dev layout and for `install-desktop.sh`.

Bundle output: `src-tauri/target/release/bundle/{appimage,deb}/*.{AppImage,deb}`.

Windows:

```
./scripts/build-app.ps1
cargo tauri build --bundles nsis      # documented extra step
```

`build-app.ps1` runs the full renderer gate (`typecheck`, `test`, `build`,
`check:css`), the same `check-renderer-fresh.sh` via Git Bash, stages
`tr-helper.exe` and `houston-core.exe` under `src-tauri\binaries` with the
host target triple (before the app build, for the same reason the bash script
does), then `cargo build --release` (`CARGO_BUILD_JOBS=6`) and copies
`houston-tauri.exe` → `houston.exe`. It stops short of bundling by
design — the NSIS step above is the documented extra.

Bundle output: `src-tauri/target/release/bundle/nsis/*.exe`.

### 3. Smoke-test the bundle

A stable cut creates only a **draft**. CI now proves the built x86_64 AppImage
*loads and answers* on the four distributions above, but not that the window
opens: runners are headless, so no webview ever initializes there. Manual
smoke-test is a hard requirement before publishing or handing anything out,
local release or not: install the artifact and run it (`./scripts/linux-vm.sh
app` on the testbed) first.

### 4. Publish

A local cut signs its bundles the same way CI does, so the two secrets have to
be in the environment when the build runs (`TAURI_SIGNING_PRIVATE_KEY`,
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) — on the VM too, since the Linux build is
where the `.sig` files come from. Then generate the notes once, build the
manifest from the files the bundles produced, and file the release with the
same body `latest.json` carries:

```bash
release_tag=v0.10.0
release_version=${release_tag#v}

notes=$(gh api --method POST \
  "repos/theogmiguel/houston/releases/generate-notes" \
  -f tag_name="$release_tag" --jq '.body // ""')
printf '%s\n' "$notes" > /tmp/houston-notes.md

python3 scripts/gen-update-manifest.py \
  --repository theogmiguel/houston --tag "$release_tag" \
  --version "$release_version" \
  --notes-file /tmp/houston-notes.md \
  --artifacts-dir <artifacts-dir> --output <artifacts-dir>/latest.json

gh release create "$release_tag" --draft \
  --notes-file /tmp/houston-notes.md <artifacts-dir>/*
```

Add `--prerelease` for an `rc` — the same rule the workflow applies — or
publishing the draft would offer a candidate through `releases/latest`.

Fully manual, and the same work `release-publish.yml` does — including its
refusals: the manifest script rejects a set with a missing `.sig`, a missing
architecture or a filename from another version, so the release never ships a
manifest the updater cannot use.

## `install-desktop.sh`

The local-install step, separate from packaging:

```
./scripts/install-desktop.sh
```

Refuses, in order, on:

- Missing icon SVG or `convert` (ImageMagick).
- Missing app binary at `src-tauri/target/release/houston` (told to run
  `build-app.sh`).
- **Renderer staleness** — re-runs `check-renderer-fresh.sh`.
- **Binary staleness** — re-runs `check-binary-fresh.sh` (mtime-compares the
  binary against the Rust source, `Cargo.toml`/`Cargo.lock`, and
  `tauri.conf.json`).
- **Repo-path leak** — after writing `launch.sh`, `start.sh`, and the
  `.desktop` file into `~/.local/lib/houston/` and
  `~/.local/share/applications/`, greps all three for the repo's own
  absolute path and refuses to finish if found. This is what keeps the
  installed app from ever executing a path inside the repo — an ordinary
  `cargo build --release` in this tree must never be able to relink what the
  installed app runs.

Installs: `~/.local/lib/houston/{houston, tr-helper, houston-core,
houston-supervisor, start.sh, launch.sh}`,
`~/.local/share/applications/houston.desktop`
(`StartupWMClass=houston`), and icon PNGs at 48/64/128/256/512px under
`~/.local/share/icons/hicolor/**/apps/houston.png`.

## `tr-helper`

A slim agent-facing helper binary serving only `hook` — `hs-mail` (the
file-based inter-pane IPC it used to serve) is retired; messages between
panes are inbox rows delivered through `pane_submit`/`hs-pane` instead. Built
separately from `core/Cargo.toml` and copied beside the app binary. It links
~6 shared objects against the full app binary's ~130 (GTK/WebKit/GStreamer),
avoiding a 20–40 ms / ~38 MB dynamic-link cost per hook event. Its copy is
best-effort in `install-desktop.sh` (warns, not fatal, if missing — the
resolver falls back to the full app binary).

It **is** bundled. `tauri.conf.json` declares
`"bundle": { "externalBin": ["binaries/tr-helper", "binaries/houston-core"] }`, so Tauri picks up
`src-tauri/binaries/tr-helper-<target triple>[.exe]` (the suffix is the
convention — Tauri appends the triple when it looks, and strips it again when
it installs) and drops it beside the app binary in every bundle:
`/usr/bin/tr-helper` next to `/usr/bin/houston` in the deb, `usr/bin/` inside
the AppImage mount, the install dir under NSIS. Each of those is the directory
`agent_helper_exe` stats, so the resolver needs to know nothing about
packaging. Nothing is uploaded loose any more.
