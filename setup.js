// One command to get from nothing to a bot you can talk to.
//
// Walks the admin API the settings screen walks: create, install, grant scopes,
// point it at your tunnel, register commands, switch DMs on, mint a webhook,
// read the signing secret. Prints an .env you can paste.
//
//   SESSION_TOKEN=... EVENT_URL=https://x.trycloudflare.com node setup.js
//
// Re-runnable: pass BOT_ID to update the bot you already made rather than
// making another.

const BASE_URL = (process.env.BASE_URL || "http://localhost:4000").replace(/\/$/, "");
const SESSION_TOKEN = process.env.SESSION_TOKEN;
const WORKSPACE = process.env.WORKSPACE_SLUG || "default";
const EVENT_URL = process.env.EVENT_URL;
const BOT_NAME = process.env.BOT_NAME || "Testbot";
const CHANNEL_ID = process.env.CHANNEL_ID;
let BOT_ID = process.env.BOT_ID;

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

if (!SESSION_TOKEN) {
  console.error(c.red("SESSION_TOKEN is required — a workspace owner/admin session token."));
  console.error("Sign in to the web app, then copy it out of your browser's storage.");
  process.exit(1);
}

async function api(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SESSION_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    console.error(c.red(`\n✗ ${method} ${path} → ${res.status}`));
    console.error(c.dim(typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2)));
    process.exit(1);
  }
  return parsed;
}

function step(n, what) {
  console.log(`${c.bold(`${n}.`)} ${what}`);
}

const ws = `/api/workspaces/${WORKSPACE}`;

// --- Pick a channel --------------------------------------------------------

let channelId = CHANNEL_ID;
if (!channelId) {
  step(0, "finding a channel to put the bot in");
  const { channels } = await api("GET", "/api/channels");
  const usable = (channels ?? []).filter((ch) => ch.kind === "channel" && !ch.archived_at);
  if (usable.length === 0) {
    console.error(c.red("No channel found. Create one first, or pass CHANNEL_ID."));
    process.exit(1);
  }
  channelId = usable[0].id;
  console.log(c.dim(`   using #${usable[0].name} (${channelId})`));
}

// --- The bot ---------------------------------------------------------------

let botToken;

if (BOT_ID) {
  step(1, `reusing bot ${BOT_ID}`);
} else {
  step(1, `creating "${BOT_NAME}"`);
  const created = await api("POST", `${ws}/bots`, {
    name: BOT_NAME,
    username: BOT_NAME.toLowerCase().replace(/[^a-z0-9]/g, "") + Date.now().toString().slice(-4),
    // `read_events` is what lets it hear what people TYPE. Commands and button
    // presses reach it without this.
    scopes: ["send_messages", "read_events", "read_history"],
  });
  BOT_ID = created.bot.id;
  botToken = created.token;
  console.log(c.dim(`   id ${BOT_ID}`));
  console.log(c.dim(`   token shown once: ${botToken}`));
}

step(2, "installing it in the channel");
await api("POST", `${ws}/bots/${BOT_ID}/channels`, { channel_id: channelId });

if (EVENT_URL) {
  step(3, `pointing it at ${EVENT_URL}`);
  await api("PATCH", `${ws}/bots/${BOT_ID}`, { event_url: EVENT_URL });
} else {
  step(3, c.red("no EVENT_URL given — commands, buttons and DMs will not fire"));
  console.log(c.dim("   start a tunnel, then re-run with EVENT_URL=https://…"));
}

step(4, "registering slash commands");
await api("PUT", `${ws}/bots/${BOT_ID}/commands`, {
  commands: [
    { command: "/ping", description: "The simplest round trip" },
    { command: "/say", description: "Post something in channel", usage_hint: "<text>" },
    { command: "/embed", description: "Post a card" },
    { command: "/buttons", description: "Buttons only you may press" },
    { command: "/buttons-open", description: "Buttons anyone here may press" },
    { command: "/slow", description: "Answers 3s later, via the response token" },
    { command: "/chatty", description: "Spends the response token past its cap" },
    { command: "/fail", description: "Makes the bot 500, to see the error" },
    { command: "/help", description: "What this bot can do" },
  ],
});

step(5, "switching DMs on");
await api("PATCH", `${ws}/bots/${BOT_ID}`, {
  dm_enabled: true,
  description: "A bot for poking at commands, buttons and webhooks.",
});

step(6, "minting an incoming webhook");
const webhook = await api("POST", `${ws}/bots/${BOT_ID}/webhook`, { channel_id: channelId });

step(7, "reading the signing secret");
const secret = await api("POST", `${ws}/bots/${BOT_ID}/signing-secret`);

// --- What you need ---------------------------------------------------------

const lines = [
  `BASE_URL=${BASE_URL}`,
  `BOT_ID=${BOT_ID}`,
  `SIGNING_SECRET=${secret.signing_secret}`,
  `WEBHOOK_URL=${webhook.webhook_url}`,
];
if (botToken) lines.push(`BOT_TOKEN=${botToken}`);
if (EVENT_URL) lines.push(`EVENT_URL=${EVENT_URL}`);

console.log("");
console.log(c.green("Done. Paste this into .env:"));
console.log("");
console.log(lines.join("\n"));
console.log("");
if (!botToken) {
  console.log(c.dim("BOT_TOKEN is not here: it is shown once, at creation. Issue a new one with"));
  console.log(c.dim(`  curl -X POST ${BASE_URL}${ws}/bots/${BOT_ID}/token -H "Authorization: Bearer $SESSION_TOKEN"`));
  console.log(c.dim("(which revokes the old one)."));
  console.log("");
}
console.log(c.dim("Then: node --env-file=.env server.js"));
