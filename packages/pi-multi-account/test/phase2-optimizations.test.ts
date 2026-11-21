import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "pmacct-phase2-"));
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

const { default: piMultiAccount } = await import("../index.ts");
const { STATE_VERSION } = await import("../failover-state.ts");
const {
	FileLockTimeoutError,
	withFileLockAsync,
	withFileLockSync,
} = await import("../file-lock.ts");
const { readCodexFastEnabled, writeCodexFastEnabled } = await import("../codex-fast.ts");
const { readXaiFastEnabled, writeXaiFastEnabled } = await import("../xai-fast.ts");
const { registerSessionLifecycleHooks } = await import("../cursor/session-lifecycle.ts");

after(() => {
	rmSync(agentDir, { recursive: true, force: true });
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

function createSessionHarness(options?: {
	initialModel?: { provider: string; id: string };
	registryModels?: Array<{ provider: string; id: string }>;
}) {
	const handlers = new Map<string, Array<(...args: any[]) => any>>();
	const commands = new Map<string, any>();
	const setModelCalls: Array<{ provider: string; id: string }> = [];
	let currentModel: any = options?.initialModel ?? {
		provider: "openai-codex",
		id: "gpt-5.5",
	};
	const models = options?.registryModels ?? [
		{ provider: "openai-codex", id: "gpt-5.5" },
		{ provider: "openai-codex", id: "gpt-5.6" },
		{ provider: "openai-codex-account-2", id: "gpt-5.5" },
		{ provider: "openai-codex-account-2", id: "gpt-5.6" },
		{ provider: "anthropic", id: "claude-opus-4-8" },
	];

	const pi: any = {
		events: { on() {}, emit() {} },
		on(event: string, fn: (...args: any[]) => any) {
			const list = handlers.get(event) ?? [];
			list.push(fn);
			handlers.set(event, list);
		},
		registerProvider() {},
		unregisterProvider() {},
		registerCommand(name: string, spec: any) {
			commands.set(name, spec);
		},
		registerTool() {},
		appendEntry() {},
		async setModel(m: any) {
			currentModel = m;
			setModelCalls.push({ provider: m.provider, id: m.id });
			for (const fn of handlers.get("model_select") ?? []) {
				await fn({ model: m, source: "api" }, ctx);
			}
			return true;
		},
	};
	piMultiAccount(pi);

	const ctx: any = {
		get model() {
			return currentModel;
		},
		set model(v: any) {
			currentModel = v;
		},
		hasUI: true,
		isIdle: () => true,
		ui: { notify() {}, setStatus() {} },
		modelRegistry: {
			getAll: () => models,
			find: (provider: string, id: string) =>
				models.find((m) => m.provider === provider && m.id === id),
			authStorage: { reload() {} },
		},
	};

	return {
		ctx,
		commands,
		setModelCalls,
		async fire(event: string, payload: any = {}) {
			let lastResult: any;
			for (const fn of handlers.get(event) ?? []) {
				const r = await fn(payload, ctx);
				if (r !== undefined) lastResult = r;
			}
			return lastResult;
		},
	};
}

test("withFileLockSync and withFileLockAsync never delete a live process lock at deadline", async () => {
	const target = join(agentDir, "live-lock-test.json");
	const lockPath = `${target}.lock`;
	// Simulate an active lock owned by a live PID (pid 1 / init is always alive on Linux).
	const liveOwnerPid = process.ppid > 1 ? process.ppid : 1;
	const livePayload = JSON.stringify({
		pid: liveOwnerPid,
		token: "live-owner-token",
		acquiredAt: Date.now(),
	});
	writeFileSync(lockPath, livePayload, { mode: 0o600 });
	try {
		assert.throws(
			() =>
				withFileLockSync(
					target,
					() => "should-not-run",
					{ waitMs: 25, staleMs: 5_000 },
				),
			(err: unknown) => err instanceof FileLockTimeoutError,
		);
		assert.equal(
			readFileSync(lockPath, "utf8"),
			livePayload,
			"live owner lock must remain intact after contender wait timeout",
		);
		await assert.rejects(
			() =>
				withFileLockAsync(
					target,
					async () => "should-not-run",
					{ waitMs: 25, staleMs: 5_000 },
				),
			(err: unknown) => err instanceof FileLockTimeoutError,
		);
		assert.equal(readFileSync(lockPath, "utf8"), livePayload);
	} finally {
		rmSync(lockPath, { force: true });
	}
});

test("hot <5m prompt cache keeps current healthy slot/model sticky against cross-window lastUserModel drift", async () => {
	writeFileSync(
		join(agentDir, "auth.json"),
		JSON.stringify({
			"openai-codex": { type: "oauth", access: "c1", refresh: "cr1", accountId: "a1" },
			"openai-codex-account-2": { type: "oauth", access: "c2", refresh: "cr2", accountId: "a2" },
		}),
	);
	writeFileSync(
		join(agentDir, "provider-failover.json"),
		JSON.stringify({
			childProxy: false,
			includeCursor: false,
			showUsage: false,
			autoDiscoverModels: false,
			preferLatestModel: true,
		}),
	);
	writeFileSync(
		join(agentDir, "provider-failover-state.json"),
		JSON.stringify({
			stateVersion: STATE_VERSION,
			lastUserModel: { provider: "openai-codex", id: "gpt-5.5" },
		}),
	);

	const h = createSessionHarness({
		initialModel: { provider: "openai-codex", id: "gpt-5.5" },
	});
	await h.fire("session_start");
	assert.deepEqual(h.ctx.model, { provider: "openai-codex", id: "gpt-5.5" });

	// Simulate an active turn completing on openai-codex/gpt-5.5 (establishing a hot <5m prompt cache).
	await h.fire("after_provider_response", {
		status: 200,
		headers: { "x-codex-primary-used-percent": "18" },
	});
	await h.fire("message_end", {
		message: {
			role: "assistant",
			provider: "openai-codex",
			model: "gpt-5.5",
			stopReason: "stop",
			timestamp: Date.now(),
		},
	});

	// Another Pi window switches to openai-codex-account-2 and writes lastUserModel to disk.
	writeFileSync(
		join(agentDir, "provider-failover-state.json"),
		JSON.stringify({
			stateVersion: STATE_VERSION,
			lastUserModel: { provider: "openai-codex-account-2", id: "gpt-5.6" },
		}),
	);
	// Force in-memory merge via model_select or usage flush, then run next user input preflight:
	await h.fire("input", { text: "continue working on the same session" });
	await h.fire("before_agent_start");
	assert.deepEqual(
		h.ctx.model,
		{ provider: "openai-codex", id: "gpt-5.5" },
		"active session with hot healthy slot must not be hijacked to another window's slot",
	);

	// Now if openai-codex hits a 429 while <5m hot cache is active, sibling failover preserves model identity (gpt-5.5)
	// instead of cross-model upgrading to gpt-5.6 mid-conversation!
	await h.fire("message_end", {
		message: {
			role: "assistant",
			provider: "openai-codex",
			model: "gpt-5.5",
			stopReason: "error",
			timestamp: Date.now() + 1,
			errorMessage: "429 usage_limit_reached",
		},
	});
	assert.deepEqual(
		h.ctx.model,
		{ provider: "openai-codex-account-2", id: "gpt-5.5" },
		"mid-conversation sibling failover preserves model identity to avoid thinking-to-text cache bust",
	);
	await h.fire("session_shutdown");
});

test("manual Esc abort is not rewritten into permanent [handoff:interrupted-turn] while error turns are preserved", async () => {
	writeFileSync(
		join(agentDir, "auth.json"),
		JSON.stringify({
			"openai-codex": { type: "oauth", access: "c1", refresh: "cr1" },
		}),
	);
	writeFileSync(
		join(agentDir, "provider-failover.json"),
		JSON.stringify({
			childProxy: false,
			includeCursor: false,
			showUsage: false,
			autoDiscoverModels: false,
		}),
	);
	const h = createSessionHarness();
	await h.fire("session_start");

	const manualAbortedMsg = {
		role: "assistant",
		provider: "openai-codex",
		model: "gpt-5.5",
		stopReason: "aborted",
		timestamp: 100,
		content: [{ type: "text", text: "User pressed Esc mid-thought" }],
	};
	await h.fire("agent_end", { messages: [manualAbortedMsg] });
	await h.fire("input", { text: "new question" });
	await h.fire("before_agent_start");

	const afterEsc = await h.fire("context", {
		messages: [
			{ role: "user", content: "old", timestamp: 99 },
			manualAbortedMsg,
			{ role: "user", content: "new question", timestamp: 101 },
		],
	});
	assert.equal(afterEsc, undefined, "manual Esc turn must not be rewritten into handoff block");

	const errorMsg = {
		role: "assistant",
		provider: "openai-codex",
		model: "gpt-5.5",
		stopReason: "error",
		errorMessage: "429 rate limit",
		timestamp: 200,
		content: [{ type: "text", text: "Partial work before 429" }],
	};
	const afterError = await h.fire("context", {
		messages: [{ role: "user", content: "task", timestamp: 199 }, errorMsg],
	});
	assert.ok(afterError?.messages, "provider error turn is still preserved for failover handoff");
	assert.match(afterError.messages[1].content[0].text, /\[handoff:interrupted-turn\]/);
	await h.fire("session_shutdown");
});

test("mtime-cached fast mode preferences and idempotent Cursor lifecycle registration", () => {
	const codexPath = join(agentDir, "codex-fast-mode.json");
	const xaiPath = join(agentDir, "xai-fast-mode.json");
	assert.equal(readCodexFastEnabled(codexPath), true);
	writeCodexFastEnabled(false, codexPath);
	assert.equal(readCodexFastEnabled(codexPath), false);
	writeCodexFastEnabled(true, codexPath);
	assert.equal(readCodexFastEnabled(codexPath), true);

	assert.equal(readXaiFastEnabled(xaiPath), false);
	writeXaiFastEnabled(true, xaiPath);
	assert.equal(readXaiFastEnabled(xaiPath), true);

	let registeredCount = 0;
	const mockPi: any = {
		on() {
			registeredCount++;
		},
	};
	const deps = { cleanupSessionState() {}, stopProxy() {} };
	registerSessionLifecycleHooks(mockPi, deps);
	const firstCount = registeredCount;
	assert.equal(firstCount, 5);
	registerSessionLifecycleHooks(mockPi, deps);
	registerSessionLifecycleHooks(mockPi, deps);
	assert.equal(registeredCount, 5, "duplicate registerSessionLifecycleHooks calls must be a no-op");
});
