# zapyap-chat-bot-tester

A bot you can actually press buttons at, for poking Zapyap Chat's bot surfaces
by hand.

Standalone — it talks to the chat server over HTTP and shares nothing with it,
so it can point at localhost, UAT or production by changing one variable.

Three files, no dependencies. Node 18+ has everything they use.

| | |
|---|---|
| `setup.js` | Walks the admin API: creates a bot, installs it, registers commands, switches DMs on, mints a webhook, reads the signing secret. Prints an `.env`. |
| `server.js` | The other end of `event_url`. Verifies the signature, prints what arrived, and answers — commands inline and deferred, button presses, message rewrites. |
| `send.js` | Posts into a channel through the incoming webhook, with presets for every payload shape it accepts — including Slack's two and Discord's. |

---

## The one thing that will catch you out

**The chat server will not deliver to `localhost` out of the box.** It refuses
private, loopback and link-local addresses — that check is the SSRF defence,
and it is on by default in every environment.

There are two ways round it, and the second needs no tunnel.

It fails in two different places depending on the scheme, and both are worth
recognising:

```
PATCH …/bots/:id  {"event_url": "http://localhost:3000"}
  → 422 {"errors":{"event_url":["must be an https URL"]}}      refused at WRITE time

PATCH …/bots/:id  {"event_url": "https://localhost:3000"}
  → 200                                                        accepted…
POST /api/commands/invoke  {"command": "/ping"}
  → 502 {"error":"command_delivery_failed","reason":"blocked_address"}   …refused at DELIVERY time
```

The second is the confusing one: the URL saves fine and the bot looks configured.

### Either: a tunnel

```bash
cloudflared tunnel --url http://localhost:3000     # prints https://….trycloudflare.com
# or
ngrok http 3000
```

That URL is your `EVENT_URL`. This is what Slack and Discord both require, and
it is the right answer for anything shared.

### Or: allow it in local dev

A development server can be configured to permit both plain http and private
addresses; see the chat server's own configuration docs for the two settings.
With both on, `EVENT_URL=http://localhost:3000` works directly.

Development only. The second of them switches off the check that stops a bot's
event URL reaching your database, your cache, or a cloud metadata endpoint —
and a production release cannot pick either up from the environment.

`send.js` needs neither — it calls the chat server, not the other way round, so
the webhook half works against `localhost` with nothing in front of it.

---

## Getting going

```bash
cd ~/Projects/zapyap-chat-bot-tester

# 1. a tunnel, in its own terminal
cloudflared tunnel --url http://localhost:3000

# 2. wire up a bot. SESSION_TOKEN is a workspace owner/admin session —
#    sign in to the web app and copy it out of browser storage.
SESSION_TOKEN=ey… EVENT_URL=https://something.trycloudflare.com node setup.js

# 3. paste what it printed into .env, then run the bot
node --env-file=.env server.js

# 4. in the app: type /help in the channel it joined
```

`setup.js` takes `BASE_URL` (default `http://localhost:4000`), `WORKSPACE_SLUG`
(default `default`), `CHANNEL_ID` (defaults to the first channel it finds),
`BOT_NAME`, and `BOT_ID` — pass that last one to update the bot you already
made instead of creating another.

---

## What to try

### Commands

Type these in a channel the bot is in, or in a DM with it.

| | What it shows |
|---|---|
| `/ping` | The round trip works. Ephemeral — only you see it. |
| `/say hello` | `visibility: "in_channel"`, so it is a real message everybody sees. |
| `/embed` | A card. |
| `/buttons` | Buttons bound to **you**. Ask somebody else to press one: they are told `not_your_action`. |
| `/buttons-open` | `actions_open_to: "channel"` — anyone in the room may press. |
| `/slow` | Answers 200 with nothing, then posts 3s later against the response token. Needs `BOT_TOKEN`. |
| `/chatty` | Spends the token six times. The cap is five, so watch the sixth be refused. |
| `/fail` | The bot 500s. You get `command_delivery_failed` with `http_500`, and it is **not** retried. |

Pressing a button on `/buttons` rewrites the message in place for everyone
*and* sends a private line to whoever pressed — the two directives are
independent, which is the point of them being separate.

### Webhooks

```bash
node --env-file=.env send.js                    # list the presets
node --env-file=.env send.js slack-blocks       # send one
node --env-file=.env send.js all                # send every one
```

`slack-text`, `slack-blocks`, `slack-attachments` and `discord` are payloads
written for other products, sent unchanged. If one of those stops rendering,
this is where it shows. `too-long` and `empty` are expected to be refused —
they are there so you can see what a refusal looks like.

### DMs

`setup.js` switches DMs on, so the bot appears under **Bots** in the
new-message sheet. Open one and type `/ping`.

Then try typing an ordinary sentence. It arrives as a `message` event — but
only because `setup.js` granted `read_events`. Take that scope away and the
commands keep working while every sentence you type is dropped, which is the
asymmetry worth seeing once with your own eyes.

### Refusals

With the bot running, the signature check is easy to break on purpose:

```bash
# a delivery it should refuse — wrong key
SIGNING_SECRET=wrong node --env-file=.env server.js
```

Every delivery now answers 401, and `GET /api/workspaces/:slug/bots/:id/deliveries`
records `http_401`. Twenty consecutive failures disable the bot; re-enable with
`POST …/bots/:id/enable`, which also clears the counter.

---

## What this does not cover

- **`actions` blocks inside a Slack payload.** They are not translated — a
  button needs an event URL and an audience, and a webhook bot has neither by
  default. Use the native `actions` key, which `send.js buttons` demonstrates.
- **The MCP endpoint.** Point an MCP client at `/mcp` with the same bot token.
- **Signature verification on the way IN.** This bot verifies what it receives;
  it does not exercise the identity webhook, which shares the scheme.

The full reference lives with the chat server's own documentation, in its
sections on webhooks, commands, buttons and DMs.
