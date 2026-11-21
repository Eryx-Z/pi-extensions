import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "pmacct-round4-"));
const secretFile = join(agentDir, "slot-proxy-key");
writeFileSync(secretFile, "round4-dedicated-secret-value\n", { mode: 0o600 });

// Allocate an unused loopback port for hermetic slot-proxy takeover testing
const freePort = await new Promise<number>((resolve, reject) => {
	const probe = createServer();
	probe.on("error", reject);
	probe.listen(0, "127.0.0.1", () => {
		const addr = probe.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		probe.close(() => resolve(port));
	});
});

const savedEnv = {
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	PI_SLOT_PROXY_KEY_PATH: process.env.PI_SLOT_PROXY_KEY_PATH,
	PI_SLOT_PROXY_PORT: process.env.PI_SLOT_PROXY_PORT,
};
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_SLOT_PROXY_KEY_PATH = secretFile;
process.env.PI_SLOT_PROXY_PORT = String(freePort);

const { default: piMultiAccount, hasExplicitCliModelArg } = await import("../index.ts");
const { STATE_VERSION } = await import("../failover-state.ts");
const { withFileLockSync, isProcessAlive } = await import("../file-lock.ts");
const { probeHealthySlotProxy, placeholderKeyFor, PROXY_PLACEHOLDER_KEY } = await import("../slot-proxy.ts");
const { provisionNativeSlot } = await import("../pi-files.ts");

after(() => {
	rmSync(agentDir, { recursive: true, force: true });
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

function createSessionHarness(options?: {
	initialModel?: { provider: string; id: string };
	registryModels?: Array<{ provider: string; id: string }>;
	forceRefreshImpl?: (provider: string) => Promise<any>;
}) {
	const handlers = new Map<string, Array<(...args: any[]) => any>>();
	const commands = new Map<string, any>();
	const registeredProviders = new Map<string, any>();
	const entries: Array<{ type: string; data: any }> = [];
	const notifications: Array<{ text: string; level: string }> = [];
	let currentModel: any = options?.initialModel ?? { provider: "openai-codex", id: "gpt-5.5" };
	const defaultModels = options?.registryModels ?? [
		{ provider: "openai-codex", id: "gpt-5.5" },
		{ provider: "anthropic", id: "claude-opus-4-8" },
		{ provider: "xai", id: "grok-2-1212" },
		{ provider: "xai", id: "grok-4.6" },
		{ provider: "xai", id: "grok-4.7" },
		{ provider: "eryx-qwen38", id: "qwen3.8-local" },
		{ provider: "onespark", id: "onespark-pro" },
	];

	const pi: any = {
		events: { on() {}, emit() {} },
		on(event: string, fn: (...args: any[]) => any) {
			const list = handlers.get(event) ?? [];
			list.push(fn);
			handlers.set(event, list);
		},
		registerProvider(id: string, cfg: any) {
			registeredProviders.set(id, cfg);
		},
		unregisterProvider(id: string) {
			registeredProviders.delete(id);
		},
		registerCommand(name: string, spec: any) {
			commands.set(name, spec);
		},
		registerTool() {},
		appendEntry(type: string, data: any) {
			entries.push({ type, data });
		},
		async setModel(m: any) {
			currentModel = m;
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
		ui: {
			notify(text: string, level: string) {
				notifications.push({ text, level });
			},
			setStatus() {},
		},
		modelRegistry: {
			getAll: () => defaultModels,
			find: (provider: string, id: string) =>
				defaultModels.find((m) => m.provider === provider && m.id === id),
			authStorage: {
				reload() {},
				...(options?.forceRefreshImpl
					? { forceRefreshProvider: options.forceRefreshImpl }
					: {}),
			},
		},
	};

	return {
		ctx,
		entries,
		notifications,
		commands,
		registeredProviders,
		async fire(event: string, payload: any = {}) {
			for (const fn of handlers.get(event) ?? []) {
				await fn(payload, ctx);
			}
		},
	};
}

test("secondary session reuses healthy peer slot-proxy and automatically takes over port when primary exits", async () => {
	writeFileSync(
		join(agentDir, "auth.json"),
		JSON.stringify({
			anthropic: { type: "oauth", access: "a1", refresh: "ar1" },
			"anthropic-account-2": { type: "oauth", access: "a2", refresh: "ar2" },
		}),
	);
	writeFileSync(
		join(agentDir, "provider-failover.json"),
		JSON.stringify({
			childProxy: true,
			includeCursor: false,
			showUsage: false,
			autoDiscoverModels: false,
			usageStatusRefreshMs: 40,
		}),
	);

	const primary = createSessionHarness({
		initialModel: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	await primary.fire("session_start");
	assert.equal(await probeHealthySlotProxy(freePort, agentDir), true);

	const secondary = createSessionHarness({
		initialModel: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	await secondary.fire("session_start");
	assert.equal(await probeHealthySlotProxy(freePort, agentDir), true);

	// Shut down primary listener; secondary must detect dead peer and re-bind freePort!
	await primary.fire("session_shutdown");
	await secondary.fire("before_agent_start");
	assert.equal(
		await probeHealthySlotProxy(freePort, agentDir),
		true,
		"secondary session must automatically take over the slot-proxy port after primary shutdown",
	);

	// Verify public placeholder is rejected (401) while derived placeholder is admitted on live proxy
	const badRes = await fetch(`http://127.0.0.1:${freePort}/anthropic-account-2/v1/messages`, {
		method: "POST",
		headers: { authorization: `Bearer ${PROXY_PLACEHOLDER_KEY}` },
		body: "{}",
	});
	assert.equal(badRes.status, 401);
	assert.equal(placeholderKeyFor("anthropic", secretFile) !== PROXY_PLACEHOLDER_KEY, true);

	await secondary.fire("session_shutdown");
});

test("restoreRememberedModel and ensureReadyModel never hijack explicit --model or neverFailoverProviders, and discoverRotation excludes them", async () => {
	writeFileSync(
		join(agentDir, "auth.json"),
		JSON.stringify({
			"openai-codex": { type: "oauth", access: "c1", refresh: "cr1" },
			onespark: { type: "api_key", key: "sk-onespark" },
		}),
	);
	writeFileSync(
		join(agentDir, "provider-failover.json"),
		JSON.stringify({
			childProxy: false,
			includeCursor: false,
			showUsage: false,
			autoDiscoverModels: false,
			includeOtherProviders: true,
			neverFailoverProviders: ["onespark", "eryx-qwen38", "eryx-gemma4"],
		}),
	);
	writeFileSync(
		join(agentDir, "provider-failover-state.json"),
		JSON.stringify({
			stateVersion: STATE_VERSION,
			lastUserModel: { provider: "openai-codex", id: "gpt-5.5" },
		}),
	);

	// 1. hasExplicitCliModelArg parses --model, -m, --model=* and stops at --
	assert.equal(hasExplicitCliModelArg(["node", "pi", "--model", "eryx-qwen38/qwen3.8-local"]), true);
	assert.equal(hasExplicitCliModelArg(["node", "pi", "-m", "anthropic/claude-opus-4-8"]), true);
	assert.equal(hasExplicitCliModelArg(["node", "pi", "--model=onespark/onespark-pro"]), true);
	assert.equal(hasExplicitCliModelArg(["node", "pi", "--", "--model", "ignored"]), false);

	// 2. Local endpoint in neverFailoverProviders is never hijacked to remembered cloud model
	const localSession = createSessionHarness({
		initialModel: { provider: "eryx-qwen38", id: "qwen3.8-local" },
	});
	await localSession.fire("session_start");
	assert.deepEqual(localSession.ctx.model, {
		provider: "eryx-qwen38",
		id: "qwen3.8-local",
	});
	// Also verify onespark was filtered out of rotation despite includeOtherProviders: true
	const startNotice = localSession.notifications.find((n) => n.text.includes("in rotation"))?.text ?? "";
	assert.equal(startNotice.includes("1 account(s) in rotation"), true, startNotice);
	await localSession.fire("session_shutdown");

	// 3. Explicit CLI --model flag prevents startup hijack even for standard providers
	const savedArgv = process.argv.slice();
	process.argv = [...savedArgv.slice(0, 2), "--model=anthropic/claude-opus-4-8"];
	try {
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({
				"openai-codex": { type: "oauth", access: "c1", refresh: "cr1" },
				anthropic: { type: "oauth", access: "a1", refresh: "ar1" },
			}),
		);
		const cliSession = createSessionHarness({
			initialModel: { provider: "anthropic", id: "claude-opus-4-8" },
		});
		await cliSession.fire("session_start");
		assert.deepEqual(cliSession.ctx.model, {
			provider: "anthropic",
			id: "claude-opus-4-8",
		});
		await cliSession.fire("session_shutdown");
	} finally {
		process.argv = savedArgv;
	}
});

test("preferredModels[provider] ranks external flagships first, refreshes xai OAuth, and logs accurate transient failure", async () => {
	writeFileSync(
		join(agentDir, "auth.json"),
		JSON.stringify({
			xai: { type: "oauth", access: "xai-tok", refresh: "xai-ref" },
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
			includeOtherProviders: true,
			providerPriority: ["xai", "openai-codex"],
			preferredModels: {
				xai: ["grok-4.7", "grok-4.6"],
			},
		}),
	);
	rmSync(join(agentDir, "provider-failover-state.json"), { force: true });

	let refreshedProviders: string[] = [];
	const h = createSessionHarness({
		initialModel: { provider: "openai-codex", id: "gpt-5.5" },
		forceRefreshImpl: async (provider: string) => {
			refreshedProviders.push(provider);
			return { status: "refreshed" };
		},
	});
	await h.fire("session_start");

	// Fail over from openai-codex -> xai; preferredModels['xai'] must pick grok-4.7 over alphabetical grok-2-1212
	await h.fire("message_end", {
		message: {
			role: "assistant",
			provider: "openai-codex",
			model: "gpt-5.5",
			stopReason: "error",
			timestamp: 1,
			errorMessage: "429 usage_limit_reached",
		},
	});
	assert.deepEqual(h.ctx.model, { provider: "xai", id: "grok-4.7" });

	// Revoked xai OAuth token triggers forceRefreshProvider without unnecessarily failing away
	await h.fire("message_end", {
		message: {
			role: "assistant",
			provider: "xai",
			model: "grok-4.7",
			stopReason: "error",
			timestamp: 2,
			errorMessage: "401 token has been invalidated",
		},
	});
	assert.deepEqual(refreshedProviders, ["xai"]);
	assert.deepEqual(h.ctx.model, { provider: "xai", id: "grok-4.7" });

	// Clear openai-codex cooldown and trigger a transient 503 on xai -> must log 'external provider request failed'
	await h.commands.get("multi-account").handler("reset", h.ctx);
	h.ctx.model = { provider: "xai", id: "grok-4.7" };
	await h.fire("message_end", {
		message: {
			role: "assistant",
			provider: "xai",
			model: "grok-4.7",
			stopReason: "error",
			timestamp: 3,
			errorMessage: "503 service unavailable upstream",
		},
	});
	const lastSwitch = h.entries.at(-1)?.data;
	assert.match(lastSwitch?.reason ?? "", /^external provider request failed:/);
	await h.fire("session_shutdown");
});

test("withFileLockSync preempts dead/stale locks and persist three-way merges usageUntrustedUntilByProvider", async () => {
	const target = join(agentDir, "models.json");
	const lockPath = `${target}.lock`;

	// Dead PID lock is preempted immediately
	assert.equal(isProcessAlive(999_999_999), false);
	writeFileSync(
		lockPath,
		JSON.stringify({ pid: 999_999_999, token: "dead", acquiredAt: Date.now() }),
		{ mode: 0o600 },
	);
	let ran = false;
	withFileLockSync(target, () => {
		ran = true;
	});
	assert.equal(ran, true);

	// Stale live-PID lock past staleMs is preempted cleanly
	writeFileSync(
		lockPath,
		JSON.stringify({ pid: process.pid, token: "stale-tok", acquiredAt: Date.now() - 10_000 }),
		{ mode: 0o600 },
	);
	const past = new Date(Date.now() - 10_000);
	utimesSync(lockPath, past, past);
	provisionNativeSlot("custom-locked-slot", {
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:11434/v1",
		models: [{ id: "m1" }],
	});
	const modelsDisk = JSON.parse(readFileSync(target, "utf8"));
	assert.ok(modelsDisk.providers["custom-locked-slot"]);

	// Three-way merge of usageUntrustedUntilByProvider in persist()
	const statePath = join(agentDir, "provider-failover-state.json");
	writeFileSync(
		join(agentDir, "auth.json"),
		JSON.stringify({
			"openai-codex": { type: "oauth", access: "c1", refresh: "cr1" },
			anthropic: { type: "oauth", access: "a1", refresh: "ar1" },
		}),
	);
	const h = createSessionHarness({
		initialModel: { provider: "openai-codex", id: "gpt-5.5" },
	});
	await h.fire("session_start");

	const peerUntrustedUntil = Date.now() + 180_000;
	writeFileSync(
		statePath,
		JSON.stringify({
			stateVersion: STATE_VERSION,
			usageUntrustedUntilByProvider: {
				anthropic: peerUntrustedUntil,
				"openai-codex": Date.now() - 1_000, // expired
			},
		}),
	);

	await h.fire("model_select", {
		model: { provider: "openai-codex", id: "gpt-5.5" },
		source: "manual",
	});
	const mergedState = JSON.parse(readFileSync(statePath, "utf8"));
	assert.equal(mergedState.usageUntrustedUntilByProvider.anthropic, peerUntrustedUntil);
	assert.equal(mergedState.usageUntrustedUntilByProvider["openai-codex"], undefined);
	await h.fire("session_shutdown");
});
