import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
