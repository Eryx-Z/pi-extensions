import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { buildRequest } from "../antigravity/stream/stream.ts";

const model = {
  id: "gemini-3.8-flash",
  provider: "antigravity",
  maxTokens: 8192,
} as Model<Api>;

const readTool = {
  name: "read",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

test("Antigravity forwards current transcript prompt and tools to the request", () => {
  const context = { messages: [
    { role: "system", content: "Use only the declared tools.", toolsAdded: [readTool], timestamp: 0 },
    { role: "user", content: "Read the file", timestamp: Date.now() },
  ] } as Context;
  const initial = buildRequest(model, context, "test-project", {}, "gemini-3.8-flash-medium");
  assert.match(initial.request.systemInstruction!.parts[0].text, /Use only the declared tools/);
  assert.deepEqual(initial.request.tools?.[0].functionDeclarations?.map((tool) => tool.name), ["read"]);

  const updatedContext = { ...context, messages: [...context.messages,
    { role: "system", content: "", toolsRemoved: [{ name: "read" }], toolsAdded: [{ ...readTool, name: "bash" }], timestamp: 1 },
  ] } as Context;
  const updated = buildRequest(model, updatedContext, "test-project", {}, "gemini-3.8-flash-medium");
  assert.deepEqual(updated.request.tools?.[0].functionDeclarations?.map((tool) => tool.name), ["bash"]);
});

test("Antigravity retains legacy context tool declarations", () => {
  const context = { systemPrompt: "Legacy instructions", tools: [readTool], messages: [
    { role: "user", content: "Read the file", timestamp: Date.now() },
  ] } as Context;
  const request = buildRequest(model, context, "test-project", {}, "gemini-3.8-flash-medium");
  assert.equal(request.request.systemInstruction!.parts[0].text, "Legacy instructions");
  assert.deepEqual(request.request.tools?.[0].functionDeclarations?.map((tool) => tool.name), ["read"]);
});
