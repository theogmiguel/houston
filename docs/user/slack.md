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

Open **Connections › Integrations** and choose **Connect** or **Configure**:

- **Tokens**: paste both tokens and choose **Connect**. They go to the OS keychain, never to
  Houston's database or logs; the fields stay empty afterwards. **Disconnect** turns the
  intake off, closes the connection and removes both tokens.
- **Owner and channels**: the owner is the Slack member ID (`U…`, from the profile's **Copy
  member ID**) whose ✅ starts requests. Each channel ID (`C…` or `G…`, from the channel's
  details) is mapped to one workspace; requests from that channel are filed there.
- **Language**: English (the default) or Português (Brasil); it applies as soon as it is
  chosen. Houston writes its own Slack text in it, and the agent is asked to write the
  question and the hand-back for the requester in it. A run reads it when it starts, so a
  change reaches the next run, not one already working.

The **Integrations** section on Connections shows the Slack connection state, team, last
event and mapped workspaces when that information is available. Choose **Configure** to
edit the owner, language and channel mappings. Choose **Disconnect** to turn intake off and
remove its saved tokens.

The status line shows whether the connection is up, the Slack team and the last event. An
error stays visible until the next successful connection. A message Slack refuses to lay out
is sent again as plain text with the same content; one Slack keeps refusing is dropped after
five attempts, and the status line names it.

## How a request flows

1. Anyone in a mapped channel mentions the bot with a request; images attached to the
   message are included. Houston reacts with 👀, files a task with the message's permalink
   as its link and sends the owner a direct message with the channel, the requester, the
   start of the request, whether it would start now or wait, and **Accept**, **Refuse** and
   **View message** buttons. Nothing is written in the thread. The task waits in **Backlog**
   with a **Slack · awaiting ✅** chip.
2. The owner starts it with **Accept**, by reacting with ✅ to the request, or with
   **Start** in the Tasks tab. A ✅ or a click
   from anyone else does nothing. **Refuse** asks for an optional reason: the reason is
   posted in the thread exactly as written, under "Not going ahead" and the owner's name,
   the task is canceled and the request gets 🚫; without a reason only the 🚫 appears, which
   sends the requester no notification. A request whose task is canceled, finished or
   archived in Houston before it starts gets 🚫 too. Requests always start with Claude in
   a new worktree, as a Start does; the brief tells the agent to follow the repository's
   own factory skill when there is one and to hand the task back when done. The accept
   honours the readiness rule of [Tasks](tasks.md#starting-a-task), except that a Slack
   request needs no acceptance item: a request whose task has an open `[?]` item or an
   unfinished blocker is not started, and the owner's message says what is missing.
3. At most two Slack runs work at once. A run waiting for an answer or for a confirmation
   in Houston does not count. A request accepted beyond the limit waits with
   **Slack · queued #n**, the owner's message shows its place, and it starts when a slot
   frees.

4. The agent can ask one question at a time with
   `hs-task ask --context … --question … --option … --option … --recommended N --why …` (or
   the `task_ask` tool): one sentence of context, the question, two to four options, the
   one it recommends and, optionally, why. Houston posts it to the thread with a button per option and an
   **Another answer…** button that opens a text box; replying in the thread in one's own
   words works too. The first answer from the requester or the owner counts, the question
   is edited to show it, and it is typed into the agent's pane as its next prompt once the
   pane is idle. Anyone else who clicks is told privately that only the requester or the
   owner answers; their replies are ignored. The owner gets no direct message for a
   question: the ❓ on the request shows it.
5. When the agent hands the task back, it fills fields instead of a one-line summary: a
   subject of at most 60 characters, what changes, up to three steps to see it once it is
   live, caveats, a note for when it goes live and one for when it is dropped, and, for the
   owner only, short facts and warnings (`hs-task handback --subject … --changes … --step …
   --live-note … --dropped-note …`, or the `result` of the `task_handback` tool). The
   thread gets **Ready, waiting for review** with what changes, how to check it and that a
   developer still reviews it; the request gets 🏁. A request the agent refuses at triage
   (`--refused`) gets **Not going ahead** with the agent's reason instead, and 🚫. The
   thread never shows the task key, the branch or file paths; the workspace path is cut out
   of every field and secrets are redacted.

   The owner gets a direct message named by the subject, with the size in one word
   (small, medium or large) and the files and lines changed since the run's base, the
   pushed branch (or that it was not pushed), the warnings and facts, the time worked
   without the time spent waiting for an answer, and a pull request button: **Open pull
   request** for the one `gh` finds for the branch (GitHub only), or **Create pull request**
   for the page that opens one on GitHub or Bitbucket Cloud, with a reminder that the
   description is ready in the task. What the agent marks as blocking a merge
   (`--blocker`) comes first, under the title "Delivered with a blocker". A refusal at
   triage quotes the agent's reason. A later delivery of the same request says it is an
   adjustment on the same branch. Notifications carry the request's start, the size and
   the number of warnings, so the phone shows what arrived. Small is the agent's call, following the
   repository's own rule; without it, three files or fewer count as small. Up to 15 files
   and 600 changed lines is medium; anything larger is large.

6. When the owner moves a handed-back task to **Done**, Houston posts the agent's "live"
   note to the thread, with how to ask for another change, and the request gets 🚀; on GitHub, the merge watch moves the task to
   Done by itself. Moving it to **Canceled** posts the "dropped" note and 🚫. A request
   refused at triage gets no second note. Houston watches no forge for a merge or a
   deploy of its own: the task's state is the signal.

7. A reply from the requester in the thread outside a question gets 👀. Before the work
   starts it is added to the task's description, so the agent reads it; during the work it
   reaches the owner as a direct message, since the agent does not read the thread.
8. A reply from the requester in the thread after the hand-back, while the task is in
   review, may ask for an adjustment: it gets 👀 and the owner gets a direct message
   quoting it with **Accept** and **Ignore**. Accepting (the button, or the owner's ✅ on
   the reply) starts a new attempt on the same worktree with the reply in its brief, within
   the same limit of two working runs. **Ignore**, for a thank-you or a comment, removes
   the 👀 and nothing else. A reply still pending when the task is closed loses its 👀 as
   well. The new attempt hands back again, and its notes replace the earlier ones.

The request shows its state as one reaction at a time, beside the owner's ✅: 👀 received,
⚙️ working, ❓ waiting for an answer, 🏁 ready for review, 🚀 live, 🚫 not going ahead
and ⚠️ attention. ⚠️ means something no agent can explain to the requester, such as a request
over the size limit, a start Houston refused, a run that stopped or one waiting for a
confirmation in its pane; the owner gets a direct message saying which.

Houston never pushes, opens pull requests or merges by itself; the agent does what the
repository's own instructions tell it, and merging is yours.

If Houston was not running or the connection dropped, it replays the mapped channels'
messages since the last one it saw, up to 24 hours back, when it reconnects; a ✅ the owner
added to a request meanwhile is honoured, and so are answers and adjustment replies in the
threads that were waiting for one. A ✅ on an adjustment reply added while offline is not;
use **Accept** in the direct message. A channel mapped for the first time starts from the moment
it is mapped.

## Tell the channel

Reactions do not explain themselves, and only the requester can act on some of them. Pin a
message like this one in each mapped channel, in the connector's language:

> **How to ask @houston for a change.** Mention @houston in a new message in this channel
> with the screen and what you want changed; a screenshot helps. Progress shows as a
> reaction on your message: 👀 received, waiting for the team's approval · ⚙️ in progress ·
> ❓ a question for you in the thread · 🏁 ready, waiting for review (not live yet) · 🚀 live ·
> 🚫 not going ahead · ⚠️ stopped; the team has been told. When asked something, pick an
> option or reply in the thread: your next message there is the answer. After 🏁, reply in
> the thread to ask for an adjustment. After 🚀, start a new request for another change.
> Before ⚙️, reply in the thread to add to the request: 👀 on your reply means it was taken.

The same message in Português (Brasil):

> **Como pedir mudanças ao @houston.** Mencione @houston numa mensagem nova neste canal
> dizendo a tela e o que quer mudar; um print ajuda. O andamento aparece como reação na sua
> mensagem: 👀 recebido, aguardando aprovação do time · ⚙️ em andamento · ❓ tem uma pergunta
> para você na thread · 🏁 pronto, aguardando revisão (ainda não está no ar) · 🚀 no ar ·
> 🚫 não vai seguir · ⚠️ parado; o time já foi avisado. Se o bot perguntar algo, escolha uma
> opção ou responda na thread: sua próxima mensagem lá vale como resposta. Antes do ⚙️, para
> completar o pedido, responda na thread: o 👀 na sua resposta quer dizer que ela entrou.
> Depois do 🏁, para mudar algo, responda na thread descrevendo o ajuste. Depois do 🚀, para
> outra mudança, faça um pedido novo.

## Limits

- Request text: 8,192 bytes. A longer request, or a mention with no request in it, gets ⚠️
  and is not filed; the thread asks the requester to reply right there, the reply is filed
  as the request, and the owner is told.
- Images: four per request, 10 MiB each, PNG, JPEG, GIF or WebP checked by their content.
  Others are named in the owner's message and left out. Images are saved under the workspace's
  `.houston/intake/<id>/`, which git ignores.
- Hand-back fields: subject 60 characters, what changes 1,500, three steps of 300, caveats
  600, each note 500, six owner facts and six warnings of 200.
- Channels: 16. A question's context: 500 characters; the question: 300; each of its two to
  four options: 200; why the recommended one: 200. Text typed into Houston's dialogs: 2,000 characters.

## What leaves the machine

- **Slack → Houston**: Slack delivers every event of the channels the bot is in, not only
  mentions; Houston acts only on mentions, ✅ reactions and thread replies in mapped
  channels, and ignores bots, edits and members of other organisations. Clicks on
  Houston's buttons and the text typed in its dialogs arrive over the same connection:
  the owner's for a request, the requester's or the owner's for a question; anyone
  else's click only gets a private notice. On reconnect it reads the mapped channels' recent
  history. It downloads the images of a filed request.
- **Houston → Slack, in the thread**: the status reactions on the request, the owner's
  refusal reason, the agent's questions with their options and the answer chosen, the
  hand-back reply, the note posted when the task is closed, and the 👀 on a reply that
  may ask for an adjustment. Everyone in the channel
  can read them.
- **Houston → Slack, to the owner only**: direct messages naming the channel, the
  requester and the first 280 characters of the request, with the start outlook; at
  hand-back, the subject, the size, the branch name, the pull request link, the agent's
  facts and warnings and the time worked; a requester's adjustment, quoted; and, when
  something needs attention, Houston's reason.
- **Houston → the agent's provider**: the request text, images, answers and adjustments
  reach the agent as task data, so they are sent to the provider like any prompt.
- Nothing goes to Houston's authors or any other service. Disconnecting stops all of it.
