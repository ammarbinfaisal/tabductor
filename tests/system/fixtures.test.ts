import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtures, type Fixtures } from "@tabductor/testkit";

let fx: Fixtures;

beforeAll(async () => {
  fx = await startFixtures();
});

afterAll(async () => {
  await fx.close();
});

type Tweet = { id: string; text: string; createdAt: string };

async function timeline(): Promise<Tweet[]> {
  const res = await fetch(`${fx.url}/fake-tweets/api/timeline`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { tweets: Tweet[] };
  return body.tweets;
}

describe("fixture sites", () => {
  it("serves the fake-tweets page and timeline API", async () => {
    const res = await fetch(`${fx.url}/fake-tweets`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Tweets render client-side via a real XHR against the timeline API, so the served
    // HTML has no tweets in it. (chrome-cdp.test.ts asserts the XHR-rendered DOM.)
    expect(html).toContain("XMLHttpRequest");
    expect(html).toContain("/fake-tweets/api/timeline");
    expect(html).not.toContain("first tweet");

    const tweets = await timeline();
    expect(tweets.length).toBeGreaterThanOrEqual(3);
    for (const t of tweets) {
      expect(t.id).toBeTruthy();
      expect(t.text).toBeTruthy();
      expect(Number.isNaN(Date.parse(t.createdAt))).toBe(false);
    }
  });

  it("admin add-tweet shows up in the timeline API", async () => {
    const text = `injected at ${Date.now()}`;
    const res = await fetch(`${fx.url}/fake-tweets/admin/add-tweet`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    expect(res.status).toBe(201);
    const added = (await timeline()).find((t) => t.text === text);
    expect(added).toBeDefined();

    const status = await fetch(`${fx.url}/fake-tweets/status/${added!.id}`);
    expect(status.status).toBe(200);
    expect(await status.text()).toContain(text);
  });

  it("fake-gram records login and post submissions", async () => {
    const login = await fetch(`${fx.url}/fake-gram/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "alice", password: "hunter2" }).toString(),
    });
    expect(login.status).toBe(200);
    const post = await fetch(`${fx.url}/fake-gram/post`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        caption: "sunset",
        image_url: "http://example.test/sunset.jpg",
      }).toString(),
    });
    expect(post.status).toBe(200);

    const res = await fetch(`${fx.url}/fake-gram/admin/submissions`);
    const { submissions } = (await res.json()) as {
      submissions: { kind: string; fields: Record<string, string> }[];
    };
    expect(
      submissions.some((s) => s.kind === "login" && s.fields.username === "alice" && s.fields.password === "hunter2"),
    ).toBe(true);
    expect(
      submissions.some((s) => s.kind === "post" && s.fields.caption === "sunset"),
    ).toBe(true);
  });

  it("mutator v1 and v2 render the same data with different DOM", async () => {
    const v1 = await (await fetch(`${fx.url}/mutator`)).text();
    const v2 = await (await fetch(`${fx.url}/mutator?layout=v2`)).text();
    expect(v1).not.toBe(v2);
    expect(v1).toContain('data-testid="tweet"');
    expect(v1).toContain('data-testid="tweetText"');
    expect(v2).not.toContain("data-testid");
    expect(v2).toContain('data-qa="post-body"');
    // same underlying timeline data
    expect(v1).toContain("first tweet");
    expect(v2).toContain("first tweet");
  });

  it("slowpoke delays at least the requested time", async () => {
    for (const path of ["/slowpoke?delay_ms=300", "/slowpoke/api/data?delay_ms=300"]) {
      const started = performance.now();
      const res = await fetch(`${fx.url}${path}`);
      const elapsed = performance.now() - started;
      expect(res.status).toBe(200);
      expect(elapsed).toBeGreaterThanOrEqual(295); // small epsilon for timer granularity
    }
  });
});
