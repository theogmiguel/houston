# Settings

Settings is organized in groups. Every page has its own search terms; the search field in
the settings sidebar finds a page, a section or a single setting by name.

| Group       | Pages                                                                           |
| ----------- | ------------------------------------------------------------------------------- |
| —           | General, Appearance, Chat, Voice, Diffs & pull requests, Keybindings, SnapShots |
| Agents      | Providers, Threads, Browser, Devices, Scheduled tasks                           |
| Code        | Projects, Source control, Worktrees                                             |
| Connections | Environments, Task sources, Sharing & access, Secrets                           |
| —           | Maintenance, Labs, About, Archive                                               |

Search Settings by feature or setting name. `Esc` clears an active search.

## General

- **Sidebar** — group matching repositories across environments, and order projects.
- **Notifications** — thread notifications with a style (notifications, sound, both or
  off), and in-app notifications.
- **Confirmations** — ask before unpinning, archiving or deleting a thread, and, in the
  desktop app, whether the quit shortcut quits directly or waits for a second press.
- **Background** — **Keep in tray**, shown when the desktop has a working tray.
- **Display** — timestamp format.

## Appearance

Colors and themes, light/dark/system mode, contrast, glass opacity, panel animations,
environment identification, chat width, effort display, math rendering and composer
context. **Typography** sets interface, prompt, code and terminal fonts, their sizes, word
wrap and separate fonts. Custom themes can be created, duplicated, edited, exported and
imported; VS Code theme files can be imported. See [Appearance](appearance.md).

## Chat

The rich-text composer, the send shortcut, whether skills appear in the `/` menu, and
**Follow-up behavior** for a message sent while an agent is working.

## Voice

The transcription environment and microphone, speech models and their downloads, language and
translation, acceleration, model unload, the dictionary, filler-word removal and transcript
cleanup. See [Dictation](dictation.md).

## Diffs & pull requests

Diff layout, whitespace, default file expansion and colors. **Open pull requests and
changes panels proactively** opens the matching panel when an agent finishes, except in grid
cells and narrow windows.

## Keybindings

Every command with its current chord, condition and source. Add, change, reset or remove a
binding; the file that stores them can be opened in your editor. The desktop's **Quick
composer** global shortcut is here too. See [Keybindings](keybindings.md).

## SnapShots

Enable SnapShots, record a capture shortcut, include the captured window's text when the
platform exposes it, and choose the capture sound, flash and animation.

## Providers

Add and configure providers, sign in or out, install updates, set binary paths, config
directories, environment variables and models, and set the provider health check interval.
Each provider shows its readiness and one action to resolve it. See
[Install](install.md#providers) and [Agent status](agent-status.md).

Claude has two switches, both on by default:

- **Claude in Chrome** lets a thread's Claude use the Claude in Chrome extension to read
  and drive your Chrome tabs. The extension and a Chromium browser are required.
- **Artifacts** lets Claude publish pages as private Artifacts on claude.ai. The page's
  content is sent to your Claude account, and the account must have Artifacts.

## Threads

Default model, fallback model, default permissions, where new threads start (local checkout
or new worktree), hold presets, resume and hold behavior at usage limits, auto-close on
merge and after inactivity, the add-project base directory, text generation model and
instructions, and response streaming.

## Browser

Browser profiles, default viewport, zoom, appearance, link target, search engine, agent
browser access, automatic floating preview, and recording options.

## Devices

Device sources, whether agents may use devices, and device hub settings. Platform support
limits are named on the page.

## Scheduled tasks

Prompts that run on a schedule or a webhook, with their project, provider, model, next run
and delivery history. See [Tasks](tasks.md#scheduled-tasks).

## Projects

Project list, project overview (name, pin, archive, checkouts), project actions, merge queue
settings and merge history. See [Merge queue](pull-requests.md#merge-queue).

## Source control

Accounts and tokens for each host, repository conventions, generated change description
and pull request text, review guides (beta), automatic pull and the default merge method.

## Worktrees

Worktree location (an absolute folder; empty uses Houston's data folder), whether new
worktrees start from the remote, submodule handling, branch
naming, and cleanup of worktrees created by Houston.

## Environments

The machines Houston can run work on. Add an environment with a remote link and pairing
code, or over SSH, choose how work is balanced across environments, and share pull requests
between trusted environments. See [Environments and task sources](connections.md).

## Task sources

Slack intake, per-project GitHub issues and Notion, and the Houston 1 import.

## Sharing & access

This machine's version, endpoint and network access; Tailscale HTTPS; the WSL backend on
Windows; pairing a device and the list of authorized clients. Access is granted per client
and can be revoked.

## Secrets

Secret providers, currently 1Password, used as the source of a provider credential. A
stored credential is never shown again. Source control and task source tokens are set on
their own pages.

## Maintenance

Provider update checks, continuing threads after a restart, background activity, database
storage, browser artifacts and rotated logs, diagnostics, and **Coming from Houston 1**. See
[Updating Houston](updating.md#coming-from-houston-1).

## Labs

Linked environments (beta), Simlock device hosts (alpha), and optional composer features that
are off by default: plan mode and the context window indicator.

## About

Version, update check, install, release notes and open source licenses. See
[Updating Houston](updating.md).

## Archive

Archived threads, with restore and delete.
