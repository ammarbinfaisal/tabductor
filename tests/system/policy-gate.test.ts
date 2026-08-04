import { describe, expect, it } from "vitest";
import { AllowAllGate, type TaskCtx } from "@tabductor/policy";

const ctx: TaskCtx = { taskId: "task_1", runId: "run_1" };

describe("AllowAllGate", () => {
  it("allows actions, network reads and MCP calls, and redacts nothing", async () => {
    const gate = new AllowAllGate({ navAllowlist: [] });
    expect(await gate.checkAction(ctx, { kind: "click", selector: "#go" })).toEqual({ allow: true });
    expect(await gate.checkNetworkRead(ctx, { index: 0, url: "http://x" }, { body: true })).toEqual({
      allow: true,
    });
    expect(await gate.checkMcpCall(ctx, "mcp.imagegen.create")).toEqual({ allow: true });

    const payload = { headers: { authorization: "Bearer secret" }, body: "hi" };
    expect(gate.redact(ctx, payload)).toBe(payload); // identity until Phase 7
  });

  it("allows every navigation when the allowlist is unset/empty", async () => {
    const gate = new AllowAllGate({ navAllowlist: [] });
    for (const url of ["https://example.com/a", "http://localhost:3000", "https://x.com"]) {
      expect(await gate.checkNavigation(ctx, new URL(url), "initial")).toEqual({ allow: true });
    }
  });

  it("denies navigation outside HARNESS_NAV_ALLOWLIST and allows subdomains inside it", async () => {
    const gate = new AllowAllGate({ navAllowlist: ["x.com", "localhost"] });

    expect(await gate.checkNavigation(ctx, new URL("https://x.com/home"), "initial")).toEqual({
      allow: true,
    });
    expect(await gate.checkNavigation(ctx, new URL("https://api.x.com/v1"), "redirect")).toEqual({
      allow: true,
    });
    expect(await gate.checkNavigation(ctx, new URL("http://localhost:8080/f"), "initial")).toEqual({
      allow: true,
    });

    expect(await gate.checkNavigation(ctx, new URL("https://example.com"), "redirect")).toEqual({
      allow: false,
      rule: "harness_nav_allowlist",
    });
    // Suffix confusion must not slip through.
    expect(await gate.checkNavigation(ctx, new URL("https://notx.com"), "window_open")).toEqual({
      allow: false,
      rule: "harness_nav_allowlist",
    });
  });

  it("defaults its allowlist from core config when none is injected", async () => {
    const previous = process.env.HARNESS_NAV_ALLOWLIST;
    process.env.HARNESS_NAV_ALLOWLIST = "fixtures.test";
    try {
      const gate = new AllowAllGate();
      expect(await gate.checkNavigation(ctx, new URL("https://fixtures.test/p"), "initial")).toEqual({
        allow: true,
      });
      expect(await gate.checkNavigation(ctx, new URL("https://example.com"), "initial")).toEqual({
        allow: false,
        rule: "harness_nav_allowlist",
      });
    } finally {
      if (previous === undefined) delete process.env.HARNESS_NAV_ALLOWLIST;
      else process.env.HARNESS_NAV_ALLOWLIST = previous;
    }
  });
});
