import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
	CLAUDE_CODE_VERSION,
	rewriteDeveloperRoleToSystem,
	shapeAnthropicOAuthPayload,
} from "../request-shaping.ts";

const IDENTITY = "You are Claude Code, Anthropic's official CLI for working.";
const PI_PREFIX =
	"You are an expert coding assistant operating inside pi, a coding agent harness.";
const PI_TERMINATOR =
	"- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)";
const MINIMAL_PROMPT = [
	"You are an expert coding assistant.",
	"Be concise and helpful.",
	"Use the available tools to answer the user's request.",
	"Show file paths clearly when working with files.",
].join("\n");

function oauthPayload(systemText = IDENTITY) {
	return {
		model: "claude-opus-4-8",
		stream: true,
		messages: [{ role: "user", content: "hello world this is a test message" }],
		system: [{ type: "text", text: systemText }],
	};
}

test("non-target and malformed payloads retain their original identity and contents", () => {
	const oauth = oauthPayload();
	for (const payload of [
		null,
		undefined,
		"not a request",
		[],
		{},
		{ ...oauth, model: 1 },
		{ ...oauth, messages: {} },
		{ ...oauth, stream: undefined },
		{ ...oauth, system: IDENTITY },
		{ ...oauth, system: [{ type: "text", text: "API-key system prompt" }] },
	]) {
		const before = structuredClone(payload);
		assert.equal(shapeAnthropicOAuthPayload(payload), payload);
		assert.deepEqual(payload, before);
	}
});

test("billing header uses the first user text, current version, and sdk-cli entrypoint", () => {
	const firstUserText = "hello world this is a test message";
	const payload = {
		...oauthPayload(),
		messages: [
			{ role: "assistant", content: "not the billing input" },
			{
				role: "user",
				content: [
					{ type: "image", source: { data: "not text" } },
					{ type: "text", text: firstUserText },
					{ type: "text", text: "not the first text block" },
				],
			},
			{ role: "user", content: "not the first user" },
		],
	};
	const before = structuredClone(payload);
	const shaped = shapeAnthropicOAuthPayload(payload) as typeof payload;
	const cch = createHash("sha256").update(firstUserText).digest("hex").slice(0, 5);
	// This fixture's characters at positions 4, 7, and 20 are "ooa".
	const suffix = createHash("sha256")
		.update(`59cf53e54c78ooa${CLAUDE_CODE_VERSION}`)
		.digest("hex")
		.slice(0, 3);
	assert.equal(
		shaped.system[0].text,
		`x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}.${suffix}; cc_entrypoint=sdk-cli; cch=${cch};`,
	);
	assert.deepEqual(shaped.system.slice(1), payload.system);
	assert.deepEqual(payload, before, "OAuth shaping must not mutate its input");
	assert.deepEqual(shapeAnthropicOAuthPayload(shaped), shaped);
});

test("an existing billing header from another shaper is kept without duplication", () => {
	const existing = {
		type: "text",
		text: "x-anthropic-billing-header: existing upstream header;",
		cache_control: { type: "ephemeral" },
	};
	const payload = { ...oauthPayload(), system: [existing] };
	const shaped = shapeAnthropicOAuthPayload(payload) as typeof payload;
	assert.deepEqual(shaped.system, [existing]);
	assert.deepEqual(shapeAnthropicOAuthPayload(shaped), shaped);
});

test("Pi preamble cleanup preserves unrelated instructions and system-block metadata", () => {
	const projectContext = "\n\n# Project Context\n\nKeep project instructions exactly.";
	const preamble = [
		PI_PREFIX,
		"In addition to the tools above, extra tools may be available.",
		"Here is some useful information about the environment you are running in:",
		PI_TERMINATOR,
	].join("\n\n");
	const payload = {
		...oauthPayload(),
		system: [
			{ type: "text", text: IDENTITY },
			{
				type: "text",
				text: preamble + projectContext,
				cache_control: { type: "ephemeral" },
			},
			{ type: "text", text: "Unrelated system instructions." },
		],
	};
	const shaped = shapeAnthropicOAuthPayload(payload) as typeof payload;
	assert.equal(
		shaped.system[2].text,
		`${MINIMAL_PROMPT}\n\nEnvironment context you are running in:\n\n${PI_TERMINATOR}${projectContext}`,
	);
	assert.deepEqual(shaped.system[2].cache_control, { type: "ephemeral" });
	assert.deepEqual(shaped.system[3], payload.system[2]);
	assert.deepEqual(shapeAnthropicOAuthPayload(shaped), shaped);
});

test("a missing Pi terminator falls back to project context, or the minimal prompt", () => {
	for (const context of ["", "\n\n# Project Context\n\nKeep this context."]) {
		const payload = {
			...oauthPayload(),
			system: [
				{ type: "text", text: IDENTITY },
				{ type: "text", text: `${PI_PREFIX}\n\nChanged preamble.${context}` },
			],
		};
		const shaped = shapeAnthropicOAuthPayload(payload) as typeof payload;
		assert.equal(shaped.system[2].text, MINIMAL_PROMPT + context);
		assert.deepEqual(shapeAnthropicOAuthPayload(shaped), shaped);
	}
});

test("OAuth assistant splitting preserves block data and order within each group", () => {
	const lead = { type: "text", text: "before" };
	const call1 = { type: "tool_use", id: "one", name: "read", input: { path: "a" } };
	const tail = { type: "text", text: "after" };
	const call2 = { type: "tool_use", id: "two", name: "read", input: { path: "b" } };
	const ordered = { role: "assistant", content: [lead, call1] };
	const mixed = { role: "assistant", content: [lead, call1, tail, call2], marker: "keep" };
	const payload = { ...oauthPayload(), messages: [ordered, mixed] };
	const before = structuredClone(payload);
	const shaped = shapeAnthropicOAuthPayload(payload) as typeof payload;
	assert.equal(shaped.messages[0], ordered, "already valid assistant turns are untouched");
	assert.deepEqual(shaped.messages.slice(1), [
		{ ...mixed, content: [lead, tail] },
		{ ...mixed, content: [call1, call2] },
	]);
	assert.deepEqual(payload, before);
	assert.deepEqual(shapeAnthropicOAuthPayload(shaped), shaped);
});

test("no billing header is synthesized when the first user has no text", () => {
	for (const messages of [
		[],
		[{ role: "user", content: "" }],
		[{ role: "user", content: [] }, { role: "user", content: "later text" }],
	]) {
		const payload = { ...oauthPayload(), messages };
		const shaped = shapeAnthropicOAuthPayload(payload) as typeof payload;
		assert.deepEqual(shaped.system, payload.system);
	}
});

test("developer-role rewriting is in-place, role-only, and idempotent", () => {
	const content = [{ type: "text", text: "Keep this body and its developer word." }];
	const messages = [
		{ role: "developer", content, name: "instructions", extra: { keep: true } },
		{ role: "system", content: "existing system" },
		{ role: "assistant", content: "answer" },
		{ role: "developer", content: "second instruction" },
	];
	const payload = { messages, model: "qwen", stream: true, extra: { keep: true } };
	const expected = structuredClone(payload);
	expected.messages[0].role = "system";
	expected.messages[3].role = "system";
	const firstMessage = messages[0];
	assert.equal(rewriteDeveloperRoleToSystem(payload), true);
	assert.deepEqual(payload, expected);
	assert.equal(payload.messages, messages);
	assert.equal(payload.messages[0], firstMessage);
	assert.equal(payload.messages[0].content, content);
	assert.equal(rewriteDeveloperRoleToSystem(payload), false);
});

test("developer-role rewriting ignores malformed payloads and non-developer messages", () => {
	for (const payload of [
		null,
		undefined,
		"not a request",
		{},
		{ messages: {} },
		{ messages: [null, "developer", {}, { role: "user", content: "developer" }] },
	]) {
		const before = structuredClone(payload);
		assert.equal(rewriteDeveloperRoleToSystem(payload), false);
		assert.deepEqual(payload, before);
	}
});
