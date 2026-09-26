import { expect, it } from "vitest";
import { promptInputNames, promptInputsSchema, resolvePromptInputs, workflowPromptInputNames } from "./prompt-inputs.js";

it("discovers unique hyphenated inputs while preserving prices and escaped dollars", () => {
  expect(promptInputNames("Write $reply-style about $topic. $reply-style costs $20. $$literal", "$topic $_name")).toEqual(["reply-style", "topic", "_name"]);
  expect(resolvePromptInputs("prefix$left$right", { left: "A", right: "B" })).toBe("prefixAB");
  expect(workflowPromptInputNames({ automationPrompt: "$topic", tasks: [{ prompt: "$reply-style" }] })).toEqual(["topic", "reply-style"]);
});

it("resolves once without interpreting replacement values as code or more variables", () => {
  expect(resolvePromptInputs("$topic / $topic / $$literal / $20", { topic: "$other $& 'quoted'\nnew line" }))
    .toBe("$other $& 'quoted'\nnew line / $other $& 'quoted'\nnew line / $literal / $20");
  expect(() => resolvePromptInputs("$missing", {})).toThrow("Missing prompt input: $missing");
  expect(() => resolvePromptInputs("$constructor", {})).toThrow("Missing prompt input");
});

it("validates text inputs and rejects empty, malformed and excessive values", () => {
  expect(promptInputsSchema.parse({ "reply-style": "  concise  " })).toEqual({ "reply-style": "  concise  " });
  for (const input of [{ topic: " " }, { "$topic": "news" }, { topic: 3 }, { topic: "x".repeat(20001) }]) {
    expect(promptInputsSchema.safeParse(input).success).toBe(false);
  }
});
