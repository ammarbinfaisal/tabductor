import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "./errors.js";
import { newId } from "./ids.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";

describe("newId", () => {
  it("prefixes a uuid", () => {
    const id = newId("run");
    expect(id).toMatch(/^run_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(newId("run")).not.toBe(id);
  });
});

describe("AppError", () => {
  it("carries code and cause", () => {
    const cause = new Error("boom");
    const err = new AppError("thing_failed", "the thing failed", { cause });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("thing_failed");
    expect(err.cause).toBe(cause);
  });
});

describe("loadConfig", () => {
  it("applies local-dev defaults and parses the allowlist", () => {
    const cfg = loadConfig({});
    expect(cfg.DATABASE_URL).toContain("postgres://");
    expect(cfg.BLOB_DIR.length).toBeGreaterThan(0);
    expect(cfg.HARNESS_NAV_ALLOWLIST).toEqual(["localhost", "127.0.0.1"]);
    expect(cfg.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("honors provided values", () => {
    const cfg = loadConfig({
      DATABASE_URL: "postgres://x/db",
      HARNESS_NAV_ALLOWLIST: "x.com, instagram.com ,localhost",
      ANTHROPIC_API_KEY: "sk-test",
    });
    expect(cfg.DATABASE_URL).toBe("postgres://x/db");
    expect(cfg.HARNESS_NAV_ALLOWLIST).toEqual(["x.com", "instagram.com", "localhost"]);
    expect(cfg.ANTHROPIC_API_KEY).toBe("sk-test");
  });

  // `docker compose` renders an unset `${ANTHROPIC_API_KEY:-}` as an empty string rather than
  // omitting the variable. Empty has to read as absent, or declaring the setting in compose and
  // leaving it unset would throw config_invalid and take the web app down on boot.
  it("reads an empty optional setting as absent rather than invalid", () => {
    const cfg = loadConfig({ ANTHROPIC_API_KEY: "" });
    expect(cfg.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe("createLogger", () => {
  afterEach(() => vi.restoreAllMocks());

  it("emits JSON lines and respects level", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = createLogger({ name: "test", level: "info" });

    logger.debug("hidden");
    logger.info("hello", { a: 1 });
    logger.error("bad");

    expect(log).toHaveBeenCalledTimes(1);
    const line = JSON.parse(log.mock.calls[0]![0] as string);
    expect(line).toMatchObject({ level: "info", name: "test", msg: "hello", a: 1 });
    expect(typeof line.time).toBe("string");
    expect(error).toHaveBeenCalledTimes(1);
  });
});
