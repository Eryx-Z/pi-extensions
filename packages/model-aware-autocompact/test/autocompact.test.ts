import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadConfig, normalizeContextGuard, saveConfig } from "../config.ts";
import { preserveInterruptedTurns } from "../../pi-multi-account/index.ts";
import {
	DEFAULT_CONTEXT_GUARD_SETTINGS,
	SUMMARY_MARKER,
} from "../context-guard.ts";

// Use Pi's existing jiti dependency, just as its extension loader does. The SDK
// runtime is mocked: these tests exercise registered handlers, not providers/UI.
const { createJiti } = createRequire(
	import.meta.resolve("@earendil-works/pi-coding-agent"),
)("jiti");

function fixture(
	t: { after(fn: () => void): void },
	current?: unknown,
	legacy?: unknown,
) {
	const dir = mkdtempSync(join(tmpdir(), "autocompact-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	if (current !== undefined)
		writeFileSync(
			join(dir, "model-aware-autocompact.json"),
			JSON.stringify(current),
		);
	if (legacy !== undefined)
		writeFileSync(join(dir, "provider-failover.json"), JSON.stringify(legacy));
	return dir;
}

async function harness(
	t: { after(fn: () => void): void },
	current?: unknown,
	legacy?: unknown,
	beforeStart?: (dir: string) => void,
) {
	const dir = fixture(t, current, legacy);
	const stub = join(dir, "sdk.mjs");
	writeFileSync(
		stub,
		`export const getAgentDir = () => ${JSON.stringify(dir)};`,
	);
	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		fsCache: false,
		alias: { "@earendil-works/pi-coding-agent": stub },
	});
	const extension = await jiti.import(
		fileURLToPath(new URL("../index.ts", import.meta.url)),
		{ default: true },
	);
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const commands = new Map<string, any>();
	extension({
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerCommand: (name: string, command: any) =>
			commands.set(name, command),
	});
	const notifications: { text: string; type: string }[] = [];
	const compactions: any[] = [];
	const statuses: any[] = [];
	const summaryCalls: any[] = [];
	let usage: any = { tokens: 0, contextWindow: 100_000 };
	let idle = true;
	let pending = false;
	const ctx = {
		model: { provider: "test", id: "large", contextWindow: 100_000 },
		hasUI: true,
		ui: {
			notify: (text: string, type: string) =>
				notifications.push({ text, type }),
			setStatus: (...args: any[]) => statuses.push(args),
		},
		isIdle: () => idle,
		hasPendingMessages: () => pending,
		getContextUsage: () => usage,
		getSystemPrompt: () => "",
		compact: (options: any) => compactions.push(options),
		modelRegistry: {
			find: () => true,
			complete: async (model: unknown, context: any, options: any) => {
				summaryCalls.push({ model, context, options });
				const source = JSON.parse(context.messages[0].content);
				return {
					stopReason: "stop",
					content: [{
						type: "text",
						text: JSON.stringify(Object.fromEntries(source.results.map((item: any) => [
							item.key,
							"The read returned repeated text; no error or action result was reported.",
						]))),
					}],
				};
			},
		},
	};
	const emit = (name: string, event: any = {}) =>
		handlers.get(name)?.(event, ctx);
	beforeStart?.(dir);
	await emit("session_start");
	return {
		dir,
		ctx,
		notifications,
		compactions,
		statuses,
		summaryCalls,
		emit,
		command: (args: string) =>
			commands.get("autocompact-percent").handler(args, ctx),
		setUsage: (
			tokens: number | null,
			contextWindow = ctx.model.contextWindow,
		) => {
			usage = { tokens, contextWindow };
		},
		setIdle: (value: boolean) => {
			idle = value;
		},
		setPending: (value: boolean) => {
			pending = value;
		},
	};
}

function messages() {
	return Array.from({ length: 10 }, (_, i) => ({
		role: "toolResult",
		toolCallId: `call-${i}`,
		toolName: "read",
		isError: false,
		content: [{ type: "text", text: "x".repeat(40_000) }],
	}));
}
const text = (message: any) => message.content[0].text as string;
const response = (input = 60_000) => ({
	message: { role: "assistant", usage: { input, cacheRead: 0, cacheWrite: 0 } },
});

// Configuration migration is intentionally property-scoped and read-only.
test("defaults preserve old percent and guard defaults", (t) => {
	assert.deepEqual(loadConfig(fixture(t)), {
		percent: 80,
		models: {},
		contextGuard: DEFAULT_CONTEXT_GUARD_SETTINGS,
	});
});

test("compressModel loads and persists independently of guard adoption and percentage commands", async (t) => {
	const h = await harness(t, { percent: 67, compressModel: "other/fast/model" }, { contextGuard: false });
	assert.equal(loadConfig(h.dir).compressModel, "other/fast/model");
	await h.command("55");
	const saved = JSON.parse(readFileSync(join(h.dir, "model-aware-autocompact.json"), "utf8"));
	assert.equal(saved.compressModel, "other/fast/model");
	assert.equal(saved.percent, 55);
	assert.equal(saved.contextGuard.enabled, false);
	for (const invalid of [false, null, 12, {}]) {
		assert.equal(loadConfig(fixture(t, { compressModel: invalid })).compressModel, "",
			"an explicit malformed model must not silently select the current provider");
	}
});

test("compressModel changes only tool-output summaries, never main model or compact percentage", async (t) => {
	const h = await harness(t, { percent: 95, compressModel: "other/fast/model" });
	const main = h.ctx.model;
	const compressor = { provider: "other", id: "fast/model", contextWindow: 128_000 };
	const lookups: unknown[] = [];
	h.ctx.modelRegistry.find = ((provider: string, id: string) => {
		lookups.push([provider, id]);
		return compressor;
	}) as any;
	assert.ok(await h.emit("context", { messages: messages().slice(0, 7) }));
	assert.deepEqual(lookups, [["other", "fast/model"]]);
	assert.equal(h.summaryCalls[0].model, compressor);
	assert.equal(h.ctx.model, main);
	h.setUsage(50_000);
	await h.emit("agent_settled");
	assert.equal(h.compactions.length, 0, "89k adjusted is below the main model's 95k threshold");
	h.setUsage(95_000);
	await h.emit("agent_settled");
	assert.equal(h.compactions.length, 1);
	assert.match(h.compactions[0].customInstructions, /95%/);
	assert.equal(h.ctx.model, main);
});

test("legacy fallback reads only contextGuard; saving migrates without changing legacy file", (t) => {
	const legacy = {
		enabled: false,
		percent: 20,
		models: { "test/large": 10 },
		contextGuard: { softPercent: 0.9, targetPercent: 0.7 },
	};
	const dir = fixture(t, { percent: 65 }, legacy);
	const before = readFileSync(join(dir, "provider-failover.json"), "utf8");
	const config = loadConfig(dir);
	assert.equal(config.percent, 65);
	assert.deepEqual(config.models, {});
	assert.equal(config.contextGuard.enabled, true);
	assert.equal(config.contextGuard.softPercent, 0.9);
	saveConfig(dir, config);
	assert.deepEqual(
		JSON.parse(readFileSync(join(dir, "model-aware-autocompact.json"), "utf8")),
		config,
	);
	assert.equal(
		readFileSync(join(dir, "provider-failover.json"), "utf8"),
		before,
	);
});

test("new explicit false/true/null/object settings win over legacy", (t) => {
	for (const value of [false, true, null, { keepVerbatimTokens: 123 }]) {
		const config = loadConfig(
			fixture(
				t,
				{ contextGuard: value },
				{ contextGuard: { enabled: false, minElideTokens: 999 } },
			),
		);
		assert.deepEqual(config.contextGuard, normalizeContextGuard(value));
	}
	assert.equal(
		loadConfig(fixture(t, {}, { contextGuard: false })).contextGuard.enabled,
		false,
	);
});

test("normalization preserves former numeric validation and threshold ordering", () => {
	assert.deepEqual(
		normalizeContextGuard({
			softPercent: -1,
			targetPercent: 2,
			keepVerbatimTokens: 0,
			minElideTokens: NaN,
			maxWindowTokens: -1,
		}),
		DEFAULT_CONTEXT_GUARD_SETTINGS,
	);
	assert.equal(
		normalizeContextGuard({ softPercent: 0.7, targetPercent: 0.9 })
			.targetPercent,
		0.7 - 0.15,
	);
	assert.equal(
		normalizeContextGuard({ maxWindowTokens: 0 }).maxWindowTokens,
		0,
	);
});

test("bad config values fall back without breaking startup", (t) => {
	const dir = fixture(t, { percent: 100, models: { good: 25, bad: 0 } });
	assert.equal(loadConfig(dir).percent, 80);
	assert.deepEqual(loadConfig(dir).models, { good: 25 });
	writeFileSync(join(dir, "model-aware-autocompact.json"), "{");
	assert.equal(loadConfig(dir).percent, 80);
});

test("startup durably adopts inherited false/custom guard without touching legacy or percentage policy", async (t) => {
	for (const contextGuard of [
		false,
		{ softPercent: 0.9, keepVerbatimTokens: 123 },
	]) {
		const legacy = { enabled: false, contextGuard };
		const h = await harness(
			t,
			{ percent: 67, models: { "test/large": 91 } },
			legacy,
		);
		const saved = JSON.parse(
			readFileSync(join(h.dir, "model-aware-autocompact.json"), "utf8"),
		);
		assert.equal(saved.percent, 67);
		assert.deepEqual(saved.models, { "test/large": 91 });
		assert.deepEqual(saved.contextGuard, normalizeContextGuard(contextGuard));
		assert.equal(
			readFileSync(join(h.dir, "provider-failover.json"), "utf8"),
			JSON.stringify(legacy),
		);
		// The former owner may now drop the field without changing our resolved setting.
		writeFileSync(join(h.dir, "provider-failover.json"), "{}");
		assert.deepEqual(loadConfig(h.dir).contextGuard, saved.contextGuard);
	}
});

test("startup does not rewrite explicit new settings or create config without a valid legacy setting", async (t) => {
	const current = { percent: 73, contextGuard: false };
	const h = await harness(t, current, { contextGuard: true });
	assert.equal(
		readFileSync(join(h.dir, "model-aware-autocompact.json"), "utf8"),
		JSON.stringify(current),
	);
	for (const legacy of [undefined, {}, { contextGuard: "invalid" }]) {
		const fresh = await harness(t, undefined, legacy);
		assert.equal(
			existsSync(join(fresh.dir, "model-aware-autocompact.json")),
			false,
		);
	}
});

test("legacy adoption leaves malformed/non-object destination bytes unchanged and warns once", async (t) => {
	for (const bytes of ["{broken", "null", "[]"]) {
		const h = await harness(t, undefined, { contextGuard: false }, dir => {
			writeFileSync(join(dir, "model-aware-autocompact.json"), bytes);
		});
		assert.equal(readFileSync(join(h.dir, "model-aware-autocompact.json"), "utf8"), bytes);
		assert.equal(h.notifications.length, 1);
		assert.equal(h.notifications[0].type, "warning");
		await h.emit("session_start");
		assert.equal(h.notifications.length, 1);
	}
});

test("legacy adoption is additive and preserves percentage/unknown fields edited before startup", async (t) => {
	const fresh = { percent: 63, models: { "test/large": 87 }, futureSetting: { nested: [1, 2] } };
	const h = await harness(t, { percent: 55 }, { contextGuard: false }, dir => {
		writeFileSync(join(dir, "model-aware-autocompact.json"), JSON.stringify(fresh));
	});
	assert.deepEqual(JSON.parse(readFileSync(join(h.dir, "model-aware-autocompact.json"), "utf8")), {
		...fresh, contextGuard: normalizeContextGuard(false),
	});
	assert.match(h.statuses.at(-1)[1], /87%/);
	h.setUsage(86_999);
	await h.emit("agent_settled");
	assert.equal(h.compactions.length, 0);
	h.setUsage(87_000);
	await h.emit("agent_settled");
	assert.equal(h.compactions.length, 1);
});

test("a newly explicit guard between factory and startup wins without rewriting destination", async (t) => {
	for (const contextGuard of [true, false]) {
		const fresh = { percent: 77, contextGuard, future: "keep me" };
		const bytes = JSON.stringify(fresh);
		const h = await harness(t, {}, { contextGuard: !contextGuard }, dir => {
			writeFileSync(join(dir, "model-aware-autocompact.json"), bytes);
		});
		assert.equal(readFileSync(join(h.dir, "model-aware-autocompact.json"), "utf8"), bytes);
		assert.equal(!!await h.emit("context", { messages: messages() }), contextGuard);
	}
});

test("failed legacy adoption reports once and never fails startup", async (t) => {
	const h = await harness(t, undefined, { contextGuard: false }, (dir) => {
		mkdirSync(join(dir, "model-aware-autocompact.json")); // deterministically make save fail, even as root.
	});
	assert.equal(h.notifications.length, 1);
	assert.equal(h.notifications[0].type, "warning");
	assert.match(
		h.notifications[0].text,
		/could not save the inherited contextGuard/,
	);
	await h.emit("session_start");
	assert.equal(h.notifications.length, 1);
	assert.equal(
		await h.emit("context", { messages: messages() }),
		undefined,
		"inherited false still applies in memory",
	);
});

test("default percentage compacts only at 80% on settled", async (t) => {
	const h = await harness(t);
	h.setUsage(79_999);
	await h.emit("agent_settled");
	assert.equal(h.compactions.length, 0);
	h.setUsage(80_000);
	await h.emit("agent_settled");
	assert.equal(h.compactions.length, 1);
	assert.match(h.compactions[0].customInstructions, /80%/);
	assert.match(h.statuses.at(-1)[1], /80%\/80k/);
});

test("old percent config and per-model overrides retain their exact thresholds", async (t) => {
	const h = await harness(t, { percent: 60, models: { "test/large": 90 } });
	h.setUsage(89_999);
	await h.emit("agent_settled");
	assert.equal(h.compactions.length, 0);
	h.setUsage(90_000);
	await h.emit("agent_settled");
	assert.match(h.compactions[0].customInstructions, /90%/);
	h.compactions[0].onError(new Error("retry later"));
	h.ctx.model.id = "other";
	h.setUsage(60_000);
	await h.emit("model_select", { model: h.ctx.model, source: "manual" });
	assert.equal(h.compactions.length, 2);
	assert.match(h.compactions[1].customInstructions, /60%/);
});

test("percent commands persist resolved guard and preserve status/list/current/reset behavior", async (t) => {
	const h = await harness(t, undefined, { contextGuard: false });
	await h.command("55%");
	await h.command("-c 70");
	let saved = JSON.parse(
		readFileSync(join(h.dir, "model-aware-autocompact.json"), "utf8"),
	);
	assert.equal(saved.percent, 55);
	assert.equal(saved.models["test/large"], 70);
	assert.equal(saved.contextGuard.enabled, false);
	await h.command("status");
	await h.command("list");
	await h.command("reset -c");
	saved = JSON.parse(
		readFileSync(join(h.dir, "model-aware-autocompact.json"), "utf8"),
	);
	assert.deepEqual(saved.models, {});
	await h.command("100");
	assert.equal(h.notifications.at(-1)?.type, "error");
});

test("context summarizes only request copies, reuses cached prefixes, and protects recent output", async (t) => {
	const h = await harness(t);
	const original = messages();
	const before = structuredClone(original);
	await h.emit("agent_start");
	const first = await h.emit("context", { messages: original });
	assert.ok(text(first.messages[0]).startsWith(SUMMARY_MARKER));
	assert.deepEqual(first.messages.slice(-4), original.slice(-4));
	assert.deepEqual(original, before);
	const firstKey = JSON.parse(h.summaryCalls[0].context.messages[0].content).results[0].key;
	const second = await h.emit("context", { messages: original });
	assert.deepEqual(second.messages[0], first.messages[0],
		"cached summary text stays stable as more old outputs are summarized");
	assert.equal(
		h.summaryCalls.filter((call) => JSON.parse(call.context.messages[0].content).results.some(
			(item: any) => item.key === firstKey,
		)).length,
		1,
		"unchanged original output is summarized once, never once per request",
	);
	assert.equal(
		h.notifications.filter((n) => /older tool output/.test(n.text)).length,
		1,
	);
	assert.equal(h.compactions.length, 0);
	await h.emit("agent_start");
	await h.emit("context", {
		messages: [
			...original,
			...messages().map((m, i) => ({ ...m, toolCallId: `new-${i}` })),
		],
	});
	assert.equal(
		h.notifications.filter((n) => /older tool output/.test(n.text)).length,
		2,
	);
});

test("summarizing before or after multi-account preservation keeps the same original handoff", async (t) => {
	for (const stopReason of ["error", "aborted"]) {
		const h = await harness(t);
		const original = [
			{
				role: "assistant", stopReason, provider: "test", model: "large", timestamp: 1,
				content: [{ type: "toolCall", id: "interrupted", name: "bash", arguments: { command: "migrate-db" } }],
			},
			{
				role: "toolResult", toolCallId: "interrupted", toolName: "bash", isError: false,
				content: [{ type: "text", text: "MIGRATION-42-COMPLETED\n" + "original detail\n".repeat(4000) + "\nFINAL-EXIT-0" }],
			},
			...messages(),
		];
		const before = structuredClone(original);
		const baseline = preserveInterruptedTurns(original)[0];
		const summarized = await h.emit("context", { messages: original });
		assert.ok(summarized, "other old output should still be summarized");
		assert.deepEqual(summarized.messages[1], original[1], "handoff result stays verbatim");
		assert.deepEqual(preserveInterruptedTurns(summarized.messages)[0], baseline,
			"autocompact-first must not replace original handoff excerpts with a summary");
		const alreadyPreserved = preserveInterruptedTurns(original);
		const reversed = await h.emit("context", { messages: alreadyPreserved });
		assert.deepEqual((reversed?.messages ?? alreadyPreserved)[0], baseline,
			"multi-account-first must retain its bounded handoff unchanged too");
		assert.deepEqual(original, before, "stored source messages never change");
	}
});

test("failed output summaries preserve original messages and warn once per run", async (t) => {
	const h = await harness(t);
	let failedCalls = 0;
	h.ctx.modelRegistry.complete = async () => {
		failedCalls++;
		throw new Error("network unavailable");
	};
	const original = messages();
	const before = structuredClone(original);
	await h.emit("agent_start");
	assert.equal(await h.emit("context", { messages: original }), undefined);
	assert.equal(await h.emit("context", { messages: original }), undefined);
	const differentOutputs = original.map((message, i) => ({ ...message, toolCallId: `different-${i}` }));
	assert.equal(await h.emit("context", { messages: differentOutputs }), undefined);
	assert.equal(failedCalls, 1, "a provider outage must not add another summary timeout to each subsequent request");
	assert.deepEqual(original, before);
	assert.equal(h.notifications.filter((n) => /summary failed.*original output kept/.test(n.text)).length, 1);
	assert.equal(h.compactions.length, 0, "a summary failure must never abort the run to compact");
});

test("disabled guard and unknown context windows leave requests unchanged", async (t) => {
	for (const contextGuard of [false, true]) {
		const h = await harness(t, { contextGuard });
		if (contextGuard) h.ctx.model.contextWindow = 0;
		assert.equal(await h.emit("context", { messages: messages() }), undefined);
		assert.equal(h.compactions.length, 0);
	}
});

test("health warnings detect missing hooks and unknown windows after five responses, once", async (t) => {
	for (const missing of [true, false]) {
		const h = await harness(t);
		if (!missing) {
			h.ctx.model.contextWindow = 0;
			await h.emit("context", { messages: messages() });
		}
		for (let i = 0; i < 4; i++) await h.emit("message_end", response());
		assert.equal(h.notifications.length, 0);
		for (let i = 0; i < 4; i++) await h.emit("message_end", response());
		assert.equal(h.notifications.length, 1);
		assert.equal(h.notifications[0].type, "warning");
		assert.match(
			h.notifications[0].text,
			missing ? /NOT running/ : /models.json/,
		);
		await h.emit("session_start");
		for (let i = 0; i < 5; i++) await h.emit("message_end", response());
		assert.equal(
			h.notifications.length,
			2,
			"new session must get its own health check",
		);
	}
});

test("disabled guard emits no health warnings", async (t) => {
	const h = await harness(t, { contextGuard: false });
	for (let i = 0; i < 10; i++) await h.emit("message_end", response());
	assert.equal(h.notifications.length, 0);
});

test("plausible untrimmed prompt usage learns overhead; trimmed reports cannot poison it", async (t) => {
	const h = await harness(t, { contextGuard: { targetPercent: 0.4 } });
	const request = messages().slice(0, 5); // 50k raw, initial adjusted 67k < soft line.
	assert.equal(await h.emit("context", { messages: request }), undefined);
	for (let i = 0; i < 15; i++) await h.emit("message_end", response(120_000));
	const trimmed = await h.emit("context", { messages: request });
	assert.ok(
		trimmed,
		"learned overhead should now push this request past soft line",
	);
	for (let i = 0; i < 30; i++) await h.emit("message_end", response(25_000));
	await h.emit("session_compact"); // Clear elisions, keep model-specific overhead learning.
	const again = await h.emit("context", { messages: request });
	assert.deepEqual(again, trimmed);
});

test("trimmed provider reports do not suppress configured percent compaction", async (t) => {
	const h = await harness(t);
	await h.emit("agent_start");
	await h.emit("context", { messages: messages() });
	h.setUsage(60_000); // trimmed report below 80%; original projection > 100k.
	await h.emit("message_end", response());
	assert.equal(h.compactions.length, 0);
	await h.emit("agent_settled");
	assert.equal(h.compactions.length, 1);
	assert.match(h.compactions[0].customInstructions, /80%/);
});

for (const role of ["assistant", "toolResult"]) {
	test(`settled compaction counts new ${role} content after the last summarized request`, async (t) => {
		const h = await harness(t, { percent: 95 });
		await h.emit("agent_start");
		// 70k raw -> 89k adjusted: initially below the 95k compaction threshold.
		assert.ok(await h.emit("context", { messages: messages().slice(0, 7) }));
		h.setUsage(60_000);
		await h.emit("message_end", {
			message: {
				role,
				content: [{ type: "text", text: "new result".repeat(4000) }],
				...(role === "assistant" ? { usage: { input: 50_000, cacheRead: 0, cacheWrite: 0 } } : {}),
			},
		});
		assert.equal(h.compactions.length, 0, "message_end must not compact mid-run");
		await h.emit("agent_settled");
		assert.equal(h.compactions.length, 1, "new output must be included in untrimmed accounting");
	});
}

test("trim pressure is not a second compact threshold", async (t) => {
	const h = await harness(t, { percent: 95 });
	const request = messages().slice(0, 7); // adjusted 89k: trims, below configured 95k compact.
	assert.ok(await h.emit("context", { messages: request }));
	h.setUsage(50_000);
	await h.emit("agent_settled");
	assert.equal(h.compactions.length, 0);
});

test("no mid-run compact from context, message_end, model selection or commands", async (t) => {
	const h = await harness(t);
	h.setUsage(95_000);
	await h.emit("agent_start");
	await h.emit("context", { messages: messages() });
	await h.emit("message_end", response());
	await h.emit("model_select", { model: h.ctx.model, source: "manual" });
	await h.command("50");
	await h.command("-c 40");
	assert.equal(h.compactions.length, 0);
	await h.emit("agent_settled");
	assert.equal(h.compactions.length, 1);
});

test("busy host and queued work defer compaction until safely idle", async (t) => {
	const h = await harness(t);
	h.setUsage(95_000);
	h.setIdle(false);
	await h.emit("agent_settled");
	await h.command("50");
	assert.equal(h.compactions.length, 0);
	h.setIdle(true);
	h.setPending(true);
	await h.emit("agent_settled");
	assert.equal(h.compactions.length, 0);
	h.setPending(false);
	await h.emit("agent_settled");
	assert.equal(h.compactions.length, 1);
});

test("single in-flight compact holds lock through completion event and callback", async (t) => {
	const h = await harness(t);
	h.setUsage(95_000);
	await h.emit("agent_settled");
	await h.emit("session_before_compact");
	await h.emit("agent_settled");
	await h.command("50");
	await h.emit("session_compact");
	await h.emit("agent_settled");
	assert.equal(
		h.compactions.length,
		1,
		"success event is earlier than controller cleanup",
	);
	h.setUsage(null);
	h.compactions[0].onComplete();
	await h.emit("agent_settled");
	assert.equal(h.compactions.length, 1);
});

test("external compaction blocks overlapping requests until success/failure and idle", async (t) => {
	for (const end of ["session_compact", "session_compact_failed"]) {
		const h = await harness(t);
		h.setUsage(95_000);
		await h.emit("session_before_compact");
		await h.emit("agent_settled");
		await h.command("50");
		assert.equal(h.compactions.length, 0);
		h.setIdle(false);
		await h.emit(end);
		await h.emit("agent_settled");
		assert.equal(h.compactions.length, 0);
		h.setIdle(true);
		h.setUsage(end === "session_compact" ? null : 95_000);
		await h.emit("agent_settled");
		assert.equal(h.compactions.length, end === "session_compact" ? 0 : 1);
	}
});

test("failed own compact releases its lock only at error callback", async (t) => {
	const h = await harness(t);
	h.setUsage(95_000);
	await h.emit("agent_settled");
	await h.emit("session_compact_failed");
	await h.emit("agent_settled");
	assert.equal(h.compactions.length, 1);
	h.compactions[0].onError(new Error("failed"));
	await h.emit("agent_settled");
	assert.equal(h.compactions.length, 2);
});

test("post-compaction and session/tree resets discard elisions and stale estimates", async (t) => {
	for (const reset of ["session_compact", "session_start", "session_tree"]) {
		const h = await harness(t);
		const original = messages();
		assert.ok(await h.emit("context", { messages: original }));
		await h.emit(reset);
		h.setUsage(null);
		await h.emit("agent_settled");
		assert.equal(h.compactions.length, 0);
		h.setUsage(20_000);
		await h.emit("agent_settled");
		assert.equal(
			h.compactions.length,
			0,
			"old raw projection must not trigger compact",
		);
		// Same identities in a now-fitting projection prove stale elisions are gone.
		const smaller = original.map((m) => ({
			...m,
			content: [{ type: "text", text: "x".repeat(4000) }],
		}));
		assert.equal(await h.emit("context", { messages: smaller }), undefined);
	}
});

test("new model and new request projections cannot reuse stale trimmed estimates", async (t) => {
	const h = await harness(t);
	await h.emit("context", { messages: messages() });
	h.setUsage(20_000);
	h.ctx.model.id = "other";
	await h.emit("agent_settled");
	assert.equal(h.compactions.length, 0, "model identity must match");
	h.ctx.model.id = "large";
	await h.emit("context", { messages: [{ role: "user", content: "small" }] });
	await h.emit("agent_settled");
	assert.equal(
		h.compactions.length,
		0,
		"latest request must replace old projection",
	);
});

test("late old-session completion cannot unlock a new-session compact", async (t) => {
	const h = await harness(t);
	h.setUsage(95_000);
	await h.emit("agent_settled");
	const old = h.compactions[0];
	await h.emit("session_start");
	await h.emit("agent_settled");
	old.onComplete();
	await h.emit("agent_settled");
	assert.equal(h.compactions.length, 2);
});
