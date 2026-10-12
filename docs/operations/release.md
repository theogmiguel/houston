# Releasing

## Cut, review and publish

A new release takes two manual workflows. **Cut release** creates a draft with
installers. **Promote draft to public** publishes it after a desktop smoke test
and approval. Merging a PR or pushing a tag does not publish a release.

1. Merge the intended PRs and wait for **CI** on the current `main` commit to
   finish successfully. Open **Actions → Cut release → Run workflow**. Leave
   the workflow branch and `ref` on `main` for a stable release.
2. Choose `kind`: `patch` for fixes, `minor` for features, `major` for a breaking
   release, or `rc` for a prerelease. Keep `include_windows` checked for the normal
   Linux and Windows release. Leave `resume_tag` empty and `preview_only` unchecked.
3. Run the workflow. Its summary shows the source commit, next version, previous
   public release, selected platforms and release notes. It checks source CI,
   updates the four manifests and both lockfiles, pushes the release commit and
   tag, builds the installers and creates a **draft**. Nothing is public yet.
4. Follow the draft link in the summary, or open **Releases** in the repository.
   Review the grouped notes, expand any legacy title-only entries, and save edits
   to the draft. Download and test the installers on real desktops using the
   [smoke-test procedure](#3-smoke-test-the-bundle). Do not click GitHub's direct
   **Publish release** button: that bypasses manifest synchronization and checks.
5. Open **Actions → Promote draft to public → Run workflow** on `main`. Enter the
   exact draft tag, such as `v0.20.0`, and check `smoke_tested` after testing. Start
   the workflow, open its run and use **Review deployments** to approve the
   `stable-release` environment. A configured required reviewer must approve it;
   dispatching the workflow alone does not grant approval.
6. Promotion verifies the downloaded assets and signatures, copies the reviewed
   draft description into `latest.json`, and then publishes the draft. The summary
   links to the public release. Stable installations can discover the update;
   installation still requires an explicit user action. An RC stays a prerelease
   and is not offered through the stable update feed.

To review the proposed version and notes before building, run **Cut release**
with `preview_only` checked. It uploads a `release-notes-<tag>` Actions artifact
and writes a preview summary, but creates no commit, tag, installer or release.
Run again with that option unchecked when ready. A preview does not reserve its
version; another cut or changes to `main` can change the next result.

| Cut release input | Meaning |
|---|---|
| `kind` | `patch`, `minor`, `major` or `rc`; ignored when resuming |
| `ref` | Source branch, tag or SHA; stable cuts require the current tip of `main` |
| `include_windows` | Defaults to `true`; disabling it deliberately produces Linux packages only |
| `preview_only` | Inspect source CI, version and notes without building or changing repository state |
| `resume_tag` | Existing tag to rebuild without another version commit or tag |

## Recover a failed attempt

- If a bundle job fails after `prepare` succeeded, use the run's **Re-run failed
  jobs** first. Successful jobs and their artifacts remain available, so they do
  not need to be rebuilt. Avoid **Re-run all jobs** on a normal cut: it repeats
  version allocation and can allocate another version.
- If the version/tag was already pushed but `prepare` failed afterwards, or a
  fresh run is needed, start **Cut release** with `resume_tag` set to that exact
  tag. Keep the original `include_windows` selection. This checks out the tag,
  verifies its manifest versions, rebuilds it and creates or updates its draft.
  An existing draft keeps its identity and reviewed notes. A public release is
  refused. Resume does not delete or move tags and does not create a new version.
- A fresh `resume_tag` run rebuilds the packages; it does not reuse artifacts from
  a different run. Fixes to packaging automation must be available on the workflow
  branch. Source fixes require a new release, because the existing tag is immutable.
- If publication fails, inspect the error, leave the release as a draft, and rerun
  **Promote draft to public** after fixing the cause. Edited notes are read again.
  A public release is never republished by this workflow.

Cuts share a concurrency group. The running cut is not cancelled by a new one;
GitHub retains only one pending run in that group and replaces an older pending
run when another is submitted. Wait for the current cut before submitting another.
Draft updates and promotion share a per-tag concurrency group, so the workflows
cannot overwrite and publish the same draft at the same time. Avoid editing a
release manually while either operation is running.

## Release notes

Notes start at the nearest **published stable release** in the source commit's
history, not the highest reserved tag. An abandoned tag or an unpublished draft
must not hide changes from the next public release. RC notes use the same stable
baseline. Version allocation still reads all reserved tags to avoid collisions.

For each merged PR in that range, the generator reads its `## Release notes`
section. Use category headings and one concise English bullet per change; omit
unused categories. A PR may contribute multiple features, fixes and performance
improvements. For example:

```markdown
## Release notes

### Features

- Restore saved pane layouts when reopening a workspace.

### Fixes

- Keep a renamed pane's name after respawning its agent.

### Performance

- Bound terminal output buffering while a pane is hidden.
```

The supported categories are `Features`, `Fixes`, `Performance`, `Refactoring`
and `Other`. Write `None` or `Internal only` directly under `## Release notes`
when a PR has no release-facing changes. Empty sections and unknown categories
are rejected. PR CI validates a present section; editing only the PR description
requires rerunning CI to validate the new text.

Legacy PRs without the section fall back to their conventional title. The preview
summary and metadata identify these entries for editorial review. The generator
does not invent details from implementation diffs or call an AI service. Each
entry links to its PR, and the notes include a full changelog link. Review and
improve this copy in the draft before promotion.

At draft creation, the release page and `latest.json` receive the same notes.
Promotion synchronizes the manifest again using the final draft description, so
edits made during review reach the app. Editing a release after publication does
not synchronize the manifest; finish editorial review before promoting it.

## Workflow responsibilities

| Actions name | File | Purpose |
|---|---|---|
| CI | `ci.yml` | PR and main validation; no installers or publication |
| Cut release | `cut-release.yml` | Manual version allocation, notes, builds and draft |
| Promote draft to public | `publish-draft.yml` | Manual publication after smoke-test attestation and environment approval |
| Build installers | `build-installers.yml` | Manual packaging validation; no version bump, tag or release |
| Build Linux packages (internal) | `release-linux.yml` | Reusable Linux builds and packaged runtime checks |
| Build Windows installer (internal) | `release-windows.yml` | Reusable native compilation and subsequent NSIS packaging |
| Create release draft (internal) | `release-publish.yml` | Reusable signature verification, updater manifest and draft creation |

The three internal workflows are called by the manual workflows; their lack of
independent runs does not mean they are unused. They are not dispatched directly.

CI runs seven jobs: `safety-checks`, `renderer-checks`, `core-checks`,
`linux-native-checks`, `windows-renderer-checks`, `windows-checks` and
`licence-inventory`. Cut release requires a successful run for the exact source
commit and successful completion of every required job. A green run for an older
commit is insufficient. Stable cuts require main CI; RC cuts may use PR CI for
that exact PR head targeting `main`. Main pushes limited to documentation are
excluded by CI's path filters; manually run CI for that commit before cutting.
See the [development runbook](development.md) for the remaining local gates.

**Build installers** accepts any source ref and resolves it once to an immutable
commit shared by all jobs. Both platforms are selected by default. Selecting
`windows` still builds Linux packages because Windows embeds their x86_64 daemon
for WSL. It uploads artifacts only and is the packaging check to run before
merging changes to the bundle pipeline.

Linux builds x86_64 and aarch64 packages. Windows native compilation starts in
parallel with Linux; NSIS packaging waits for the Linux WSL artifact and validates
its real daemon and helper before bundling. The intermediate Windows native
artifact is internal to Actions and is not a release asset. This removes Linux
build time from the start of Windows compilation without omitting WSL resources.

Before filing the draft, Linux packages run headlessly on Ubuntu 22.04, Ubuntu
24.04, Debian 12 and current Fedora. The packaged x86_64 app and daemon also run
under QEMU's baseline CPU. These checks catch missing runtime dependencies, ABI
floor changes and unsupported CPU instructions. They do not replace graphical
smoke tests on real Linux and Windows desktops.

## Versions and release boundaries

Only a release changes versions. Feature PRs do not edit the version manifests:

- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
- `ui/package.json`
- `core/Cargo.toml` (`workspace.package.version`)

`scripts/set-version.sh X.Y.Z` updates all four and both Cargo lockfiles using
`cargo update --workspace`, without updating dependencies. It accepts `X.Y.Z` or
`X.Y.Z-rc.N`. `scripts/check-manifest-versions.sh` verifies agreement and checks a
resumed tag's expected version. Cut release runs these scripts; contributors do
not bump versions by hand.

Stable cuts require the tip of `main`, an unused tag and a version greater than
all stable tags. The version commit and tag are pushed atomically; a rejected push
must not leave half a release on the remote. An RC can use a side ref, in which
case only its tag is pushed and `main` is not moved. RC allocation continues the
highest open series above the latest stable tag; otherwise it starts the next
minor version at `-rc.1`.

A normal cut requires `RELEASE_PUSH_SSH_KEY`, `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` before changing any versions. A resume needs
the signing secrets but does not push a new commit or tag. Preview needs neither
signing nor push secrets. `release-publish.yml` refuses missing architectures,
missing or invalid signatures, mismatched versions and unexpected asset files.
Only verified bundles and their updater manifest become release assets.

All changes to `main` go through PR review and CI. The automated version commit
uses the configured release deploy key. A manually pushed `v*` tag starts no
workflow. The `stable-release` environment's required reviewer is the publication
control; configure it as described below rather than relying on the checkbox alone.

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

The daemon fetches `releases/latest/download/latest.json`, the same manifest the
app's updater reads, once at start, every six hours, and whenever the About
panel's **Check now** is pressed, and broadcasts what it found. The panel names
the release, shows a teaser of its notes and links to the release page, whose URL
is built from the manifest's version. The notes are the manifest's `notes`
field, synchronized from the reviewed draft by **Promote draft to public**. Edits
made after publication do not change what the panel shows.
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
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` are **required**: a new signed cut or resume
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

`linux-vm.sh gate` runs only a subset of the CI safety scripts. It does
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
the release workflow keeps by building on 22.04. Before a local cut, gate the result from the
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

```powershell
$env:HOUSTON_WSL_LINUX_BIN_DIR = '<Linux core/target/release>'
./scripts/build-app.ps1
cd src-tauri
cargo tauri bundle --bundles nsis --ci
```

Build the Linux `houston-core`, `tr-helper` and `houston-supervisor` at the same
commit inside WSL first, and point `HOUSTON_WSL_LINUX_BIN_DIR` to that output.
The script requires these resources and validates them before building the app.
See [Windows artifacts](development.md#windows) for the prerequisite build.

`build-app.ps1` runs the renderer gates, stages the native sidecars from one
locked Cargo build, and builds the production app through
`cargo tauri build --no-bundle --ci -- --locked`, with three Cargo jobs.
The separate bundle step packages that build without recompiling it. A release
requires updater signing keys; a local unsigned build can use `--no-sign`.

Bundle output: `src-tauri/target/release/bundle/nsis/*.exe`.

### 3. Smoke-test the bundle

A stable cut creates only a **draft**, and **Promote draft to public** is what
makes it visible. CI proves the built x86_64 AppImage *loads and answers* on
the four distributions above, but not that the window opens: runners are
headless, so no webview ever initializes there. Manual smoke-test is a hard
requirement before promoting or handing anything out, local release or not:
install the artifact and run it (`./scripts/linux-vm.sh app` on the Linux testbed)
first. Smoke-test every platform included in the draft before promotion.

For Windows, install the NSIS artifact on Windows 10 or 11 and launch it on an
isolated test channel. Verify terminal input and coloured output, browser navigation,
task startup in a worktree and child-pane orchestration. Close and reopen the app
to confirm that its detached daemon and sessions remain available. Verify the
update flow separately: Windows updates stop sessions before replacing the daemon.

A Windows installer also gets a WSL pass, because no CI job reaches a real distro.
Install it, then on a test channel (for example `houston.exe --channel wslt`, so
neither the release state nor the distro's `~/.houston` is touched):

1. Settings → WSL → **Enable** an x86_64 WSL 2 distro; its row reaches the running state.
2. **Workspaces → + → Local folder…** → a folder under `\\wsl.localhost\<distro>\home\…`;
   the rail shows it with `WSL: <distro>`.
3. Open a shell pane there; `uname -s` prints `Linux` and `pwd` the POSIX path.
4. In that pane, `houston .` from another folder selects it in the Windows app.
5. Quit from the tray; the distro's `~/.houston-wslt/daemon.json` is gone afterwards.

The `wsl_live` tests in [`development.md`](development.md#wsl_live) cover the daemon,
relay and session path of that pass against the same distro without the installer.

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

python3 scripts/release-helper.py notes \
  --repo theogmiguel/houston --source "$release_tag" --tag "$release_tag" \
  --output /tmp/houston-notes.md --metadata /tmp/houston-notes.json
# Review /tmp/houston-notes.md before filing the draft.

python3 scripts/gen-update-manifest.py \
  --repository theogmiguel/houston --tag "$release_tag" \
  --version "$release_version" \
  --notes-file /tmp/houston-notes.md \
  --artifacts-dir <artifacts-dir> --output <artifacts-dir>/latest.json

gh release create "$release_tag" --draft --verify-tag \
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

- Missing promo-art PNG.
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
(`StartupWMClass=houston`), and night-tile PNGs at 48/64/128/256/512px under
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
