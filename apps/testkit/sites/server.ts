import http from "node:http";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";

type Tweet = { id: string; text: string; createdAt: string };
type Submission = { kind: "login" | "post" | "upload"; fields: Record<string, string>; at: string };

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

async function readRawBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, string>> {
  const raw = (await readRawBody(req)).toString("utf8");
  if (raw === "") return {};
  const type = req.headers["content-type"] ?? "";
  if (type.includes("application/json")) return JSON.parse(raw) as Record<string, string>;
  return Object.fromEntries(new URLSearchParams(raw));
}

/** One `multipart/form-data` file part — S5f deliverable 3. Hand-rolled rather than a new
 * dependency (house rule: no new deps for this fixture): the browser's own multipart encoder
 * (whichever engine — Playwright's `setInputFiles` + a real form submit, same as a user's own
 * browser) is well-formed enough that a boundary-split plus a `Content-Disposition` regex is
 * all a *test fixture* needs — this is not a general-purpose multipart parser, the same "crude
 * is fine, this is a fixture" posture `apps/testkit`'s other hand-rolled bits take. */
type MultipartFile = { fieldName: string; filename: string; contentType: string; data: Buffer };

const CRLFCRLF = Buffer.from("\r\n\r\n");
const DISPOSITION_RE = /Content-Disposition:\s*form-data;\s*name="([^"]*)"(?:;\s*filename="([^"]*)")?/i;
const CONTENT_TYPE_RE = /Content-Type:\s*([^\r\n]+)/i;

/** Splits a multipart body on `--<boundary>` markers and pulls each part's headers/body apart
 * on the first blank line — bytes past that point are never touched as text, so a binary
 * (PDF) part survives round-trip untouched. */
function parseMultipart(body: Buffer, boundary: string): { fields: Record<string, string>; files: MultipartFile[] } {
  const marker = Buffer.from(`--${boundary}`);
  const fields: Record<string, string> = {};
  const files: MultipartFile[] = [];

  let cursor = body.indexOf(marker);
  while (cursor !== -1) {
    const next = body.indexOf(marker, cursor + marker.length);
    if (next === -1) break;

    let start = cursor + marker.length;
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2; // leading CRLF
    let end = next;
    if (body[end - 2] === 0x0d && body[end - 1] === 0x0a) end -= 2; // trailing CRLF before next marker

    if (end > start) {
      const part = body.subarray(start, end);
      const headerEnd = part.indexOf(CRLFCRLF);
      if (headerEnd !== -1) {
        const headerText = part.subarray(0, headerEnd).toString("utf8");
        const data = part.subarray(headerEnd + CRLFCRLF.length);
        const disposition = DISPOSITION_RE.exec(headerText);
        if (disposition) {
          const [, name, filename] = disposition;
          if (filename !== undefined) {
            const contentType = CONTENT_TYPE_RE.exec(headerText)?.[1]?.trim() ?? "application/octet-stream";
            files.push({ fieldName: name!, filename, contentType, data });
          } else {
            fields[name!] = data.toString("utf8");
          }
        }
      }
    }
    cursor = next;
  }
  return { fields, files };
}

function multipartBoundary(req: http.IncomingMessage): string | undefined {
  const contentType = req.headers["content-type"] ?? "";
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  return match ? (match[1] ?? match[2])?.trim() : undefined;
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

// Element order here is anchor order for every `perceive()` snapshot of this page — S5b's
// recorded transcripts (`tests/system/fixtures/transcripts/*.jsonl`) hardcode anchors like
// `e5`/`e7` against the login/create-post forms above, so anything added to this page goes
// *after* them (the hidden field below), never between or before.
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
</form>
<!-- S5b target-validation fixture: a hidden field the secrets broker must refuse to fill. -->
<input type="hidden" name="csrf_token" data-testid="csrfHidden">
<!-- S5f deliverable 1/3: the page.upload fixture. Must stay last — see the comment above. -->
<form id="upload" method="post" action="/fake-gram/upload" enctype="multipart/form-data">
  <input type="file" name="file" data-testid="uploadFile">
  <button type="submit" data-testid="uploadSubmit">Upload</button>
</form>`,
);

/**
 * S5b target-validation fixture: an iframe embedding `src` (typically another fixture
 * instance's origin) so a test can hand the broker a locator that only resolves *inside* a
 * cross-origin child frame — the shape `probeTarget`'s frame-origin check exists to catch.
 */
function iframeWrapPage(src: string): string {
  return page("Iframe wrap", `<h1>Iframe wrap</h1><iframe src="${src}"></iframe>`);
}

/**
 * The two ways a navigation happens without anyone calling `goto` — a server redirect and a
 * script-opened window. Both are S3a navigation-guard fixtures: a guard that only wrapped
 * `goto` would wave both of these straight through.
 */
function popupPage(to: string): string {
  // A listener rather than an inline `onclick`: the target is a URL, `JSON.stringify` quotes
  // it with `"`, and `"` inside a double-quoted HTML attribute ends the attribute.
  return page(
    "Popup opener",
    `<h1>Opener</h1>
<button data-testid="open">open</button>
<script>
document.querySelector('[data-testid="open"]').addEventListener("click", function () {
  window.open(${JSON.stringify(to)}, "_blank");
});
</script>`,
  );
}

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
    if (route === "POST /fake-gram/upload") {
      const boundary = multipartBoundary(req);
      if (!boundary) return sendJson(res, { error: "missing multipart boundary" }, 400);
      const raw = await readRawBody(req);
      const { files } = parseMultipart(raw, boundary);
      const file = files.find((f) => f.fieldName === "file");
      if (!file) return sendJson(res, { error: "no file field" }, 400);
      const sha256 = createHash("sha256").update(file.data).digest("hex");
      submissions.push({
        kind: "upload",
        fields: { filename: file.filename, mime: file.contentType, sha256, size: String(file.data.byteLength) },
        at: new Date().toISOString(),
      });
      return sendHtml(res, page("FakeGram", `<h1 data-testid="result">upload ok</h1>`));
    }
    if (route === "GET /fake-gram/admin/submissions") return sendJson(res, { submissions });
    if (route === "GET /iframe-wrap") {
      return sendHtml(res, iframeWrapPage(url.searchParams.get("src") ?? `${url.origin}/fake-gram`));
    }

    // mutator (same in-memory timeline as fake-tweets, server-rendered)
    if (route === "GET /mutator") return sendHtml(res, mutatorPage(tweets, url.searchParams.get("layout") ?? "v1"));
    if (route === "GET /mutator/api/timeline") return sendJson(res, { tweets });

    // navigation-guard fixtures
    if (route === "GET /redirect") {
      const to = url.searchParams.get("to") ?? "/fake-tweets";
      res.writeHead(302, { location: to });
      res.end();
      return;
    }
    if (route === "GET /popup") {
      return sendHtml(res, popupPage(url.searchParams.get("to") ?? "/fake-tweets"));
    }

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
