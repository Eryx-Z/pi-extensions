import assert from "node:assert/strict";
import test from "node:test";
import { registerAntigravitySlot } from "../provider-slots.ts";
import { getAntigravityRequestModelId } from "../antigravity/models/models.ts";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";

function slot(pi: any, id: string) {
	registerAntigravitySlot(pi, id, id);
	return pi.configs.get(id);
}
const pi = () => ({ configs: new Map(), registerProvider(id: string, config: any) { this.configs.set(id, config); } });
const credential = (email: string) => ({ type: "oauth" as const, access: email, refresh: "refresh", projectId: "project", email, expires: Date.now() + 3600000 });
function context(email: string, stored?: any, overrides: Partial<RefreshModelsContext> = {}) {
	const published: any[] = [];
	return Object.assign({
		credential: credential(email), stored, allowNetwork: true, force: true,
		signal: new AbortController().signal,
		async publish(publication: any) { published.push(publication); publication.update?.(); return true; },
	}, overrides, { published });
}
const rawModels = (levels = ["low", "medium", "high"]) => Object.fromEntries(
	["gemini-4-argon", "claude-opus-5-5", "claude-sonnet-5-5"].flatMap((id) => levels.map((level) => [
		`${id}-${level}`, { displayName: `${id} (${level})`, model: `ENUM_${id}_${level}`, supportsThinking: true, supportsImages: true },
	])),
);

test("AGY slot registers live model discovery and groups new runtime variants", async (t) => {
	const instance = pi();
	const config = slot(instance, "antigravity");
	assert.equal(typeof config.refreshModels, "function", "AGY must not stay on its static catalog");
	let calls = 0;
	t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
		calls++;
		assert.equal(JSON.parse(init.body).project, "project");
		assert.equal(init.headers.Authorization, "Bearer first@example.test");
		assert.ok(init.signal);
		assert.match(init.headers["User-Agent"], /^antigravity\/cli\/1\.5\.3 /, "old client versions hide Gemini 4 server-side");
		return Response.json({ models: { ...rawModels(), "gemini-4-argon-disabled": { displayName: "Gemini 4 Argon" } } });
	});
	const ctx = context("first@example.test");
	const models = await config.refreshModels(ctx);
	assert.deepEqual(new Set(models.map((m: any) => m.id)), new Set(["gemini-4-argon", "claude-opus-5-5", "claude-sonnet-5-5"]));
	assert.equal(models[0].thinkingLevelMap.medium, "medium");
	assert.ok(calls > 0);
	const persisted = ctx.published.find((p: any) => p.persist)?.persist;
	assert.ok(persisted);
	assert.doesNotMatch(JSON.stringify(persisted), /first@example\.test|refresh|Bearer/);
	const again = slot(instance, "antigravity");
	assert.deepEqual(again.models, models, "renaming/re-registering the slot retains live models");
	const before = calls;
	await again.refreshModels(context("first@example.test", persisted, { force: false }));
	assert.equal(calls, before, "fresh catalogs must respect the TTL");
	await again.refreshModels(context("first@example.test", persisted, { allowNetwork: false }));
	assert.equal(calls, before, "cache-only refresh must never call the network");
});

test("AGY catalogs, cached identities and thinking routes stay isolated across slots", async (t) => {
	t.mock.method(globalThis, "fetch", async (_url: any, init: any) => Response.json({ models:
		init.headers.Authorization.includes("first") ? rawModels() : rawModels(["low"]),
	}));
	const instance = pi();
	const first = slot(instance, "antigravity");
	const second = slot(instance, "antigravity-account-2");
	const a = context("first@example.test");
	const b = context("second@example.test");
	await Promise.all([first.refreshModels(a), second.refreshModels(b)]);
	assert.equal(slot(instance, "antigravity").models[0].thinkingLevelMap.high, "high");
	assert.equal(slot(instance, "antigravity-account-2").models[0].thinkingLevelMap.high, null);

	// The stream must use the slot's routes, not whichever account refreshed last.
	const requests: any[] = [];
	t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
		requests.push(JSON.parse(init.body));
		return new Response('data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}}\n\n', { headers: { "content-type": "text/event-stream" } });
	});
	for (const id of ["antigravity", "antigravity-account-2"]) {
		const config = slot(instance, id);
		const model = { ...config.models.find((m: any) => m.id === "claude-opus-5-5"), provider: id, api: "antigravity-api" };
		const stream = config.streamSimple(model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, {
			apiKey: JSON.stringify({ token: "token", projectId: "project" }), reasoning: "high",
		});
		const result = await stream.result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
	}
	assert.deepEqual(requests.map((r) => r.model), ["claude-opus-5-5-high", "claude-opus-5-5-low"]);
	assert.deepEqual(requests.map((r) => r.request.labels.model_enum), ["ENUM_claude-opus-5-5_high", "ENUM_claude-opus-5-5_low"]);
	assert.equal(getAntigravityRequestModelId("claude-opus-5-5", "high"), "claude-opus-5-5", "no global routing mutation");

	const persisted = a.published.find((p: any) => p.persist).persist;
	const fresh = slot(pi(), "antigravity");
	assert.ok((await fresh.refreshModels(context("first@example.test", persisted, { allowNetwork: false }))).some((m: any) => m.id === "gemini-4-argon"));
	const changed = await fresh.refreshModels(context("different@example.test", persisted, { allowNetwork: false }));
	assert.ok(!changed.some((m: any) => m.id === "gemini-4-argon"), "another login must not inherit the old account's cache");
});

test("AGY failed, empty, cancelled and rejected publications preserve last good catalog", async (t) => {
	let mode = "ok";
	t.mock.method(globalThis, "fetch", async () => mode === "error" ? new Response("unavailable", { status: 503 }) : Response.json({ models: mode === "empty" ? {} : rawModels() }));
	const instance = pi();
	const config = slot(instance, "antigravity");
	assert.equal(typeof config.refreshModels, "function");
	const good = context("first@example.test");
	const models = await config.refreshModels(good);
	for (const failure of ["error", "empty"]) {
		mode = failure;
		await assert.rejects(config.refreshModels(context("first@example.test")));
		assert.deepEqual(slot(instance, "antigravity").models, models);
	}
	mode = "ok";
	await config.refreshModels(context("first@example.test", undefined, { signal: AbortSignal.abort() }));
	assert.deepEqual(slot(instance, "antigravity").models, models);
	const freshInstance = pi();
	const fresh = slot(freshInstance, "antigravity");
	await fresh.refreshModels(context("first@example.test", undefined, { publish: async () => false }));
	assert.ok(!slot(freshInstance, "antigravity").models.some((m: any) => m.id === "gemini-4-argon"));
});
