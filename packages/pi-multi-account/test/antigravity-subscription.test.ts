import assert from "node:assert/strict";
import test from "node:test";
import { fetchUsageSnapshot, preserveKnownPlan, UsageFetchError } from "../usage.ts";

const credential = { type: "oauth", access: "secret-token", email: "test@example.com" };
const quota = { models: { "gemini-test": { quotaInfo: { remainingFraction: 0.8 } } } };
function mock(load: (url: string) => Promise<Response>): typeof fetch {
	return (async (url) => String(url).includes("loadCodeAssist")
		? load(String(url)) : Response.json(String(url).includes("fetchAvailableModels") ? quota : {})) as typeof fetch;
}
const fetchSnapshot = (fetchImpl: typeof fetch) => fetchUsageSnapshot("antigravity", credential, { fetchImpl, credentialHash: "same" });

test("missing tier tries alternate endpoint and prefers paidTier", async () => {
	let calls = 0;
	const snapshot = await fetchSnapshot(mock(async () => Response.json(++calls === 1 ? {} : {
		currentTier: { name: "Free" }, paidTier: { name: "Pro" },
	})));
	assert.equal(calls, 2);
	assert.equal(snapshot.plan, "Pro");
	assert.equal(snapshot.planWarning, undefined);
	assert.equal(snapshot.primary?.usedPercent, 20);
});

test("401 propagates to existing credential refresh retry", async () => {
	await assert.rejects(fetchSnapshot(mock(async () => new Response(null, { status: 401 }))),
		(error: unknown) => error instanceof UsageFetchError && error.status === 401);
});

test("subscription response body timeout is reported and alternate endpoint tried", async () => {
	let calls = 0;
	const fetchImpl = (async (url, init) => {
		if (!String(url).includes("loadCodeAssist")) return Response.json(quota);
		calls++;
		return { ok: true, status: 200, json: () => new Promise((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
		}) };
	}) as typeof fetch;
	const snapshot = await fetchUsageSnapshot("antigravity", credential, { fetchImpl, timeoutMs: 5 });
	assert.equal(calls, 2);
	assert.match(snapshot.planWarning!, /timeout/);
});

for (const failure of ["http", "missing", "network", "json"] as const) {
	test(`subscription ${failure} failure retains quotas and only same-account known plan`, async () => {
		const snapshot = await fetchSnapshot(mock(async () => {
			if (failure === "network") throw new Error("secret-token");
			if (failure === "json") return new Response("secret-token");
			return failure === "http" ? new Response("secret-token", { status: 503 }) : Response.json({});
		}));
		assert.equal(snapshot.plan, undefined);
		assert.ok(snapshot.planWarning);
		assert.doesNotMatch(snapshot.planWarning, /secret-token/);
		assert.equal(snapshot.primary?.usedPercent, 20);
		const previous = { ...snapshot, plan: "Pro", planWarning: undefined };
		assert.equal(preserveKnownPlan(snapshot, previous).plan, "Pro");
		for (const changed of [{ credentialHash: "other" }, { account: "other" }, { provider: "antigravity-account-2" }, { plan: "subscription" }]) {
			assert.equal(preserveKnownPlan(snapshot, { ...previous, ...changed }).plan, undefined);
		}
		const recovered = await fetchSnapshot(mock(async () => Response.json({ currentTier: { name: "Free" } })));
		assert.equal(preserveKnownPlan(recovered, previous).plan, "Free");
		assert.equal(recovered.planWarning, undefined);
	});
}
