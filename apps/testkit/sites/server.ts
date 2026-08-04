import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";

type Tweet = { id: string; text: string; createdAt: string };
type Submission = { kind: "login" | "post"; fields: Record<string, string>; at: string };

export type Fixtures = { port: number; url: string; close: () => Promise<void> };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function page(title: string, body: string): string {
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

function sendHtml(res: http.ServerResponse, html: string, status = 200): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function sendJson(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw === "") return {};
  const type = req.headers["content-type"] ?? "";
  if (type.includes("application/json")) return JSON.parse(raw) as Record<string, string>;
  return Object.fromEntries(new URLSearchParams(raw));
}

// --- page renderers ---------------------------------------------------------

const FAKE_TWEETS_PAGE = page(
  "Fake Tweets",
  `<h1>Timeline</h1>
<div id="timeline"></div>
<script>
var xhr = new XMLHttpRequest();
xhr.open("GET", "/fake-tweets/api/timeline");
xhr.onload = function () {
  var data = JSON.parse(xhr.responseText);
  var tl = document.getElementById("timeline");
  data.tweets.forEach(function (t) {
    var art = document.createElement("article");
    art.setAttribute("data-testid", "tweet");
    var txt = document.createElement("div");
    txt.setAttribute("data-testid", "tweetText");
    txt.textContent = t.text;
    var link = document.createElement("a");
    link.setAttribute("href", "/fake-tweets/status/" + t.id);
    link.textContent = "permalink";
    var time = document.createElement("time");
    time.setAttribute("datetime", t.createdAt);
    time.textContent = t.createdAt;
    art.appendChild(txt);
    art.appendChild(link);
    art.appendChild(time);
    tl.appendChild(art);
  });
  document.body.setAttribute("data-loaded", "true");
};
xhr.send();
</script>`,
);

function mutatorPage(tweets: Tweet[], layout: string): string {
  if (layout === "v2") {
    const items = tweets
      .map(
        (t) => `<div class="feed-row"><div class="feed-cell">
<span data-qa="post-body">${t.text}</span>
<div class="feed-meta"><a data-qa="post-link" href="/mutator/item/${t.id}">open</a>
<time data-qa="post-time" datetime="${t.createdAt}">${t.createdAt}</time></div>
</div></div>`,
      )
      .join("\n");
    return page("Mutator v2", `<main class="feed-v2"><h2>Feed</h2><section class="feed">${items}</section></main>`);
  }
  const items = tweets
    .map(
      (t) => `<article data-testid="tweet">
<div data-testid="tweetText">${t.text}</div>
<a href="/mutator/status/${t.id}">permalink</a>
<time datetime="${t.createdAt}">${t.createdAt}</time>
</article>`,
    )
    .join("\n");
  return page("Mutator", `<h1>Timeline</h1><div id="timeline">${items}</div>`);
}

const FAKE_GRAM_PAGE = page(
  "FakeGram",
  `<h1>FakeGram</h1>
<form id="login" method="post" action="/fake-gram/login">
  <input name="username" placeholder="username">
  <input name="password" type="password" placeholder="password">
  <button type="submit">Log in</button>
</form>
<form id="create-post" method="post" action="/fake-gram/post">
  <input name="caption" placeholder="caption">
  <input name="image_url" placeholder="image url">
  <button type="submit">Create post</button>
</form>`,
);

// --- server -----------------------------------------------------------------

export async function startFixtures(port = 0): Promise<Fixtures> {
  const tweets: Tweet[] = [
    { id: "t1", text: "first tweet", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "t2", text: "second tweet", createdAt: "2026-01-02T00:00:00.000Z" },
    { id: "t3", text: "third tweet", createdAt: "2026-01-03T00:00:00.000Z" },
  ];
  const submissions: Submission[] = [];

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fixtures.local");
    const route = `${req.method} ${url.pathname}`;

    // fake-tweets
    if (route === "GET /fake-tweets") return sendHtml(res, FAKE_TWEETS_PAGE);
    if (route === "GET /fake-tweets/api/timeline") return sendJson(res, { tweets });
    if (route === "POST /fake-tweets/admin/add-tweet") {
      const body = await readBody(req);
      const tweet: Tweet = {
        id: body.id ?? `t_${randomUUID().slice(0, 8)}`,
        text: body.text ?? "",
        createdAt: body.createdAt ?? new Date().toISOString(),
      };
      tweets.push(tweet);
      return sendJson(res, { tweet }, 201);
    }
    if (req.method === "GET" && url.pathname.startsWith("/fake-tweets/status/")) {
      const id = url.pathname.slice("/fake-tweets/status/".length);
      const tweet = tweets.find((t) => t.id === id);
      if (!tweet) return sendHtml(res, page("Not found", "<h1>No such tweet</h1>"), 404);
      return sendHtml(
        res,
        page(
          `Tweet ${tweet.id}`,
          `<article data-testid="tweet"><div data-testid="tweetText">${tweet.text}</div><time datetime="${tweet.createdAt}">${tweet.createdAt}</time></article>`,
        ),
      );
    }

    // fake-gram
    if (route === "GET /fake-gram") return sendHtml(res, FAKE_GRAM_PAGE);
    if (route === "POST /fake-gram/login" || route === "POST /fake-gram/post") {
      const kind = url.pathname === "/fake-gram/login" ? "login" : "post";
      submissions.push({ kind, fields: await readBody(req), at: new Date().toISOString() });
      return sendHtml(res, page("FakeGram", `<h1 data-testid="result">${kind} ok</h1>`));
    }
    if (route === "GET /fake-gram/admin/submissions") return sendJson(res, { submissions });

    // mutator (same in-memory timeline as fake-tweets, server-rendered)
    if (route === "GET /mutator") return sendHtml(res, mutatorPage(tweets, url.searchParams.get("layout") ?? "v1"));
    if (route === "GET /mutator/api/timeline") return sendJson(res, { tweets });

    // slowpoke
    if (route === "GET /slowpoke") {
      await sleep(Number(url.searchParams.get("delay_ms") ?? 0));
      return sendHtml(res, page("Slowpoke", "<h1>finally</h1>"));
    }
    if (route === "GET /slowpoke/api/data") {
      const delayMs = Number(url.searchParams.get("delay_ms") ?? 0);
      await sleep(delayMs);
      return sendJson(res, { ok: true, delayMs });
    }

    sendJson(res, { error: "not found" }, 404);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end(`fixture server error: ${String(err)}`);
    });
  });

  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const actualPort = (server.address() as AddressInfo).port;

  return {
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

// CLI entry: `pnpm --filter @tabductor/testkit fixtures` (PORT env, default 4600)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { url } = await startFixtures(Number(process.env.PORT ?? 4600));
  console.log(`fixtures listening at ${url}`);
}
