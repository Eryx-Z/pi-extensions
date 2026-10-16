/**
 * Regression tests for interrupted-turn preservation (the `context` hook).
 *
 * The defect these lock down: on a quota failover the turn that TRIGGERED the switch is
 * exactly the turn pi-ai refuses to replay. `transform-messages` skips every assistant
 * message with stopReason "error"/"aborted", and degrades thinking blocks to plain text
 * whenever the next request runs on a different model. The account we switch TO therefore
 * received a continuation prompt saying "do not repeat completed work" with the record of
 * that work already deleted, plus tool results left with no originating call.
 *
 * The integration test proves the loss against the REAL pi-ai transform rather than a mock,
 * because an in-process mock is exactly what would not have caught this.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
	preserveInterruptedTurns,
	renderHandoffRecord,
} from "../interrupted-turns.ts";


// Compatibility contract only: pure-function behavior is tested through its owner below.
test("index keeps the interrupted-turn module exports as compatibility aliases", async () => {
	const entry = await import("../index.ts");
	assert.equal(entry.preserveInterruptedTurns, preserveInterruptedTurns);
	assert.equal(entry.renderHandoffRecord, renderHandoffRecord);
});

// Resolve the installed core package instead of maintaining checkout/hoisting guesses.
// pi-ai is a required dependency; a moved transform must fail this integration test, not skip it.
const { transformMessages } = await import(
	new URL("./api/transform-messages.js", import.meta.resolve("@earendil-works/pi-ai")).href
);

const DEAD_MODEL = {
	provider: "openai-codex",
	api: "openai-responses",
	id: "gpt-5.6-terra",
	input: ["text"],
};
/** The account failover moves us to: a DIFFERENT provider and model family. */
const LIVE_MODEL = {
	provider: "ollama",
	api: "openai-completions",
	id: "glm-5.2:cloud",
	input: ["text"],
};

const SECRET_REASONING =
	"The migration script must run before the seed, otherwise the seed inserts against the old schema.";
const SECRET_OUTPUT =
	"Applied migration 0042_add_orders_table; seeding is the remaining step.";

/** A transcript whose last assistant turn died on a quota error mid-tool-batch. */
function interruptedTranscript() {
	return [
		{
			role: "user",
			content: [{ type: "text", text: "Migrate the database and seed it." }],
			timestamp: 1,
		},
		{
			role: "assistant",
			provider: DEAD_MODEL.provider,
			api: DEAD_MODEL.api,
			model: DEAD_MODEL.id,
			stopReason: "error",
			errorMessage: "Codex error: The usage limit has been reached",
			usage: {},
			timestamp: 2,
			content: [
				{ type: "thinking", thinking: SECRET_REASONING },
				{ type: "text", text: SECRET_OUTPUT },
				{
					type: "toolCall",
					id: "call_migrate",
					name: "bash",
					arguments: { command: "npm run db:migrate" },
				},
				{
					type: "toolCall",
					id: "call_seed",
					name: "bash",
					arguments: { command: "npm run db:seed" },
				},
			],
		},
		{
			role: "toolResult",
			toolCallId: "call_migrate",
			toolName: "bash",
			content: [{ type: "text", text: "migration 0042 applied" }],
			timestamp: 3,
		},
	];
}

test("REAL pi-ai transform erases the interrupted turn; preservation carries it across a provider switch", () => {

	// 1. Baseline — what the next account sees today, without preservation.
	const bare = transformMessages(interruptedTranscript(), LIVE_MODEL, undefined);
	const bareText = JSON.stringify(bare);
	assert.equal(
		bare.some((m: any) => m.role === "assistant"),
		false,
		"pi-ai must be dropping the interrupted assistant message (that IS the bug)",
	);
	assert.equal(
		bareText.includes(SECRET_REASONING),
		false,
		"baseline: the reasoning of the interrupted turn is lost",
	);
	assert.equal(
		bareText.includes(SECRET_OUTPUT),
		false,
		"baseline: the output written before the interruption is lost",
	);
	assert.equal(
		bareText.includes("npm run db:seed"),
		false,
		"baseline: the tool call that never returned is lost",
	);

	// 2. With preservation, the same transform on the SWITCHED-TO model keeps everything.
	const preserved = transformMessages(
		preserveInterruptedTurns(interruptedTranscript()),
		LIVE_MODEL,
		undefined,
	);
	const preservedText = JSON.stringify(preserved);
	assert.ok(
		preservedText.includes(SECRET_REASONING),
		"reasoning of the interrupted turn must survive the switch verbatim",
	);
	assert.ok(
		preservedText.includes(SECRET_OUTPUT),
		"output written before the interruption must survive the switch verbatim",
	);
	assert.ok(
		preservedText.includes("npm run db:migrate") &&
			preservedText.includes("npm run db:seed"),
		"both tool calls, including the one that never returned, must survive",
	);
	assert.ok(
		preservedText.includes("migration 0042 applied"),
		"the tool result of the interrupted turn must survive folded into the record",
	);
	assert.equal(
		preserved.some((m: any) => m.role === "toolResult"),
		false,
		"no tool result may remain orphaned once its originating call was folded in",
	);
});

test("the handoff record marks which tool calls never returned", () => {
	const messages: any[] = interruptedTranscript();
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	messages[1].content.push(
		{ type: "toolCall", id: "cycle", name: "cycle", arguments: cyclic },
		{ type: "toolCall", id: "empty", name: "empty" },
		{ type: "toolCall", id: "failure", name: "bash", arguments: { command: "db:retry" } },
	);
	const completed = {
		role: "assistant", stopReason: "stop", content: [{ type: "text", text: "completed work" }],
	};
	const unrelated = { role: "toolResult", toolCallId: "other", content: "unrelated result" };
	// Results are looked up across the whole transcript, not just adjacent to the call.
	messages.splice(2, 0, completed, unrelated);
	messages.push(
		{ role: "toolResult", toolCallId: "cycle", content: "string result" },
		{ role: "toolResult", toolCallId: "empty", content: [{ type: "image", data: "not-readable" }] },
		{ role: "toolResult", toolCallId: "failure", isError: true, content: [{ type: "text", text: "migration failed: already applied" }] },
	);
	const preserved = preserveInterruptedTurns(messages);
	assert.equal(preserved.length, 4);
	assert.equal(preserved[0], messages[0]);
	assert.equal(preserved[2], completed);
	assert.equal(preserved[3], unrelated, "unrelated results must not be consumed");
	const record = preserved[1];
	const text = String(record.content[0].text);
	assert.ok(
		/db:migrate[\s\S]*result: migration 0042 applied/.test(text),
		"a completed call must carry its result",
	);
	assert.match(text, /db:seed[\s\S]*result: NONE[^\n]*UNKNOWN/,
		"a call that never returned must be flagged as unknown, not silently dropped");
	assert.match(text, /arguments: <unserializable arguments>/);
	assert.match(text, /result: string result/);
	assert.match(text, /arguments: \{\}/);
	assert.match(text, /result: <empty>/);
	assert.match(text, /db:retry[\s\S]*result \(error\): migration failed: already applied/);
	assert.ok(text.includes(SECRET_REASONING));
	assert.ok(text.includes(SECRET_OUTPUT));
	assert.ok(text.includes("Codex error: The usage limit has been reached"));
	assert.equal(text.includes("not-readable"), false);
});

test("preservation is byte-identical on replay so it never invalidates the prompt cache", () => {
	// The hook runs before EVERY request. A record that re-renders differently each time
	// would move the cache breakpoint and force a full re-read of the transcript.
	const messages = interruptedTranscript();
	const before = structuredClone(messages);
	const preserved = preserveInterruptedTurns(messages);
	const first = JSON.stringify(preserved);
	const second = JSON.stringify(preserveInterruptedTurns(interruptedTranscript()));
	assert.equal(first, second);
	assert.deepEqual(preserveInterruptedTurns(messages), preserved, "rerendering is deterministic");
	assert.deepEqual(messages, before, "preservation must not mutate session messages");
	assert.equal(preserveInterruptedTurns(preserved), preserved, "records are not wrapped again");
});

test("a transcript with no interrupted turn is returned untouched", () => {
	const clean = [
		{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
		{
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "hello" }],
			timestamp: 2,
		},
	];
	for (const messages of [
		[],
		clean,
		[{ role: "user", content: "question" }, ...clean.slice(1), { role: "toolResult", toolCallId: "unrelated", content: "result" }],
	]) {
		const before = structuredClone(messages);
		assert.equal(
			preserveInterruptedTurns(messages),
			messages,
			"identity must be preserved so the hook can skip returning a result at all",
		);
		assert.deepEqual(messages, before);
	}
});

test("an interrupted turn with nothing to preserve is left to pi's normal drop path", () => {
	// User pressed Esc before the model emitted anything: there is no work to describe,
	// and injecting an empty record would only add noise to every later request.
	const empty = [
		{ role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 },
		{ role: "assistant", stopReason: "aborted", content: [], timestamp: 2 },
		{ role: "assistant", stopReason: "error", errorMessage: "failure alone is not work" },
		{
			role: "assistant", stopReason: "error",
			content: [{ type: "thinking", thinking: "opaque", redacted: true }],
		},
	];
	const before = structuredClone(empty);
	assert.equal(preserveInterruptedTurns(empty), empty);
	assert.deepEqual(empty, before);
	assert.equal(renderHandoffRecord({ content: [], errorMessage: "error only" }, new Map()), undefined);
});

test("redacted thinking is not resurrected as plain text", () => {
	// Redacted blocks are opaque provider-encrypted payloads with no readable content;
	// emitting them would leak an unusable blob into every subsequent request.
	const record = renderHandoffRecord(
		{
			role: "assistant",
			stopReason: "aborted",
			content: [
				{ type: "thinking", thinking: "readable reasoning", signature: "private-signature" },
				{ type: "thinking", thinking: "encrypted-blob", redacted: true },
				{ type: "text", text: "visible answer", signature: "private-text-metadata" },
				{ type: "image", data: "assistant-image-data" },
				{ type: "toolCall", id: "read", name: "read", arguments: { path: "README.md" } },
			],
		},
		new Map([
			["read", { content: [
				{ type: "text", text: "visible result" },
				{ type: "image", data: "tool-image-data" },
			] }],
		]),
	);
	assert.ok(record);
	assert.match(record, /the previous account.*cancelled/);
	for (const readable of ["readable reasoning", "visible answer", "visible result", "README.md"])
		assert.ok(record.includes(readable));
	for (const opaque of ["private-signature", "encrypted-blob", "private-text-metadata", "assistant-image-data", "tool-image-data"])
		assert.equal(record.includes(opaque), false);
});

test("oversized turns are clipped head+tail so failover can never blow the context window", () => {
	const huge = "A".repeat(50_000) + "TAIL_MARKER";
	const record = renderHandoffRecord(
		{
			role: "assistant",
			stopReason: "error",
			provider: "anthropic",
			model: "claude-opus-4-8",
			content: [{ type: "text", text: huge }],
		},
		new Map(),
	);
	assert.ok(record);
	assert.ok(record.length < 12_000, `record must stay bounded, got ${record.length}`);
	assert.ok(
		record.includes("TAIL_MARKER"),
		"the tail matters most: it is where the turn actually stopped",
	);
	assert.ok(record.includes("characters omitted"));

	const section = (label: string) => `${label}_HEAD${"x".repeat(50_000)}${label}_TAIL`;
	const calls = Array.from({ length: 14 }, (_, index) => ({
		type: "toolCall",
		id: `call-${index + 1}`,
		name: `tool-${index + 1}`,
		arguments: { body: section("ARGS") },
	}));
	const message = {
		role: "assistant", stopReason: "error", errorMessage: section("ERROR"),
		content: [
			{ type: "text", text: section("TEXT") },
			{ type: "thinking", thinking: section("THINKING") },
			...calls,
		],
	};
	const results = calls.map((call) => ({
		role: "toolResult", toolCallId: call.id, content: section("RESULT"),
	}));
	const bounded = renderHandoffRecord(message, new Map(results.map((result) => [result.toolCallId, result])));
	assert.ok(bounded);
	for (const label of ["TEXT", "THINKING", "ARGS", "RESULT", "ERROR"]) {
		assert.ok(bounded.includes(`${label}_HEAD`));
		assert.ok(bounded.includes(`${label}_TAIL`));
	}
	for (const [length, cap] of [
		[section("TEXT").length, 4000],
		[section("THINKING").length, 3000],
		[JSON.stringify(calls[0].arguments).length, 800],
		[section("RESULT").length, 1000],
		[section("ERROR").length, 400],
	]) {
		assert.ok(bounded.includes(`[${length - cap} characters omitted]`));
	}
	assert.equal(bounded.includes("x".repeat(5_000)), false);
	assert.match(bounded, /12\. tool-12 — arguments:/);
	assert.equal(bounded.includes("tool-13 —"), false);
	assert.equal(bounded.includes("tool-14 —"), false);
	assert.match(bounded, /2 further tool call\(s\) omitted/);
	// Existing per-section caps total 29k characters before rendering overhead.
	assert.ok(bounded.length < 36_000, `bounded record expected, got ${bounded.length}`);
	const preserved = preserveInterruptedTurns([message, ...results]);
	assert.equal(preserved.length, 1, "even results of omitted calls are removed, never orphaned");
	assert.equal(preserved[0].content[0].text, bounded);
});

test("every interrupted turn in a long session is preserved, not just the last one", () => {
	const messages = [
		{ role: "user", content: [{ type: "text", text: "task" }], timestamp: 1 },
		{
			role: "assistant",
			stopReason: "error",
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			content: [{ type: "text", text: "FIRST_ATTEMPT" }],
			timestamp: 2,
		},
		{
			role: "assistant",
			stopReason: "error",
			provider: "anthropic",
			model: "claude-opus-4-8",
			content: [{ type: "text", text: "SECOND_ATTEMPT" }],
			timestamp: 3,
		},
		{
			role: "assistant",
			stopReason: "aborted",
			provider: "anthropic",
			model: "claude-opus-4-8",
			content: [{ type: "text", text: "Cancelled follow-up work." }],
			timestamp: 4,
		},
	];
	const records = preserveInterruptedTurns(messages).filter(
		(m: any) =>
			m.role === "user" &&
			String(m.content?.[0]?.text ?? "").includes("[handoff:interrupted-turn]"),
	);
	assert.equal(records.length, 3, "each interrupted turn needs its own record");
	const text = JSON.stringify(records);
	assert.ok(text.includes("FIRST_ATTEMPT") && text.includes("SECOND_ATTEMPT"));
	assert.match(records[0].content[0].text, /\[handoff:interrupted-turn\].*openai-codex\/gpt-5\.6-sol.*interrupted/);
	assert.match(records[1].content[0].text, /anthropic\/claude-opus-4-8.*interrupted/);
	assert.match(records[2].content[0].text, /anthropic\/claude-opus-4-8.*cancelled/);
	assert.ok(records[2].content[0].text.includes("Cancelled follow-up work."));
	for (const [index, record] of records.entries()) {
		assert.equal(record.role, "user", "plain user text is portable across model vendors");
		assert.equal(record.timestamp, messages[index + 1].timestamp);
		assert.equal(record.content.length, 1);
		assert.equal(record.content[0].type, "text");
	}
	assert.equal(
		preserveInterruptedTurns(messages).some((m: any) => m.role === "assistant"),
		false,
		"no interrupted assistant may be left for pi-ai to drop",
	);
});
