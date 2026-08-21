import type { AgentTool } from "./tools.js";

/**
 * `(asset, python)`'s tool registry (S5h, `python-compute.md` §2.1, ROADMAP.md: "the tool
 * registry keys on `(kind, mode)`, not `kind`"). **Empty, always — not a filtered list, an
 * empty one.** A Python job has no tool surface at all: no `page.*`, no `mcp.*`, no
 * `assets.*`, no `store.*`, not even `emit`/`done`/`fail`. There is no host bridge for a
 * Python program to call through in the first place — inputs are resolved by the host before
 * the process starts and outputs are collected after it exits, so there is no channel a tool
 * call could cross and nothing here for one to *do*. That claim survived the S5h reshape
 * unchanged: it was never a property of the microVM, only of the fact that a Python job talks
 * to the host through a directory and an exit code rather than through a call.
 *
 * This function exists so that claim is a literal, testable assertion
 * (`python-registry-isolation.test.ts`) rather than a fact about an executor that simply
 * never imports `tools.ts` — `PythonExecutor` itself (`packages/engine`) never calls this;
 * it has no LLM loop and no tool-call surface to hand a registry to at all. The function is
 * the same shape as `buildToolRegistry`/`buildAssetToolRegistry`/`buildDecisionToolRegistry`
 * purely so the four `(kind, mode)` registries are enumerable and comparable side by side.
 */
export function buildPythonToolRegistry(): AgentTool[] {
  return [];
}
