import type { TaskExecutor } from "./executor.js";
import { runStubScript } from "./stub-executor.js";

/**
 * The production skeleton for `kind=asset` (S5a). Registered for `(asset, ai)` — the only
 * mode an asset task has today — it runs the identical scripted-behavior contract
 * `StubExecutor` does (`limits_json.stub`: emit these events with these packets / fail /
 * hang), so the kind plumbing this subphase adds — the registry re-key, the write-time
 * constraints, dispatch from a browser task's event to an asset task — is fully testable
 * before there is an MCP client (S5c) or a LaTeX renderer (S5e) to drive it.
 *
 * S5c/S5d replace this file's body with real tool calls (`mcp.*`, `assets.*`); its
 * `TaskExecutor` surface is what they fill in. The registry, the run state machine and the
 * trace format do not change under them — that is the point of keeping `kind` a lookup key
 * and not a class hierarchy.
 */
export const AssetExecutor: TaskExecutor = { execute: runStubScript };
