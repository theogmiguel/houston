# Releasing

## The workflows

Seven workflow files under `.github/workflows/`, in the order a release passes
through them:

| File | What it is | Trigger |
|---|---|---|
| `ci.yml` | the gate; never builds an installer, never reads a version | PR, and push to `main` |
| `cut-release.yml` | the cut: version, commit, tag, builds, files a **draft** | manual |
| `release-linux.yml` | AppImage and `.deb` per architecture, plus the headless smoke matrix | `workflow_call` |
| `release-windows.yml` | the NSIS installer | `workflow_call` |
| `release-publish.yml` | the one job that files a draft release and writes `latest.json` | `workflow_call` |
| `publish-draft.yml` | promotes a smoke-tested draft to public | manual, reviewed |
| `build-installers.yml` | builds both OSes and files nothing | manual |

Only **`publish-draft.yml`** makes a release visible. A merge to `main` ships
nothing, and pushing a `v*` tag by hand now does nothing at all.

**`ci.yml`** runs four jobs — `safety-checks` (the hermetic text-search
scripts), `renderer-checks` (`ui`'s `bun run typecheck` and `bun run test`),
`core-checks` (`cargo fmt`, `cargo clippy`, `cargo test --lib`, against
`core/Cargo.toml`) and `licence-inventory` (the committed third-party inventory
still matches both dependency graphs) — on every pull request, and on every
push to `main` except a docs-only change. The integration suites, the
`src-tauri` gates and the load-sensitive gates still run locally by whoever
lands the work, per [`docs/operations/development.md`](development.md).

**`build-installers.yml`** is the manual dry run: it builds both Linux
architectures and the Windows NSIS installer from any ref you name, and files
nothing. Since `ci.yml` never builds an installer, it is the only way to
exercise the bundle pipeline without cutting a version.

**`release-publish.yml`** refuses a bundle set that is missing an artifact or
its `.sig`, generates the release notes once and reuses them, and writes
`latest.json` with each signature embedded. It files a draft, never a public
release.

**Stable releases currently ship Linux only.** The Windows installer is not at
parity, so `cut-release.yml`'s `include_windows` defaults off: a Windows
install is offered no update, and its updater reports that the release carries
no installer for its platform. Ticking `include_windows` still works, and the
default flips back once a Windows cut reaches parity.

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

Four files carry the version, and `build-installers.yml`'s `version-guard` job
checks they agree before it builds anything:

- `src-tauri/tauri.conf.json` (`.version`) — the bundle filenames and the
  deb/NSIS metadata come from here
- `src-tauri/Cargo.toml` (`version`) — the app crate
- `ui/package.json` (`.version`) — the renderer
- `core/Cargo.toml` (`[workspace.package] version`) — inherited by every core
  crate, `tr-helper` included

Nothing in the tree forces the four to track each other, so **nothing edits
them by hand**:

```
./scripts/set-version.sh 0.11.0
```

writes all four plus both `Cargo.lock` files in one go, and refuses a string
that is not `X.Y.Z` or `X.Y.Z-rc.N` before it writes anything. The lockfiles
are updated with `cargo update --workspace`, which rewrites the workspace
crates' own entries and no dependency, so a version bump can never become a
dependency bump by accident.

`scripts/check-manifest-versions.sh` is the check that nothing drifted: it
reads the four, refuses an empty or disagreeing set, and prints the agreed
version. `build-installers.yml`'s `version-guard` job runs it, and a resumed
cut runs it against the tag's version.

The script reads `core/Cargo.toml`'s version *scoped to the
`[workspace.package]` table* — an unscoped first-match read would pick up a
`version = ` line under `[workspace.dependencies]` instead.

Tag format: `v*` (e.g. `v0.6.0`), created by **Cut release**.

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
| `resume_tag` | an existing tag whose bundle jobs failed; rebuilds it without a version bump |
| `include_windows` | build Windows too; off by default, because the installer is not at parity |

It reads the tags to decide the next version, writes it with
`scripts/set-version.sh`, commits, tags, pushes, builds the selected bundle jobs
in parallel and files a **draft** release whose body is the generated notes.
Windows or not, a cut requires both Linux architectures, each with an AppImage
and a `.deb`; a Windows build adds the x86_64 NSIS installer. Then you download
the artifacts, install and run them, and promote the draft with **Promote draft
to public** — see "Smoke-test the bundle" below. A draft is where every release
stops until a person has run it.

A second cut started while one is running queues behind it
(`concurrency: release-cut`); it is never cancelled, because a cut that has
already pushed a tag must not be killed mid-flight. An `rc` queuing behind a
stable cut is intended.

Before `publish` runs, the Linux bundle workflow boots the built x86_64 AppImage
on Ubuntu 22.04, Ubuntu 24.04, Debian 12 and current Fedora, headlessly: each
job installs only the runtime libraries a desktop install already has, extracts
the AppImage and runs `--version`, so a missing host dependency or a build that
overran the glibc floor fails there. It runs for every caller of the bundle
workflow, and `publish` waits for it. A graphical run is still a person's job:
a runner has no display.

### The lifecycle of a tag

1. **Nothing.** PRs merge to `main`. No version exists.
2. **Tag pushed, nothing built.** `prepare` computes the version, writes the
   four manifests, commits and pushes commit and tag atomically. From here the
   tag is permanent; nothing deletes it.
3. **Building.** Both bundle jobs build *the tag*, not the dispatch ref. Linux
   builds x86_64 and aarch64 natively, each producing an AppImage and a `.deb`;
   Windows, when selected, builds the x86_64 NSIS installer. The Linux job then
   boots the built x86_64 AppImage headlessly on the four distributions above.
4. **Draft filed.** `release-publish.yml` generates the notes once, verifies
   the artifact set, writes `latest.json` and files a draft. A draft's assets
   are not publicly downloadable, so the URLs inside `latest.json` do not
   resolve yet — that is precisely what makes this state safe.
5. **Smoke-tested.** A person installs the artifact and runs it on a real
   desktop. No runner can do this; they are headless and no webview
   initializes.
6. **Public.** `publish-draft.yml` flips the draft after a reviewer approves
   the `stable-release` environment. `releases/latest` serves it, the
   `latest.json` URLs resolve, and installed copies begin to be offered the
   update.

An interruption between the build and the draft leaves the tag with no release.
`resume_tag` is how that is recovered: it rebuilds the existing tag, skipping
the version computation, the commit and the push. Re-running a plain `patch`
cut instead computes the *next* version — the release commit's version already
exists — and strands the tag.

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
  AppImage or deb, the Windows x86_64 installer missing when the cut included
  Windows, a filename from another version, and any file the release does not
  expect; the error names the offending file and what was expected.
- **A second cut while one is running.** It queues behind the first
  (`concurrency: release-cut`) and is never cancelled.
- **A resume onto a published release.** Only a draft may be replaced; a
  release that is already public is never rebuilt.
- **A resume whose manifests disagree with its tag.** A resumed cut checks out
  the tag it rebuilds and refuses a tree that does not carry that version.
- **Publishing without a smoke test.** `publish-draft.yml` refuses until the
  operator ticks the attestation, and **publishing something already public**
  is refused for the same reason a re-cut is.

The `stable-release` environment reviewer is the actual control; the checkbox
is an attestation a person makes, and `publish-draft.yml` runs unprotected
until that environment exists.

An `rc` continues an open series rather than starting a new one: if a
`vX.Y.Z-rc.N` exists whose base is above the latest stable, the next is
`-rc.(N+1)` on that same base. With no open series it starts at the next minor,
`-rc.1`. The notes for a candidate span the last stable tag to the candidate.

An `rc` is filed as a **prerelease** (and still as a draft, until a person
smoke-tests it). Publishing a candidate as a normal release would make
`releases/latest` offer it to every stable install, so the flag follows the
`kind` that was asked for — or, for a resumed tag, the version's own `-rc.`
suffix.

Cut release pushes through its deploy key so it can update protected `main`.
Nothing watches the pushed tag: the run itself builds the bundles and files the
release.

A `v*` tag pushed by hand starts nothing. The only runs that produce artifacts
are **Cut release** and the manual `build-installers.yml` (which files
nothing); promoting a draft is `publish-draft.yml`.

### One workflow file per OS

Each OS file is self-contained: it declares its own runner pins, its own
toolchain, its own caches and its own pinned Tauri CLI version, and takes the
release version as an input. That is the point of the split — one OS's build
can be re-run on its own after a flake without paying for the other, and a
change to the Linux packaging cannot accidentally move the Windows one.

The two bundle workflows only read the tree and upload artifacts, so they
carry the narrowest permissions they need; they receive the signing secrets
through `secrets: inherit`. `release-publish.yml` is the one job that writes
anything outward-facing, and it writes a draft.

### Windows signing: two paths, one secret

The Windows installer, when a cut builds one, gets two independent signatures.
The updater one is not optional: a Windows cut signs the `.exe` with the
Minisign key and publishes the `.sig`, and without it `latest.json` cannot be
built at all. The Authenticode one is the optional half, and
`release-windows.yml` takes one path or the other on the presence of a single
secret, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`:

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

The daemon asks the releases API once at start, every six hours, and whenever the
About panel's **Check now** is pressed, and broadcasts what it found. The panel
names the release, shows a teaser of its notes and links to the release page.
Scheduled checks also revalidate the shared model catalog independently of the release result.
Release checks send the last valid ETag within a daemon lifetime; a `304` reuses the cached
release payload. Restarting the daemon performs a full release check.

**Install update** is the other half: the app fetches the fixed manifest
`releases/latest/download/latest.json`, picks the entry for this exact bundle
(`linux-x86_64-deb`, `linux-x86_64-appimage`, `windows-x86_64-nsis`),
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
   workflow refuses a run without them; a cut stops before it pushes anything.
3. Paste the **public** key into `src-tauri/tauri.conf.json` under
   `plugins → updater → pubkey` (a public key is not a secret and belongs in
   the tree). The publish and promotion gates verify every artifact and its
   signed comment against this key with Minisign before publishing anything.
   A mismatched signing secret stops the release, even if the bundler succeeds.

Keep the private key backed up securely. Installed copies trust the public key
embedded when they were built: replacing it in the repository does not change
their trust. If signatures fail, first recover the matching private key and
correct the signing secrets. Rotating keys requires an update signed by the old
key that embeds the new public key; without the old key, users must reinstall
manually to trust a new pair.

### Public update feed

The updater uses one public release asset:
`https://github.com/theogmiguel/houston/releases/latest/download/latest.json`.
Each published release attaches `latest.json` with the signatures of its
release artifacts, so installed copies can select and verify the matching
installer. The first published release establishes this feed; an end-to-end
update is exercised by installing that release and moving to a subsequent one.

What every release carries:

1. The bundle workflows sign what they build. On Windows that is
   `cargo tauri signer sign` after the optional Authenticode step; on Linux the
   bundler signs the AppImage and the deb as it writes them, and the workflow
   signs any it left unsigned.
2. `release-publish.yml` verifies the set — one AppImage family and one deb for
   Linux x86_64 and ARM64, plus one Windows x86_64 NSIS installer when the cut
   included Windows, a `.sig` beside each, every filename carrying the
   release's version — and refuses anything else. It also verifies every bundle
   and signed comment against `plugins.updater.pubkey`. Promotion repeats this
   verification over the downloaded draft assets before making them public.
3. `latest.json` embeds each `.sig` file's contents under both the bare
   `linux-<arch>` / `windows-<arch>` key and the bundle-specific
   `-appimage`, `-deb` and `-nsis` keys, so a deb install and an AppImage
   install each resolve their own payload.
4. The manifest is published as a release asset, which is what makes the URL
   above resolvable.

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
- **The `stable-release` environment**: create it under Settings ▸
  Environments and add a required reviewer. `publish-draft.yml` names it, and
  until it exists the promote workflow runs unprotected — the reviewer is the
  only thing standing between a smoke-tested draft and the public.
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
tag still uses the `v*` shape, so the workflows above can resume or promote the
same release:

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

A stable cut creates only a **draft**, and **Promote draft to public** is what
makes it visible. CI proves the built x86_64 AppImage *loads and answers* on
the four distributions above, but not that the window opens: runners are
headless, so no webview ever initializes there. Manual smoke-test is a hard
requirement before promoting or handing anything out, local release or not:
install the artifact and run it (`./scripts/linux-vm.sh app` on the testbed)
first. The graphical test is Linux only while cuts are Linux only; it extends
to Windows on the first cut that ships a Windows installer.

### 4. Publish

A local cut signs its bundles the same way CI does, so the two secrets have to
be in the environment when the build runs (`TAURI_SIGNING_PRIVATE_KEY`,
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) — on the VM too, since the Linux build is
where the `.sig` files come from. Then generate the notes once, build the
manifest from the files the bundles produced, and file the release with the
same body `latest.json` carries. Install the `minisign` CLI first; the manifest
generator requires it for signature verification:

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
refusals: the manifest script rejects a set with a missing or invalid `.sig`, a
missing architecture or a filename from another version, so the release never
ships a manifest the updater cannot use. This path ends at a draft too, and
**Promote draft to public** is the same promotion a CI cut goes through.

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
