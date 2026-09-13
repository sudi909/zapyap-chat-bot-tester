// Post into a channel through an incoming webhook.
//
//   node --env-file=.env send.js              list the presets
//   node --env-file=.env send.js slack-blocks send one
//   node --env-file=.env send.js all          send every one, in order
//
// The point of the presets is that several of them are payloads written for
// OTHER products — Slack's two shapes and Discord's key — which this endpoint
// accepts unchanged. If one of those stops rendering, this is where it shows.

const WEBHOOK_URL = process.env.WEBHOOK_URL;

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

const presets = {
  plain: {
    note: "The whole API, for most callers.",
    body: { content: "Build #442 passed in 3m12s" },
  },

  markdown: {
    note: "Body is markdown.",
    body: {
      content: [
        "**Deploy finished**",
        "",
        "- `api` → 1.14.2",
        "- `erp` → 2.3.0",
        "",
        "> Rolled out to production.",
        "",
        "[See the run](https://ci.example.com/442)",
      ].join("\n"),
    },
  },

  "slack-text": {
    note: "What scripts/_apps.sh notify() sends. `text` is an alias for `content`.",
    body: { text: "[droplet-1] leapcount ✅ deployed: web — rolled out api, erp (tag=v42)" },
  },

  discord: {
    note: "Discord's key for the same thing. Also an alias.",
    body: { content: "Same field, different product." },
  },

  "slack-blocks": {
    note: "Slack Block Kit — what auth.leapcount's FeedbackController sends.",
    body: {
      text: "New Feedback: Export is slow",
      blocks: [
        { type: "header", text: { type: "plain_text", text: "Export is slow", emoji: true } },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "The *CSV export* takes ~40s on big tenants. See <https://erp.example.com/r|the report>.",
          },
        },
        { type: "divider" },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: "*Category:*\nPerformance" },
            { type: "mrkdwn", text: "*Rating:*\n⭐⭐⭐☆☆ (3/5)" },
            { type: "mrkdwn", text: "*App Context:*\nerp-web" },
            {
              type: "mrkdwn",
              text: "*Submitted:*\n<!date^1789123262^{date_short_pretty} at {time}|11 Sep 2026>",
            },
          ],
        },
        { type: "context", elements: [{ type: "mrkdwn", text: "Posted via LeapCount Auth" }] },
      ],
    },
  },

  "slack-attachments": {
    note: "Slack's older shape — the one with the coloured bar. One card each.",
    body: {
      attachments: [
        {
          fallback: "Deploy failed: api @ 1.14.2",
          color: "danger",
          pretext: "A build needs you",
          author_name: "LeapCount CI",
          author_link: "https://ci.example.com",
          title: "api @ 1.14.2",
          title_link: "https://ci.example.com/builds/442",
          text: "Migration timed out after 30s.",
          fields: [
            { title: "Environment", value: "production", short: true },
            { title: "Duration", value: "3m 12s", short: true },
            { title: "Log", value: "see <https://ci.example.com/442|the run>" },
          ],
          footer: "LeapCount CI",
          ts: 1789123262,
        },
        { color: "good", title: "erp @ 2.3.0", text: "Deployed cleanly." },
      ],
    },
  },

  embed: {
    note: "This product's own card format.",
    body: {
      content: "Deploy of api@1.14.2 failed",
      embeds: [
        {
          title: "api @ 1.14.2",
          url: "https://ci.example.com/builds/442",
          description: "Migration timed out after 30s.",
          color: "#d64545",
          timestamp: "2026-09-11T09:41:02Z",
          author: { name: "CI" },
          footer: { text: "build #442" },
          fields: [
            { name: "Environment", value: "production", inline: true },
            { name: "Duration", value: "3m 12s", inline: true },
          ],
        },
      ],
    },
  },

  identity: {
    note: "Per-post name and avatar, overriding the bot's own.",
    body: {
      content: "Posted as somebody else entirely.",
      username: "Nightly Job",
      icon_url: "https://avatars.githubusercontent.com/u/9919?s=200&v=4",
    },
  },

  buttons: {
    note: "Buttons from a webhook. Needs an event URL on the bot, and an audience.",
    body: {
      content: "Roll back to 1.14.1?",
      actions: [
        { id: "rollback", label: "Roll back", style: "danger" },
        { id: "keep", label: "Keep it" },
      ],
      // A webhook post is unprompted, so there is nobody it is answering and
      // no audience to infer. Without this it is refused.
      actions_open_to: "channel",
    },
  },

  "too-long": {
    note: "Over the 4000-character cap — expect 422 message_too_long.",
    body: { content: "x".repeat(4001) },
  },

  empty: {
    note: "No content at all — expect 422 missing_content.",
    body: { embeds: [{ title: "A card and nothing else" }] },
  },
};

async function send(name) {
  const preset = presets[name];
  console.log(`${c.bold(name)} ${c.dim("— " + preset.note)}`);
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(preset.body),
  });
  const text = await res.text();
  const line = `  ${res.status} ${text}`;
  console.log(res.ok ? c.green(line) : c.red(line));
  return res.ok;
}

const [, , which] = process.argv;

if (!WEBHOOK_URL) {
  console.error(c.red("WEBHOOK_URL is not set. Run setup.js, or copy the URL from the bots screen."));
  process.exit(1);
}

if (!which) {
  console.log(c.bold("presets"));
  for (const [name, { note }] of Object.entries(presets)) {
    console.log(`  ${name.padEnd(20)} ${c.dim(note)}`);
  }
  console.log("");
  console.log(c.dim("  node --env-file=.env send.js <name>   one of them"));
  console.log(c.dim("  node --env-file=.env send.js all      every one, in order"));
  process.exit(0);
}

if (which === "all") {
  for (const name of Object.keys(presets)) {
    await send(name);
    // The endpoint allows 60/min per IP; this keeps a full run well under it
    // and keeps the messages in a readable order.
    await new Promise((r) => setTimeout(r, 300));
  }
} else if (presets[which]) {
  await send(which);
} else {
  console.error(c.red(`no preset "${which}". Run without an argument to list them.`));
  process.exit(1);
}
