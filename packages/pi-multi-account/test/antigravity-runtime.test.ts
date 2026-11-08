import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { registerAntigravitySlot } from "../provider-slots.ts";

test("real Pi runtime refreshes and restores each AGY slot without network on offline startup", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "agy-runtime-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const authPath = join(dir, "auth.json");
	const modelsStorePath = join(dir, "models-store.json");
	const providers = ["antigravity", "antigravity-account-2"];
	writeFileSync(authPath, JSON.stringify(Object.fromEntries(providers.map((id) => [id, {
		type: "oauth", access: id, refresh: "refresh", email: `${id}@example.test`, projectId: id, expires: Date.now() + 3600000,
	}]))));
	let calls = 0;
	t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
		calls++;
		const second = init.headers.Authorization.endsWith("-2");
		const id = second ? "claude-sonnet-5-5-low" : "gemini-4-argon-high";
		return Response.json({ models: { [id]: { displayName: id, supportsThinking: true } } });
	});
	const createRuntime = () => ModelRuntime.create({ authPath, modelsPath: join(dir, "models.json"), modelsStorePath });
	const runtime = await createRuntime();
	const pi = { registerProvider: runtime.registerProvider.bind(runtime) };
	for (const id of providers) registerAntigravitySlot(pi as any, id, id);
	await runtime.refresh({ allowNetwork: false, providers });
	const result = await runtime.refresh({ allowNetwork: true, force: true, providers });
	assert.equal(result.errors.size, 0, [...result.errors.values()].join("\n"));
	assert.ok(calls > 0);
	assert.deepEqual(runtime.getModels("antigravity").map((m) => m.id), ["gemini-4-argon"]);
	assert.deepEqual(runtime.getModels("antigravity-account-2").map((m) => m.id), ["claude-sonnet-5-5"]);
	const stored = JSON.parse(readFileSync(modelsStorePath, "utf8"));
	for (const id of providers) assert.ok(stored[id]["pi-antigravity"].account);

	const before = calls;
	const restored = await createRuntime();
	const restoredPi = { registerProvider: restored.registerProvider.bind(restored) };
	for (const id of providers) registerAntigravitySlot(restoredPi as any, id, id);
	await restored.refresh({ allowNetwork: false, providers });
	assert.equal(calls, before);
	for (const id of providers) assert.deepEqual(restored.getModels(id).map((m) => m.id), runtime.getModels(id).map((m) => m.id));
});
