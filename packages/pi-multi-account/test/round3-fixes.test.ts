import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "pmacct-round3-"));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

const { default: piMultiAccount } = await import("../index.ts");
const { STATE_VERSION } = await import("../failover-state.ts");

after(() => {
	rmSync(agentDir, { recursive: true, force: true });
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

function createHarness() {
	const handlers = new Map<string, Array<(...args: any[]) => any>>();
	const registeredProviders = new Map<string, any>();
	let currentModel: any = { provider: "openai-codex", id: "gpt-5.5" };
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
		registerCommand() {},
		registerTool() {},
		appendEntry() {},
		async setModel(m: any) {
			currentModel = m;
			return true;
		},
	};
	piMultiAccount(pi);
	const ctx: any = {
		get model() {
			return currentModel;
		},
		hasUI: false,
		ui: { notify() {}, setStatus() {} },
		modelRegistry: {
			getAll: () => [
				{ provider: "openai-codex", id: "gpt-5.5" },
				{ provider: "anthropic", id: "claude-opus-4-8" },
				{ provider: "kimi-coding", id: "k3" },
			],
			find: (provider: string, id: string) => ({ provider, id }),
			authStorage: { reload() {} },
		},
	};
	return {
		registeredProviders,
		ctx,
		async fire(event: string, payload: any = {}) {
			for (const fn of handlers.get(event) ?? []) {
				await fn(payload, ctx);
			}
		},
	};
}

test("spare kimi-coding-account-2 without usable credentials never pollutes models.json", async () => {
	const authPath = join(agentDir, "auth.json");
	const modelsPath = join(agentDir, "models.json");
	writeFileSync(
		authPath,
		JSON.stringify({
			"kimi-coding": { type: "oauth", access: "k1", refresh: "kr1" },
		}),
	);
	writeFileSync(
		modelsPath,
		JSON.stringify({
			providers: {
				"kimi-coding-account-2": {
					api: "anthropic-messages",
					baseUrl: "https://api.kimi.com/coding",
					models: [{ id: "k3" }],
				},
				custom: {
					api: "openai-completions",
					baseUrl: "https://example.com/v1",
					models: [{ id: "m1" }],
				},
			},
		}),
	);
	writeFileSync(
		join(agentDir, "provider-failover.json"),
		JSON.stringify({ childProxy: false, includeCursor: false }),
	);
	const h = createHarness();
	await h.fire("session_start");
	assert.equal(h.registeredProviders.has("kimi-coding-account-2"), true, "spare login slot still registered in-memory");
	const afterSpare = JSON.parse(readFileSync(modelsPath, "utf8"));
	assert.equal(afterSpare.providers["kimi-coding-account-2"], undefined, "unauthenticated spare slot must be unprovisioned from models.json");
	assert.ok(afterSpare.providers.custom, "unrelated custom providers remain intact");
	await h.fire("session_shutdown");
});

test("persist losslessly merges concurrent disk cooldowns, invalidations, and lastSwitches", async () => {
	const authPath = join(agentDir, "auth.json");
	const statePath = join(agentDir, "provider-failover-state.json");
	writeFileSync(
		authPath,
		JSON.stringify({
			"openai-codex": { type: "oauth", access: "c1", refresh: "cr1" },
			"openai-codex-account-2": { type: "oauth", access: "c2", refresh: "cr2" },
			anthropic: { type: "oauth", access: "a1", refresh: "ar1" },
		}),
	);
	writeFileSync(
		join(agentDir, "provider-failover.json"),
		JSON.stringify({ childProxy: false, includeCursor: false }),
	);
	rmSync(statePath, { force: true });

	const h = createHarness();
	await h.fire("session_start");

	// Simulate a concurrent Pi process writing cooldowns, invalidations, and switches to disk.
	const now = Date.now();
	const peerUntil = now + 120_000;
	writeFileSync(
		statePath,
		JSON.stringify({
			stateVersion: STATE_VERSION,
			exhaustedUntilByProvider: {
				"openai-codex-account-2": peerUntil,
				"openai-codex": now - 5_000, // expired: should be dropped
			},
			exhaustedUntilByModel: {
				"openai-codex-account-2/gpt-5.5": peerUntil,
			},
			invalidatedByProvider: {
				"openai-codex-account-2": {
					tokenHash: "",
					at: now - 100,
					reason: "peer invalidation",
				},
			},
			lastSwitches: [
				{
					from: "openai-codex-account-2/gpt-5.5",
					to: "openai-codex/gpt-5.5",
					reason: "peer switch",
					at: now - 50,
				},
			],
		}),
	);

	// Trigger a local persist via model_select in this process.
	await h.fire("model_select", {
		model: { provider: "anthropic", id: "claude-opus-4-8" },
		source: "manual",
	});

	assert.equal(existsSync(statePath), true);
	const merged = JSON.parse(readFileSync(statePath, "utf8"));
	assert.equal(merged.exhaustedUntilByProvider["openai-codex-account-2"], peerUntil);
	assert.equal(merged.exhaustedUntilByProvider["openai-codex"], undefined, "expired disk cooldown dropped");
	assert.equal(merged.exhaustedUntilByModel["openai-codex-account-2/gpt-5.5"], peerUntil);
	assert.equal(merged.invalidatedByProvider["openai-codex-account-2"]?.reason, "peer invalidation");
	assert.equal(merged.lastSwitches.length, 1);
	assert.equal(merged.lastSwitches[0].reason, "peer switch");
	await h.fire("session_shutdown");
});
