# adapters/slack

Slack in, Slack out. Everything Slack-shaped stops here.

Passive by design: this listens to channel and DM history. There is no
`app_mention` subscription and no slash command. Nobody invokes the agent, and
that is the point of the product.

## Contracts

- **inbound:** Slack message event to `ContextEvent`
- **outbound:** `ActionDecision` to `chat.postMessage`, or `conversations.open`
  followed by `chat.postMessage` for a direct message
- **never:** import anything from `core/`. The adapter translates a surface.
  It does not know detection exists.

## How I run this alone

### Without Slack at all

```bash
npm run replay:demo
```

The replay adapter emits the same `ContextEvent` shape, so the pipeline and
your outbound formatting can be exercised with no workspace.

### With Slack, reading but never writing

```bash
cp .env.example .env       # fill SLACK_BOT_TOKEN and SLACK_APP_TOKEN
npm run dev:dry            # reads a live channel, logs decisions, sends nothing
```

`dev:dry` swaps the outbound for a console printer, so a mistake cannot reach
a real channel even if something downstream ignores the flag.

### With Slack, actually posting

```bash
npm run dev
```

## Setting up the app (10 minutes)

1. api.slack.com/apps, **Create New App**, **From an app manifest**, and paste
   `manifest.json` from this folder.
2. **Socket Mode** on. Generate an app-level token with `connections:write`,
   which is the `xapp-` one. That goes in `SLACK_APP_TOKEN`.
3. **Install to Workspace.** The Bot User OAuth Token is the `xoxb-` one. That
   goes in `SLACK_BOT_TOKEN`.
4. In the channel you want observed: `/invite @ClueBro`. Without this you get
   `not_in_channel` on send and no events at all on read.
5. Optional but recommended for the demo: put the channel id in
   `SLACK_ALLOWED_CHANNELS` so the agent cannot speak anywhere else by
   accident. Right-click the channel, **Copy link**, the id is the `C...` part.

## Scopes, and what breaks without each one

| Scope | Needed for | Symptom when missing |
| --- | --- | --- |
| `channels:history` | reading public channels | no events arrive, no error |
| `groups:history` | reading private channels | same, in private channels |
| `im:history` | reading DMs sent to the agent | DM path silently dead |
| `chat:write` | posting anywhere | `missing_scope` on send |
| `im:write` | opening a DM to a person | `missing_scope`, and this is the one people forget |
| `users:read` | display names in logs | logs show raw `U01ABC` ids, nothing else breaks |

The outbound adapter maps Slack failures to stable codes — `missing_scope`,
`not_in_channel`, `channel_not_found` — so the decision log says what to fix
instead of showing a stack trace.

## Things that will bite you

- **Reply loops.** The pipeline drops events where `actor.is_agent` is true.
  Do not remove that check. Without it the first reply starts a loop.
- **Socket Mode needs no public URL.** If you find yourself setting up ngrok,
  stop: you are on the wrong path.
- **Message subtypes.** Joins, leaves, edits and file comments are not
  conversation, and `toContextEvent` returns `null` for them.
- **Markup.** `toPlainText` strips mention syntax, channel refs and link
  markup. The core should never see an angle bracket.
