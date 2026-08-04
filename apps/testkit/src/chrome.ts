import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const CHROME_BIN =
  process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const START_TIMEOUT_MS = 30_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type Chrome = { wsUrl: string; close: () => Promise<void> };

/**
 * Spawns local Chrome headless with `--remote-debugging-port=0` on a fresh temp
 * user-data-dir, resolves the DevTools WebSocket URL via `/json/version`.
 * This locally-launched browser IS the BYO-CDP simulator: tests connect to it
 * exactly the way production connects to a user's endpoint.
 */
export async function launchChrome(): Promise<Chrome> {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "tabductor-chrome-"));
  const proc = spawn(
    CHROME_BIN,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--mute-audio",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  proc.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < 16_384) stderr += chunk.toString();
  });
  let exited = false;
  const exit = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
  void exit.then(() => {
    exited = true;
  });

  const close = async (): Promise<void> => {
    if (!exited) {
      proc.kill("SIGTERM");
      await Promise.race([exit, sleep(3_000)]);
      if (!exited) {
        proc.kill("SIGKILL");
        await exit;
      }
    }
    await rm(userDataDir, { recursive: true, force: true });
  };

  // Poll until ready — cold starts can be slow.
  const poll = async <T>(what: string, fn: () => Promise<T | null>): Promise<T> => {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exited) throw new Error(`chrome exited before ${what}; stderr: ${stderr.trim()}`);
      const value = await fn();
      if (value != null) return value;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${what}; stderr: ${stderr.trim()}`);
  };

  try {
    // With port=0 Chrome writes the chosen port to DevToolsActivePort in the profile dir.
    const port = await poll("DevToolsActivePort", async () => {
      const raw = await readFile(path.join(userDataDir, "DevToolsActivePort"), "utf8").catch(
        () => null,
      );
      const parsed = Number(raw?.split("\n")[0]?.trim());
      return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    });
    const wsUrl = await poll("/json/version", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null);
      if (!res?.ok) return null;
      const body = (await res.json()) as { webSocketDebuggerUrl?: string };
      return body.webSocketDebuggerUrl ?? null;
    });
    return { wsUrl, close };
  } catch (err) {
    await close();
    throw err;
  }
}
