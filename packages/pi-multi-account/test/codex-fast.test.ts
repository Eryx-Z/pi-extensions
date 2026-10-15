import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	applyCodexFastMode,
	isCodexFastModel,
	readCodexFastEnabled,
	shapeCodexFastPayload,
	writeCodexFastEnabled,
} from "../codex-fast.ts";
import child from "../subagent-provider.ts";

const codex = { provider: "openai-codex", api: "openai-codex-responses" };
const slot = { provider: "openai-codex-account-4", api: "openai-codex-responses" };

test("Codex fast mode matches the base provider and numbered slots only", () => {
	assert.equal(isCodexFastModel(codex), true);
	assert.equal(isCodexFastModel(slot), true);
	assert.equal(isCodexFastModel({ provider: "openai-codex-account-2" }), true);
	assert.equal(isCodexFastModel({ provider: "openai", api: "openai-responses" }), false);
	assert.equal(isCodexFastModel({ provider: "openai-codex-account-2-extra" }), false);
	assert.equal(isCodexFastModel({ provider: "grok-cli", api: "openai-codex-responses" }), false);
	assert.equal(isCodexFastModel({ provider: "openai-codex", api: "openai-responses" }), false);
});

test("priority tier is set and removed without copying the payload", () => {
	const payload: { model: string; temperature: number; service_tier?: string } = {
		model: "gpt-6-astra",
		temperature: 0,
	};
	assert.equal(applyCodexFastMode(payload, true), payload);
	assert.equal(payload.service_tier, "priority");
	applyCodexFastMode(payload, false);
	assert.equal("service_tier" in payload, false);
	const untouched = ["not", "an object"];
	assert.equal(applyCodexFastMode(untouched, true), untouched);
});

test("non-Codex payloads and a disabled preference are left standard", () => {
	const root = mkdtempSync(join(tmpdir(), "codex-fast-"));
	const path = join(root, "codex-fast-mode.json");
	try {
		assert.equal(readCodexFastEnabled(join(root, "missing.json")), true);
		writeFileSync(path, "{}\n");
		assert.equal(readCodexFastEnabled(path), true);
		writeCodexFastEnabled(false, path);
		assert.equal(readCodexFastEnabled(path), false);
		const anthropic = { model: "claude" };
		assert.equal(
			shapeCodexFastPayload(anthropic, { provider: "anthropic" }, false),
			anthropic,
		);
		assert.equal("service_tier" in anthropic, false);
		const shaped = shapeCodexFastPayload({ model: "gpt-6-astra", service_tier: "priority" }, slot, false) as {
			service_tier?: string;
		};
		assert.equal(shaped.service_tier, undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("RPC child applies the shared preference and ignores other providers", () => {
	const root = mkdtempSync(join(tmpdir(), "codex-fast-child-"));
	const previous = {
		child: process.env.PI_RPC_SUBAGENT_CHILD,
		loadout: process.env.PI_RPC_SUBAGENT_LOADOUT,
		agentDir: process.env.PI_CODING_AGENT_DIR,
	};
	process.env.PI_RPC_SUBAGENT_CHILD = "1";
	process.env.PI_RPC_SUBAGENT_LOADOUT = join(root, "loadout.json");
	process.env.PI_CODING_AGENT_DIR = root;
	writeFileSync(process.env.PI_RPC_SUBAGENT_LOADOUT, JSON.stringify({ model: "openai-codex-account-4/gpt-6-astra" }));
	try {
		let handler: ((event: { payload: unknown }, ctx: { model: { provider: string; api: string } }) => unknown) | undefined;
		child({
			registerProvider() {},
			on(event: string, fn: typeof handler) {
				assert.equal(event, "before_provider_request");
				handler = fn;
			},
		} as unknown as Parameters<typeof child>[0]);
		assert.ok(handler);
		const on = handler!({ payload: { model: "gpt-6-astra" } }, { model: slot }) as { service_tier?: string };
		assert.equal(on.service_tier, "priority");
		writeCodexFastEnabled(false);
		const off = handler!(
			{ payload: { model: "gpt-6-astra", service_tier: "priority" } },
			{ model: slot },
		) as { service_tier?: string };
		assert.equal(off.service_tier, undefined);
		const other = handler!({ payload: { model: "grok" } }, { model: { provider: "grok-cli", api: "openai-responses" } });
		assert.equal(other, undefined);
	} finally {
		for (const [key, value] of Object.entries({
			PI_RPC_SUBAGENT_CHILD: previous.child,
			PI_RPC_SUBAGENT_LOADOUT: previous.loadout,
			PI_CODING_AGENT_DIR: previous.agentDir,
		})) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	}
});
