import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	applyXaiFastMode,
	isXaiFastModel,
	readXaiFastEnabled,
	shapeXaiFastPayload,
	writeXaiFastEnabled,
} from "../xai-fast.ts";
import child from "../subagent-provider.ts";

const xai = { provider: "xai", api: "openai-responses" };
const slot = { provider: "xai-account-2", api: "openai-completions" };

test("xAI fast mode matches the subscription provider and numbered slots only", () => {
	assert.equal(isXaiFastModel(xai), true);
	assert.equal(isXaiFastModel(slot), true);
	assert.equal(isXaiFastModel({ provider: "xai" }), true);
	assert.equal(isXaiFastModel({ provider: "grok-cli", id: "grok-4.7" }), false);
	assert.equal(isXaiFastModel({ provider: "xai-account-2-extra" }), false);
	assert.equal(isXaiFastModel({ provider: "xai", api: "openai-codex-responses" }), false);
});

test("xAI priority is opt-in and does not touch other providers", () => {
	const root = mkdtempSync(join(tmpdir(), "xai-fast-"));
	const path = join(root, "xai-fast-mode.json");
	try {
		assert.equal(readXaiFastEnabled(path), false);
		const payload: { model: string; service_tier?: string } = { model: "grok-4.7" };
		assert.equal(shapeXaiFastPayload(payload, xai, false), payload);
		assert.equal("service_tier" in payload, false);
		shapeXaiFastPayload(payload, xai, true);
		assert.equal(payload.service_tier, "priority");
		applyXaiFastMode(payload, false);
		assert.equal("service_tier" in payload, false);
		const other: { model: string; service_tier?: string } = { model: "gpt-6-astra" };
		shapeXaiFastPayload(other, { provider: "openai-codex", api: "openai-codex-responses" }, true);
		assert.equal("service_tier" in other, false);
		writeXaiFastEnabled(true, path);
		assert.equal(readXaiFastEnabled(path), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("RPC child bridges xai-fast-mode.json for xai and numbered xai slots", () => {
	const root = mkdtempSync(join(tmpdir(), "xai-fast-child-"));
	const previous = {
		child: process.env.PI_RPC_SUBAGENT_CHILD,
		loadout: process.env.PI_RPC_SUBAGENT_LOADOUT,
		agentDir: process.env.PI_CODING_AGENT_DIR,
	};
	process.env.PI_RPC_SUBAGENT_CHILD = "1";
	process.env.PI_RPC_SUBAGENT_LOADOUT = join(root, "loadout.json");
	process.env.PI_CODING_AGENT_DIR = root;
	writeFileSync(process.env.PI_RPC_SUBAGENT_LOADOUT, JSON.stringify({ model: "xai/grok-4.7" }));
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
		const defaultOff = handler!({ payload: { model: "grok-4.7" } }, { model: xai }) as { service_tier?: string };
		assert.equal(defaultOff.service_tier, undefined);
		writeXaiFastEnabled(true);
		const turnedOn = handler!({ payload: { model: "grok-4.7" } }, { model: slot }) as { service_tier?: string };
		assert.equal(turnedOn.service_tier, "priority");
		writeXaiFastEnabled(false);
		const turnedOff = handler!(
			{ payload: { model: "grok-4.7", service_tier: "priority" } },
			{ model: xai },
		) as { service_tier?: string };
		assert.equal(turnedOff.service_tier, undefined);
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
