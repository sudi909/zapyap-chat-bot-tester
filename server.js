// A bot you can actually press buttons at.
//
// This is the other end of `event_url`: it receives what the server delivers,
// checks the signature the way an integrator's code has to, prints what
// arrived, and answers. Everything a bot can do is reachable from here —
// commands inline and deferred, button presses, message rewrites, DMs.
//
// No dependencies on purpose. Node 18+ has `fetch`, `crypto` and `http` built
// in, so this runs with `node server.js` and nothing else.

import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

const PORT = Number(process.env.PORT || 3000);
const SIGNING_SECRET = process.env.SIGNING_SECRET || "";
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const BASE_URL = (process.env.BASE_URL || "http://localhost:4000").replace(/\/$/, "");
// Filled in at boot from GET /api/bot/me, so the bot can recognise its own
// messages and not answer them.
let BOT_USER_ID = null;

// Matches the server's own tolerance. A replayed delivery from an hour ago is
// refused for the same reason it is there: the signature stays valid forever,
// so freshness is the only thing bounding it.
const TOLERANCE_SECONDS = 300;

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

// --- Signature -------------------------------------------------------------

// HMAC-SHA256 over `{timestamp}.{raw body}`, hex, lowercase, `sha256=` prefixed.
//
// The RAW body, before any JSON parse: re-encoding changes key order and
// whitespace, and the digest is over bytes. Getting this wrong is the single
// most common integration bug, which is why it is spelled out here rather than
// hidden in a helper.
function verify(rawBody, headers) {
  if (!SIGNING_SECRET) return { ok: false, why: "SIGNING_SECRET is not set" };

  const timestamp = headers["x-zapyap-timestamp"];
  const signature = headers["x-zapyap-signature"];
  if (!timestamp || !signature) return { ok: false, why: "missing signature headers" };

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > TOLERANCE_SECONDS) {
    return { ok: false, why: `timestamp is ${age}s away from now` };
  }

  const expected =
    "sha256=" + createHmac("sha256", SIGNING_SECRET).update(`${timestamp}.${rawBody}`).digest("hex");

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  // Constant time, and length-checked first because timingSafeEqual throws on
  // a length mismatch rather than returning false.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, why: "signature does not match" };
  }
  return { ok: true };
}

// --- Answering late --------------------------------------------------------

// Redeem a response token. This is the path a slow command takes: answer the
// delivery with 200 and nothing, then post the real answer whenever it is
// ready, up to 15 minutes later.
async function respondLate(responseToken, body) {
  if (!BOT_TOKEN) {
    console.log(c.red("  cannot answer late: BOT_TOKEN is not set"));
    return;
  }
  const res = await fetch(`${BASE_URL}/api/bot/commands/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bot ${BOT_TOKEN}` },
    body: JSON.stringify({ response_token: responseToken, ...body }),
  });
  const text = await res.text();
  console.log(
    res.ok
      ? c.green(`  late answer posted (${res.status}) ${text}`)
      : c.red(`  late answer refused (${res.status}) ${text}`),
  );
}

// Post into a channel as the bot.
//
// A message event is NOT answered by writing into the delivery response — the
// server records that body for debugging and never acts on it. A bot replying
// to something said in a channel calls the API like any other caller, which is
// what keeps one code path for "a bot posts a message" rather than two with
// opposite rules.
async function say(channelId, content) {
  if (!BOT_TOKEN) {
    console.log(c.red("  cannot post: BOT_TOKEN is not set"));
    return;
  }
  const res = await fetch(`${BASE_URL}/api/bot/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bot ${BOT_TOKEN}` },
    body: JSON.stringify({ channel_id: channelId, content }),
  });
  const text = await res.text();
  console.log(
    res.ok
      ? c.green(`  posted (${res.status}) ${text}`)
      : c.red(`  post refused (${res.status}) ${text}`),
  );
}

// --- What this bot does ----------------------------------------------------

// Each returns the body to answer the delivery with. `{}` means "nothing to
// say", which is a success — a bot that intends to answer later does exactly
// this.
const commands = {
  "/ping": () => ({ content: "pong 🏓" }),

  "/say": (p) => ({
    content: p.text?.trim() || "you did not say anything",
    // The default is ephemeral, so this is the one that needs saying.
    visibility: "in_channel",
  }),

  "/embed": () => ({
    content: "Here is a card.",
    visibility: "in_channel",
    embeds: [
      {
        title: "Build #442",
        url: "https://ci.example.com/builds/442",
        description: "Everything passed.",
        color: "#22c55e",
        fields: [
          { name: "Environment", value: "production", inline: true },
          { name: "Duration", value: "3m 12s", inline: true },
        ],
        footer: { text: "bot-tester" },
      },
    ],
  }),

  "/buttons": () => ({
    content: "Deploy `api@1.14.2` to production?",
    visibility: "in_channel",
    actions: [
      { id: "approve", label: "Approve", style: "primary" },
      { id: "reject", label: "Reject", style: "danger" },
      { id: "later", label: "Ask me later" },
    ],
  }),

  // Buttons anyone in the room may press, rather than just whoever typed the
  // command. The opt-out, and the only way to get one.
  "/buttons-open": () => ({
    content: "Who wants lunch?",
    visibility: "in_channel",
    actions: [
      { id: "yes", label: "Me", style: "primary" },
      { id: "no", label: "Not me" },
    ],
    actions_open_to: "channel",
  }),

  // The deferred path: answer with nothing now, post for real in a moment.
  "/slow": (p) => {
    setTimeout(() => {
      void respondLate(p.response_token, {
        content: "…done. That took 3 seconds.",
        visibility: "in_channel",
      });
    }, 3000);
    return {};
  },

  // Spend the token more than once. The cap is 5; the 6th is refused.
  "/chatty": (p) => {
    for (let n = 1; n <= 6; n++) {
      setTimeout(() => {
        void respondLate(p.response_token, { content: `message ${n} of 6 (the cap is 5)` });
      }, n * 600);
    }
    return { content: "counting…" };
  },

  "/fail": () => {
    throw new Error("deliberate failure, to see what the caller is told");
  },

  "/help": () => ({
    content: [
      "**bot-tester**",
      "",
      "`/ping` — the simplest round trip",
      "`/say <text>` — posts in channel rather than to you alone",
      "`/embed` — a card",
      "`/buttons` — buttons only you may press",
      "`/buttons-open` — buttons anyone here may press",
      "`/slow` — answers 3s later, through the response token",
      "`/chatty` — spends the token 6 times; the 6th is refused",
      "`/fail` — makes this bot 500, to see the error you get",
    ].join("\n"),
  }),
};

function onCommand(p) {
  const handler = commands[p.command];
  if (!handler) {
    return {
      content: `I do not know \`${p.command}\`. Try \`/help\`.`,
    };
  }
  return handler(p);
}

// A press. The interesting part is `update`, which rewrites the message the
// button was on — that is what turns "Approve / Reject" into "Approved by Ann"
// in place, for everybody, while the reply below goes only to whoever pressed.
function onAction(p) {
  if (p.action_id === "later") {
    return { content: "Fine, I will ask again tomorrow." };
  }

  const verdict = p.action_id === "approve" ? "Approved" : "Rejected";
  return {
    content: `You ${verdict.toLowerCase()} it.`,
    update: {
      content: `**${verdict}** by ${p.user_name ?? p.username ?? "someone"}.`,
      // An empty list clears the buttons, which is how a question is marked
      // answered. Omitting the key would leave them exactly as they are.
      actions: [],
    },
  };
}

// Channel and DM traffic. Needs the `read_events` scope — commands and presses
// do not.
// Channel and DM traffic. Needs the `read_events` scope — commands and presses
// do not.
//
// This is the TELEGRAM-shaped path, and it is worth seeing next to the other
// one. A registered command never reaches here: the composer resolves it and
// calls `/api/commands/invoke`, the text is consumed, and the answer comes back
// down that request. Anything else — including a `/word` nobody registered —
// posts as an ordinary message and arrives here, where the BOT decides what it
// means. That is how Telegram works, and it is why "unknown command" is a
// sentence a bot writes rather than an error a platform returns.
function onMessage(p) {
  const text = (p.content ?? "").trim();

  // Its own messages come back here too if the bot is in the channel — the
  // server excludes the sender, but a second bot or a webhook post would not
  // be excluded, and answering one's own output is how a loop starts.
  if (p.user_id === BOT_USER_ID) {
    console.log(c.dim("  (our own message — ignoring, this is how loops start)"));
    return {};
  }

  const looksLikeCommand = /^\/[A-Za-z][A-Za-z0-9_-]*/.exec(text);
  if (looksLikeCommand) {
    const word = looksLikeCommand[0];
    console.log(c.dim(`  unregistered command ${word} — answering as a Telegram bot would`));
    void say(
      p.channel_id,
      `I don't know \`${word}\`. It isn't registered, so it reached me as an ` +
        "ordinary message. Try `/help` for what I do know.",
    );
    return {};
  }

  console.log(c.dim("  (ordinary text — nothing to say)"));
  return {};
}

// --- The server ------------------------------------------------------------

function log(payload, headers) {
  const kind = payload.event ?? "?";
  const badge = { command: c.cyan("COMMAND"), action: c.yellow("ACTION"), message: c.dim("MESSAGE") };
  console.log("");
  console.log(`${badge[kind] ?? kind}  ${c.dim(new Date().toISOString())}`);
  if (kind === "command") console.log(`  ${c.bold(payload.command)} ${payload.text ?? ""}`);
  if (kind === "action") console.log(`  ${c.bold(payload.action_id)} (${payload.action_label})`);
  if (kind === "message") console.log(`  ${payload.display_name}: ${payload.content}`);
  console.log(c.dim(`  channel=${payload.channel_id} user=${payload.user_name ?? payload.user_id}`));
  if (payload.response_token) console.log(c.dim(`  token=${payload.response_token.slice(0, 12)}…`));
  console.log(c.dim(`  ${JSON.stringify(payload)}`));
}

const server = createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end("POST only");
    return;
  }

  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const rawBody = Buffer.concat(chunks).toString("utf8");

    const check = verify(rawBody, req.headers);
    if (!check.ok) {
      console.log(c.red(`\n✗ REFUSED: ${check.why}`));
      console.log(c.dim(`  ${rawBody.slice(0, 200)}`));
      // 401 so the delivery log on the other side says `http_401` rather than
      // a transport failure. It is counted once and never retried.
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: check.why }));
      return;
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      res.writeHead(400).end("not JSON");
      return;
    }

    log(payload, req.headers);

    let answer = {};
    try {
      if (payload.event === "command") answer = onCommand(payload);
      else if (payload.event === "action") answer = onAction(payload);
      else if (payload.event === "message") answer = onMessage(payload);
    } catch (err) {
      console.log(c.red(`  handler threw: ${err.message}`));
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err.message) }));
      return;
    }

    const body = JSON.stringify(answer ?? {});
    console.log(c.green(`  → 200 ${body === "{}" ? "(nothing to say)" : body}`));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
  });
});

// Who this bot is. `GET /api/bot/me` is the handshake, exempt from rate
// limiting, and the only reason it is called here is so `onMessage` can
// recognise the bot's own posts and not reply to them.
async function whoAmI() {
  if (!BOT_TOKEN) return null;
  const res = await fetch(`${BASE_URL}/api/bot/me`, {
    headers: { Authorization: `Bot ${BOT_TOKEN}` },
  }).catch(() => null);
  if (!res?.ok) return null;
  const data = await res.json().catch(() => null);
  return data?.bot?.user_id ?? data?.user_id ?? null;
}

server.listen(PORT, async () => {
  console.log(c.bold(`bot-tester listening on http://localhost:${PORT}`));
  console.log(c.dim(`  chat server : ${BASE_URL}`));
  console.log(c.dim(`  signing key : ${SIGNING_SECRET ? "set" : c.red("MISSING — every delivery will be refused")}`));
  console.log(c.dim(`  bot token   : ${BOT_TOKEN ? "set" : "not set (late answers and posts will not work)"}`));

  BOT_USER_ID = await whoAmI();
  console.log(
    c.dim(
      `  identity    : ${BOT_USER_ID ? `user ${BOT_USER_ID}` : c.red("unknown — cannot tell its own messages apart")}`,
    ),
  );

  console.log("");
  console.log(c.dim("  Reaching this from the chat server needs ONE of:"));
  console.log(c.dim(`    a tunnel   — cloudflared tunnel --url http://localhost:${PORT}`));
  console.log(c.dim("    or the dev flags in config/dev.exs:"));
  console.log(c.dim("      allow_insecure: true, allow_private_addresses: true"));
  console.log(c.dim("    with the second, EVENT_URL=http://localhost:" + PORT + " works directly."));
});
