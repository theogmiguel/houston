# Slack requests

The Slack intake turns a mention of your own Slack bot into a pending task in Houston. The
task starts only when the owner (you) accepts it, and its run reports back to the request's
thread. It is off by default and needs a Slack app you create yourself; Houston ships no
shared app and runs no server.

## Create the Slack app

1. At [api.slack.com/apps](https://api.slack.com/apps), create an app in your workspace
   **From a manifest** with Socket Mode on, these bot scopes and these bot events:

   ```yaml
   oauth_config:
     scopes:
       bot: [app_mentions:read, channels:history, groups:history, chat:write,
             reactions:read, reactions:write, files:read]
   settings:
     socket_mode_enabled: true
     event_subscriptions:
       bot_events: [app_mention, message.channels, message.groups, reaction_added]
   ```

2. Under **Basic Information ▸ App-Level Tokens**, generate a token with the
   `connections:write` scope (`xapp-…`).
3. Install the app and copy the **Bot User OAuth Token** (`xoxb-…`).
4. Invite the bot to each channel that should file requests (`/invite @your-bot`).

A workspace that requires app approval sends the install to an admin first.

## Connect Houston

Open **Settings ▸ Accounts ▸ Slack**:

- **Tokens**: paste both tokens and choose **Connect**. They go to the OS keychain, never to
  Houston's database or logs; the fields stay empty afterwards. **Disconnect** turns the
  intake off, closes the connection and removes both tokens.
- **Owner and channels**: the owner is the Slack member ID (`U…`, from the profile's **Copy
  member ID**) whose ✅ starts requests. Each channel ID (`C…` or `G…`, from the channel's
  details) is mapped to one workspace; requests from that channel are filed there.

The status line shows whether the connection is up, the Slack team and the last event. An
error stays visible until the next successful connection.

## How a request flows

1. Anyone in a mapped channel mentions the bot with a request; images attached to the
   message are included. Houston reacts with 👀, files a task with the message's permalink
   as its link and replies in the thread with the task key. The task waits in **Backlog**
   with a **Slack · awaiting ✅** chip.
2. The owner starts it by reacting to the request with ✅, or with **Start** in the Tasks
   tab. A ✅ from anyone else does nothing. Requests always start with Claude in a new
   worktree, as a Start does; the brief tells the agent to follow the repository's own
   factory skill when there is one and to hand the task back when done.
3. At most two Slack runs work at once. A run waiting for an answer or for a confirmation
   in Houston does not count. A request accepted beyond the limit waits with
   **Slack · queued #n** and starts when a slot frees; the thread says so.
4. The agent can ask one question at a time with `hs-task ask "…"` (or the `task_ask` tool).
   Houston posts it to the thread; the first reply from the requester or the owner is typed
   into the agent's pane as its next prompt once the pane is idle. Replies from anyone else
   are ignored.
5. When the agent hands the task back, Houston replies with the branch, the pull request
   `gh` finds for that branch (GitHub only) and the agent's hand-back summary, with the
   workspace path removed and secrets redacted. A run that stops without handing back is
   reported as stopped; one that waits for a confirmation in its pane is reported once,
   since the owner answers it in Houston.

Houston never pushes, opens pull requests or merges by itself; the agent does what the
repository's own instructions tell it, and merging is yours.

If Houston was not running or the connection dropped, it replays the mapped channels'
messages since the last one it saw, up to 24 hours back, when it reconnects; a ✅ the owner
added meanwhile is honoured. A channel mapped for the first time starts from the moment
it is mapped.

## Limits

- Request text: 8,192 bytes. A longer request is refused in the thread.
- Images: four per request, 10 MiB each, PNG, JPEG, GIF or WebP checked by their content.
  Others are named in the reply and left out. Images are saved under the workspace's
  `.houston/intake/<id>/`, which git ignores.
- Channels: 16. Questions: 2,000 characters.

## What leaves the machine

- **Slack → Houston**: Slack delivers every event of the channels the bot is in, not only
  mentions; Houston acts only on mentions, ✅ reactions and thread replies in mapped
  channels, and ignores bots, edits and members of other organisations. On reconnect it
  reads the mapped channels' recent history. It downloads the images of a filed request.
- **Houston → Slack**: the 👀 reaction, the filed/queued/started/stopped notices, the
  agent's questions and the hand-back reply. Everyone in the channel can read them.
- **Houston → the agent's provider**: the request text and images reach the agent as task
  data, so they are sent to the provider like any prompt.
- Nothing goes to Houston's authors or any other service. Disconnecting stops all of it.
