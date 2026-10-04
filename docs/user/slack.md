# Slack requests

The Slack intake turns a mention of your own Slack bot into a pending task in Houston. The
task starts only when the owner (you) accepts it, and its run reports back to the request's
thread. It is off by default and needs a Slack app you create yourself; Houston ships no
shared app and runs no server.

## Create the Slack app

1. At [api.slack.com/apps](https://api.slack.com/apps), create an app in your workspace
   **From a manifest** with Socket Mode and interactivity on, a read-only Messages tab, these
   bot scopes and these bot events:

   ```yaml
   display_information:
     name: Houston
   features:
     app_home:
       messages_tab_enabled: true
       messages_tab_read_only_enabled: true
     bot_user:
       display_name: houston
   oauth_config:
     scopes:
       bot: [app_mentions:read, channels:history, groups:history, chat:write, im:write,
             reactions:read, reactions:write, files:read]
   settings:
     interactivity:
       is_enabled: true
     socket_mode_enabled: true
     event_subscriptions:
       bot_events: [app_mention, message.channels, message.groups, reaction_added]
   ```

   Interactivity needs no request URL: button clicks arrive over the same Socket Mode
   connection. `im:write` and the Messages tab let the bot message the owner directly. An
   app created from an earlier version of this page needs these keys added under **App
   Manifest** and a reinstall.
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
- **Language**: English or Português (Brasil). Houston writes its own Slack text in it, and
  the agent is asked to write the question and the hand-back for the requester in it.

The status line shows whether the connection is up, the Slack team and the last event. An
error stays visible until the next successful connection.

## How a request flows

1. Anyone in a mapped channel mentions the bot with a request; images attached to the
   message are included. Houston reacts with 👀, files a task with the message's permalink
   as its link and sends the owner a direct message with the channel, the requester, the
   start of the request, whether it would start now or wait, and **Accept**, **Refuse** and
   **View message** buttons. Nothing is written in the thread. The task waits in **Backlog**
   with a **Slack · awaiting ✅** chip.
2. The owner starts it with **Accept**, by reacting with ✅ to the request or to one of
   Houston's messages in its thread, or with **Start** in the Tasks tab. A ✅ or a click
   from anyone else does nothing. **Refuse** asks for an optional reason: the reason is
   posted in the thread exactly as written, the task is canceled and the request gets 🚫;
   without a reason only the 🚫 appears. A request whose task is canceled, finished or
   archived in Houston before it starts gets 🚫 too. Requests always start with Claude in
   a new worktree, as a Start does; the brief tells the agent to follow the repository's
   own factory skill when there is one and to hand the task back when done.
3. At most two Slack runs work at once. A run waiting for an answer or for a confirmation
   in Houston does not count. A request accepted beyond the limit waits with
   **Slack · queued #n**, the owner's message shows its place, and it starts when a slot
   frees.

4. The agent can ask one question at a time with
   `hs-task ask --context … --question … --option … --option … --recommended N` (or the
   `task_ask` tool): one sentence of context, the question, two to four options and the
   one it recommends. Houston posts it to the thread with a button per option and an
   **Another answer…** button that opens a text box; replying in the thread in one's own
   words works too. The first answer from the requester or the owner counts, the question
   is edited to show it, and it is typed into the agent's pane as its next prompt once the
   pane is idle. Anyone else who clicks is told privately that only the requester or the
   owner answers; their replies are ignored. The owner gets no direct message for a
   question: the ❓ on the request shows it.
5. When the agent hands the task back, Houston replies with the branch the worktree
   pushed to (or says it was not pushed), the pull request `gh` finds for that branch
   (GitHub only) or, when there is none, the link that opens one on GitHub or Bitbucket
   Cloud, and the agent's hand-back summary, with the workspace path removed and secrets
   redacted.

The request shows its state as one reaction at a time, beside the owner's ✅: 👀 received,
⚙️ working, ❓ waiting for an answer, 🏁 ready for review, 🚫 not going ahead and ⚠️
attention. ⚠️ means something no agent can explain to the requester, such as a request
over the size limit, a start Houston refused, a run that stopped or one waiting for a
confirmation in its pane; the owner gets a direct message saying which.

Houston never pushes, opens pull requests or merges by itself; the agent does what the
repository's own instructions tell it, and merging is yours.

If Houston was not running or the connection dropped, it replays the mapped channels'
messages since the last one it saw, up to 24 hours back, when it reconnects; a ✅ the owner
added meanwhile is honoured. A channel mapped for the first time starts from the moment
it is mapped.

## Limits

- Request text: 8,192 bytes. A longer request gets ⚠️ and is not filed; the owner is told.
- Images: four per request, 10 MiB each, PNG, JPEG, GIF or WebP checked by their content.
  Others are named in the owner's message and left out. Images are saved under the workspace's
  `.houston/intake/<id>/`, which git ignores.
- Channels: 16. A question's context: 500 characters; the question: 300; each of its two to
  four options: 200. Text typed into Houston's dialogs: 2,000 characters.

## What leaves the machine

- **Slack → Houston**: Slack delivers every event of the channels the bot is in, not only
  mentions; Houston acts only on mentions, ✅ reactions and thread replies in mapped
  channels, and ignores bots, edits and members of other organisations. Clicks on
  Houston's buttons and the text typed in its dialogs arrive over the same connection:
  the owner's for a request, the requester's or the owner's for a question; anyone
  else's click only gets a private notice. On reconnect it reads the mapped channels' recent
  history. It downloads the images of a filed request.
- **Houston → Slack, in the thread**: the status reactions on the request, the owner's
  refusal reason, the agent's questions with their options and the answer chosen, and the
  hand-back reply. Everyone in the channel
  can read them.
- **Houston → Slack, to the owner only**: direct messages naming the channel, the
  requester and the first 280 characters of the request, with the start outlook and,
  when something needs attention, Houston's reason.
- **Houston → the agent's provider**: the request text and images reach the agent as task
  data, so they are sent to the provider like any prompt.
- Nothing goes to Houston's authors or any other service. Disconnecting stops all of it.
