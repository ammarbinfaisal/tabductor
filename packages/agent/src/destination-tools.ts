import { z } from "zod";
import { AppError } from "@tabductor/core";
import { destinationMappingSchema, type RunHandle } from "@tabductor/engine";
import type { RunSession } from "@tabductor/browser";
import { defineTool, type AgentTool } from "./tools.js";

export function destinationTools(session: RunSession, destination: RunHandle["destination"], requestHuman: RunHandle["requestHumanAction"]): AgentTool[] {
  return [
    ...(destination && destination.role !== "prepare-destination" ? [
      defineTool({ name: "destination.contract.read", description: "Read the immutable destination mapping referenced by this trigger. Scoped to this execution and database; includes observed fields, content mapping and verification requirements.",
        parameters: z.object({ id: z.string().optional() }), async execute({ id }) { return { ok: true, value: await destination.read(id) }; } }),
    ] : []),
    ...(destination?.role === "prepare-destination" ? [
      defineTool({ name: "destination.contract.publish", description: "Setup task only: publish the observed mapping after all required fields have a usable location. The engine emits readiness atomically; do not emit readiness yourself. Retries reconcile the existing mapping. Labels must occur in current perception.",
        parameters: destinationMappingSchema, async execute(mapping) {
          const p = await session.page.perceive({ maxChars: 20000, elementLimit: 100 });
          return { ok: true, value: await destination.publish(mapping, { url: p.url, snapshotId: p.snapshotId!, observedLabels: [p.text, ...p.elements.flatMap(e => [e.name ?? "", e.text ?? ""])] }) };
        } }),
    ] : []),
    ...(requestHuman ? [defineTool({ name: "human_action.request", description: "Suspend only for an observed blocker requiring human input that available tools and authorized information cannot resolve, such as an unavailable password, MFA/device approval, CAPTCHA, or unresolved account choice. First attempt the user's requested sign-in flow, including Login with Google and the intended existing account. A login page or sign-in button alone does not require takeover. Describe the concrete blocker and resume condition. Saves durable state and waits for explicit human resume without model polling.",
      parameters: z.object({ reason: z.string().min(1).max(1000), resumeWhen: z.string().min(1).max(1000) }), async execute(input) {
        await requestHuman(input);
        throw new AppError("human_action_pending", "Run suspended until the user resumes browser automation");
      } })] : []),
  ];
}
