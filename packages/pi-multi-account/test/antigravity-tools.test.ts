import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { buildRequest, convertMessages } from "../antigravity/stream/stream.ts";

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

test("parallel image tool results stay contiguous for Antigravity", () => {
  const claude = { id: "claude-opus-5-5", provider: "antigravity-account-3" } as Model<Api>;
  const image = { type: "image" as const, data: "abc", mimeType: "image/png" };
  const contents = convertMessages(claude, {
    messages: [
      { role: "user", content: "Compare the screenshots.", timestamp: 1 },
      {
        role: "assistant",
        provider: claude.provider,
        model: claude.id,
        stopReason: "toolUse",
        timestamp: 2,
        content: ["tool-1", "tool-2"].map((id) => ({
          type: "toolCall" as const,
          id,
          name: "read",
          arguments: { path: `${id}.png` },
        })),
      },
      ...["tool-1", "tool-2"].map((id) => ({
        role: "toolResult" as const,
        toolCallId: id,
        toolName: "read",
        timestamp: 3,
        content: [{ type: "text" as const, text: `Read ${id}` }, image],
      })),
    ],
  } as Context, "claude-opus-5-5-medium");

  const parts = contents.at(-1)?.parts ?? [];
  assert.deepEqual(parts.map((part) => (
    "functionResponse" in part ? `result:${part.functionResponse.id}` :
    "inlineData" in part ? "image" : "other"
  )), ["result:tool-1", "result:tool-2", "image", "image"]);
});
