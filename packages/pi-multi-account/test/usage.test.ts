import assert from "node:assert/strict";
import test from "node:test";
import {
	fetchUsageSnapshot,
	formatUsageCompact,
	formatUsageStatus,
	parseAnthropicUsageBody,
	parseCodexUsageBody,
	parseCodexUsageHeaders,
	parseOllamaMeBody,
	parseXaiUsageBodies,
	usageFamily,
} from "../usage.ts";

const NOW = Date.UTC(2026, 5, 13, 12, 0, 0);

test("parses Codex 5h and weekly usage response", () => {
	const snapshot = parseCodexUsageBody(
		"openai-codex-account-2",
		{
			plan_type: "plus",
			rate_limit: {
				primary_window: {
					used_percent: 100,
					limit_window_seconds: 18_000,
					reset_at: NOW / 1000 + 3600,
				},
				secondary_window: {
					used_percent: 58,
					limit_window_seconds: 604_800,
					reset_at: NOW / 1000 + 2 * 86_400,
				},
			},
			credits: { has_credits: false, unlimited: false, balance: "0" },
			// Shape returned by the live /backend-api/wham/usage endpoint.
			rate_limit_reset_credits: {
				available_count: 2,
				applicable_available_count: 0,
			},
		},
		NOW,
		"credential",
	);
	assert.ok(snapshot);
	assert.equal(snapshot.plan, "plus");
	assert.equal(snapshot.primary?.usedPercent, 100);
	assert.equal(snapshot.secondary?.usedPercent, 58);
	assert.equal(snapshot.rateLimitResetCredits, 2);
	assert.equal(
		formatUsageCompact(snapshot, NOW),
		"Codex A2 | plus | 5h 0% left/1h | 7d 42% left/2d",
	);
	assert.equal(
		formatUsageStatus(snapshot, NOW),
		"Codex A2 · 5h 0%/1h · 7d 42%/2d · reset 2",
	);
});

test("Ollama /api/me surfaces plan tier, renewal date, and suspended status", () => {
	// Ollama exposes no token counters, but /api/me carries the plan, billing-period end, and a
	// suspended flag — fold them into the plan line so the footer shows something real.
	const active = parseOllamaMeBody(
		"ollama",
		{
			Plan: "pro",
			SubscriptionPeriodEnd: { Time: "2026-07-16T06:31:51Z", Valid: true },
			SuspendedAt: { Time: null, Valid: false },
		},
		NOW,
		"cred",
	);
	assert.equal(active.plan, "pro · renews 2026-07-16");
	assert.equal(
		formatUsageCompact(active, NOW),
		"Ollama | pro · renews 2026-07-16 · no session/weekly API",
	);

	const suspended = parseOllamaMeBody(
		"ollama",
		{ Plan: "pro", SuspendedAt: { Time: "2026-07-01T00:00:00Z", Valid: true } },
		NOW,
		"cred",
	);
	assert.ok(
		suspended.plan?.includes("SUSPENDED"),
		`suspended plan should flag it, got ${suspended.plan}`,
	);
});

test("parses case-insensitive Codex response headers", () => {
	const snapshot = parseCodexUsageHeaders(
		"openai-codex-account-4",
		{
			"X-Codex-Primary-Used-Percent": "73",
			"x-codex-primary-window-minutes": "300",
			"X-Codex-Primary-Reset-At": String(NOW / 1000 + 1800),
			"x-codex-secondary-used-percent": "9",
			"X-Codex-Secondary-Window-Minutes": "10080",
			"x-codex-secondary-reset-at": String(NOW / 1000 + 86_400),
			"x-codex-rate-limit-reset-credits": "1",
		},
		NOW,
	);
	assert.ok(snapshot);
	assert.equal(snapshot.primary?.windowSeconds, 18_000);
	assert.equal(snapshot.secondary?.windowSeconds, 604_800);
	assert.equal(snapshot.rateLimitResetCredits, 1);
	assert.equal(
		formatUsageCompact(snapshot, NOW),
		"Codex A4 | 5h 27% left/30m | 7d 91% left/1d",
	);
});

test("parses Anthropic OAuth usage windows", () => {
	const snapshot = parseAnthropicUsageBody(
		"anthropic-account-2",
		{
			five_hour: {
				utilization: 84,
				resets_at: new Date(NOW + 90 * 60_000).toISOString(),
			},
			seven_day: {
				utilization: 12,
				resets_at: new Date(NOW + 3 * 86_400_000).toISOString(),
			},
		},
		NOW,
	);
	assert.ok(snapshot);
	assert.equal(snapshot.primary?.usedPercent, 84);
	assert.equal(
		formatUsageCompact(snapshot, NOW),
		"Claude A2 | 5h 16% left/1h30m | 7d 88% left/3d",
	);
});

test("Codex usage fetch sends the account id and never exposes the token in the snapshot", async () => {
	let seenHeaders: Headers | undefined;
	const fetchImpl = (async (
		_input: string | URL | Request,
		init?: RequestInit,
	) => {
		seenHeaders = new Headers(init?.headers);
		return new Response(
			JSON.stringify({
				plan_type: "plus",
				rate_limit: {
					primary_window: { used_percent: 10, reset_at: NOW / 1000 + 3600 },
					secondary_window: { used_percent: 20, reset_at: NOW / 1000 + 86_400 },
				},
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}) as typeof fetch;

	const snapshot = await fetchUsageSnapshot(
		"openai-codex-account-2",
		{ type: "oauth", access: "secret-access-token", accountId: "account-id" },
		{ fetchImpl, credentialHash: "safe-hash" },
	);
	assert.equal(seenHeaders?.get("ChatGPT-Account-Id"), "account-id");
	assert.equal(seenHeaders?.get("Authorization"), "Bearer secret-access-token");
	assert.equal(snapshot.credentialHash, "safe-hash");
	assert.ok(!JSON.stringify(snapshot).includes("secret-access-token"));
});

test("the provider's own allowed/limit_reached verdict is carried, not just the percentages", () => {
	// The Codex usage response answers the question directly — `rate_limit.allowed` /
	// `limit_reached` — and that answer was being dropped on the floor in favour of deriving an
	// opinion from `used_percent`. On a real machine two accounts answered `allowed: true` while
	// reading 98%, and the extension kept them benched: the account said "yes", the percentage
	// said "nearly out", and only the percentage was ever read.
	const free = parseCodexUsageBody("openai-codex-account-2", {
		plan_type: "free",
		rate_limit: {
			allowed: true,
			limit_reached: false,
			primary_window: {
				used_percent: 98,
				limit_window_seconds: 2592000,
				reset_at: Math.floor(Date.now() / 1000) + 2_387_570,
			},
			secondary_window: null,
		},
	});
	assert.equal(
		free?.serviceable,
		true,
		"an account the provider allows must be marked usable",
	);

	const spent = parseCodexUsageBody("openai-codex-account-3", {
		plan_type: "free",
		rate_limit: {
			allowed: false,
			limit_reached: true,
			primary_window: {
				used_percent: 100,
				limit_window_seconds: 2592000,
				reset_at: Math.floor(Date.now() / 1000) + 2_397_006,
			},
			secondary_window: null,
		},
	});
	assert.equal(
		spent?.serviceable,
		false,
		"and one it refuses must be marked blocked",
	);

	const silent = parseCodexUsageBody("openai-codex", {
		plan_type: "plus",
		rate_limit: {
			primary_window: {
				used_percent: 50,
				limit_window_seconds: 18000,
				reset_at: Math.floor(Date.now() / 1000) + 3600,
			},
		},
	});
	assert.equal(
		silent?.serviceable,
		undefined,
		"a response that states no verdict must not have one invented for it",
	);
});

test("the account's identity travels with its usage, and shows in the footer", () => {
	// With seven Codex slots called A2…A7, the footer named the SLOT and nothing else, so there
	// was no way to tell which real account was in use — the one piece of information needed to
	// know whose quota is burning. The usage response carries the email; it was thrown away.
	const snapshot = parseCodexUsageBody("openai-codex-account-2", {
		plan_type: "free",
		email: "alice@example.com",
		rate_limit: {
			allowed: true,
			limit_reached: false,
			primary_window: {
				used_percent: 40,
				limit_window_seconds: 18000,
				reset_at: Math.floor(Date.now() / 1000) + 3600,
			},
		},
	});
	assert.equal(snapshot?.account, "alice@example.com");

	const footer = formatUsageCompact(snapshot!, Date.now());
	assert.match(footer, /Codex A2/, "the slot is still named");
	assert.match(
		footer,
		/alice/,
		`and the real account with it; footer: ${footer}`,
	);
	assert.match(footer, /free/, `along with the plan; footer: ${footer}`);
	assert.match(
		footer,
		/60% left/,
		`without losing the quota; footer: ${footer}`,
	);
});

test("a footer for an account with no email is unchanged", () => {
	// Nothing may become noisier for providers that expose no identity.
	const snapshot = parseCodexUsageBody("openai-codex", {
		plan_type: "plus",
		rate_limit: {
			primary_window: {
				used_percent: 10,
				limit_window_seconds: 18000,
				reset_at: Math.floor(Date.now() / 1000) + 3600,
			},
		},
	});
	assert.equal(snapshot?.account, undefined);
	assert.doesNotMatch(formatUsageCompact(snapshot!, Date.now()), /·\s*\|/);
});

test("xAI creditUsagePercent uses percent units even at or below one", () => {
	for (const percent of [0, 0.5, 1, 50, 100]) {
		const snapshot = parseXaiUsageBodies("xai", {
			config: {
				creditUsagePercent: percent,
				currentPeriod: {
					start: new Date(NOW).toISOString(),
					end: new Date(NOW + 7 * 86_400_000).toISOString(),
				},
			},
		}, undefined, NOW);
		assert.equal(snapshot.primary?.usedPercent, percent);
		assert.equal(snapshot.serviceable, percent === 100 ? false : undefined);
		if (percent === 1) assert.match(formatUsageStatus(snapshot, NOW), /7d 99%/);
	}
});

test("xAI OAuth usage reads Grok billing without inventing a full window", async () => {
	assert.equal(usageFamily("xai"), "xai");
	assert.equal(usageFamily("xai-account-2"), "xai");
	assert.equal(usageFamily("openrouter"), undefined);

	const periodEnd = new Date(NOW + 7 * 86_400_000).toISOString();
	const quiet = parseXaiUsageBodies(
		"xai",
		{
			config: {
				currentPeriod: {
					type: "USAGE_PERIOD_TYPE_WEEKLY",
					start: new Date(NOW).toISOString(),
					end: periodEnd,
				},
				prepaidBalance: { val: 0 },
				onDemandCap: { val: 0 },
				onDemandUsed: { val: 0 },
			},
		},
		{ subscription_tier_display: "SuperGrok Plus" },
		NOW,
	);
	assert.equal(quiet.primary, undefined, "missing percent must not become 100% left");
	assert.equal(quiet.plan, "SuperGrok Plus · weekly resets 7d");
	assert.equal(quiet.serviceable, undefined);

	const spent = parseXaiUsageBodies(
		"xai",
		{
			config: {
				creditUsagePercent: 100,
				currentPeriod: {
					type: "USAGE_PERIOD_TYPE_WEEKLY",
					start: new Date(NOW).toISOString(),
					end: periodEnd,
				},
				prepaidBalance: { val: 0 },
			},
		},
		undefined,
		NOW,
	);
	assert.equal(spent.primary?.usedPercent, 100);
	assert.equal(spent.serviceable, false);
	assert.match(formatUsageStatus(spent, NOW), /7d 0%/);

	const urls: string[] = [];
	const liveEnd = new Date(Date.now() + 7 * 86_400_000).toISOString();
	const fetchImpl = (async (input: string | URL | Request) => {
		urls.push(String(input));
		const url = String(input);
		if (url.includes("/settings")) {
			return new Response(
				JSON.stringify({ subscription_tier_display: "SuperGrok Plus" }),
				{ status: 200 },
			);
		}
		return new Response(
			JSON.stringify({
				config: {
					currentPeriod: {
						type: "USAGE_PERIOD_TYPE_WEEKLY",
						end: liveEnd,
					},
					prepaidBalance: { val: 12 },
				},
			}),
			{ status: 200 },
		);
	}) as typeof fetch;
	const snapshot = await fetchUsageSnapshot(
		"xai",
		{ type: "oauth", access: "secret-xai-token" },
		{ fetchImpl, credentialHash: "safe-hash" },
	);
	assert.ok(urls.some((url) => url.includes("/v1/billing?format=credits")));
	assert.equal(snapshot.plan, "SuperGrok Plus · weekly resets 7d · prepaid 12");
	assert.equal(snapshot.credentialHash, "safe-hash");
	assert.doesNotMatch(JSON.stringify(snapshot), /secret-xai-token/);

	let called = false;
	const apiKey = await fetchUsageSnapshot(
		"xai",
		{ type: "api_key", key: "xai-test-key" },
		{
			fetchImpl: (() => {
				called = true;
				throw new Error("api keys must not hit the subscription billing host");
			}) as typeof fetch,
		},
	);
	assert.equal(called, false);
	assert.match(apiKey.plan ?? "", /api-key/);
	assert.equal(apiKey.primary, undefined);
});

test("a Kimi Coding slot reports itself instead of throwing", async () => {
	// kimi-coding became a managed family, but nothing taught the usage layer about it — so every
	// probe fell through to the OAuth branch and threw "has no OAuth access token" for a perfectly
	// healthy API key. That turns the footer blank and fills the log with failures for an account
	// that is working. Kimi exposes no quota endpoint at all (every documented path 404s), so the
	// honest answer is the plan, not an invented number.
	const snapshot = await fetchUsageSnapshot("kimi-coding", {
		type: "api_key",
		key: "sk-kimi-test",
	});
	assert.equal(snapshot.family, "kimi-coding");
	assert.equal(snapshot.primary, undefined, "no window may be invented");
	assert.match(
		snapshot.plan ?? "",
		/subscription|no usage endpoint/i,
		`the plan line must say what is known; got: ${snapshot.plan}`,
	);
	assert.doesNotMatch(
		JSON.stringify(snapshot),
		/sk-kimi-test/,
		"and the key must never travel in the snapshot",
	);
});

test("an Antigravity slot parses usage windows from loadCodeAssist and fetchAvailableModels", async () => {
	const mockFetch = async (url: any) => {
		const sUrl = String(url);
		if (sUrl.includes("loadCodeAssist")) {
			return {
				ok: true,
				status: 200,
				json: async () => ({
					currentTier: { id: "free-tier", name: "Antigravity Free" },
					cloudaicompanionProject: "proj-123",
				}),
			} as any;
		}
		if (sUrl.includes("fetchAvailableModels")) {
			return {
				ok: true,
				status: 200,
				json: async () => ({
					models: {
						"gemini-3.8-flash": {
							quotaInfo: {
								remainingFraction: 0.8,
								resetTime: new Date(Date.now() + 3600 * 1000).toISOString(),
							},
						},
						"claude-sonnet-4-6": {
							quotaInfo: {
								remainingFraction: 0.95,
								resetTime: new Date(Date.now() + 7200 * 1000).toISOString(),
							},
						},
					},
				}),
			} as any;
		}
		return { ok: false, status: 404 } as any;
	};

	const snapshot = await fetchUsageSnapshot(
		"antigravity",
		{
			type: "oauth",
			access: "ya29.test-token",
			email: "user@example.com",
		},
		{
			fetchImpl: mockFetch as any,
		},
	);

	assert.equal(snapshot.family, "antigravity");
	assert.equal(snapshot.plan, "Antigravity Free");
	assert.equal(snapshot.account, "user@example.com");
	assert.equal(snapshot.serviceable, true);
	assert.ok(snapshot.primary);
	assert.equal(snapshot.primary.usedPercent, 20);
	assert.ok(snapshot.secondary);
	assert.equal(snapshot.secondary.usedPercent, 5);
});

test("an Antigravity slot parses usage windows from retrieveUserQuotaSummary", async () => {
	const mockFetch = async (url: any) => {
		const sUrl = String(url);
		if (sUrl.includes("loadCodeAssist")) {
			return {
				ok: true,
				status: 200,
				json: async () => ({
					currentTier: { id: "free-tier", name: "Antigravity" },
					cloudaicompanionProject: "proj-123",
				}),
			} as any;
		}
		if (sUrl.includes("retrieveUserQuotaSummary")) {
			return {
				ok: true,
				status: 200,
				json: async () => ({
					groups: [
						{
							displayName: "Gemini Models",
							description: "Models within this group: Gemini Flash, Gemini Pro",
							buckets: [
								{
									bucketId: "gemini-weekly",
									displayName: "Weekly Limit Remaining",
									window: "weekly",
									remainingFraction: 0.97,
									resetTime: new Date(Date.now() + 5 * 86400 * 1000).toISOString(),
								},
								{
									bucketId: "gemini-5h",
									displayName: "Five Hour Limit Remaining",
									window: "5h",
									remainingFraction: 0.85,
									resetTime: new Date(Date.now() + 4 * 3600 * 1000).toISOString(),
								},
							],
						},
						{
							displayName: "Claude and GPT models",
							description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
							buckets: [
								{
									bucketId: "3p-weekly",
									displayName: "Weekly Limit Remaining",
									window: "weekly",
									remainingFraction: 1,
									resetTime: new Date(Date.now() + 7 * 86400 * 1000).toISOString(),
								},
								{
									bucketId: "3p-5h",
									displayName: "Five Hour Limit Remaining",
									window: "5h",
									remainingFraction: 1,
									resetTime: new Date(Date.now() + 5 * 3600 * 1000).toISOString(),
								},
							],
						},
					],
				}),
			} as any;
		}
		return { ok: false, status: 404 } as any;
	};

	const snapshot = await fetchUsageSnapshot(
		"antigravity",
		{
			type: "oauth",
			access: "ya29.test-token",
			email: "spike.zhang.ai@gmail.com",
		},
		{
			fetchImpl: mockFetch as any,
		},
	);

	assert.equal(snapshot.family, "antigravity");
	assert.equal(snapshot.plan, "Antigravity");
	assert.equal(snapshot.account, "spike.zhang.ai@gmail.com");
	assert.equal(snapshot.serviceable, true);
	assert.ok(snapshot.primary);
	assert.equal(snapshot.primary.usedPercent, 15);
	assert.equal(snapshot.primary.windowSeconds, 18000);
	assert.ok(snapshot.secondary);
	assert.equal(snapshot.secondary.usedPercent, 0);
	assert.equal(snapshot.secondary.windowSeconds, 18000);

	assert.ok(snapshot.modelQuotas);
	assert.equal(snapshot.modelQuotas["Gemini"]?.primary?.usedPercent, 15);
	assert.equal(snapshot.modelQuotas["Gemini"]?.secondary?.usedPercent, 3);
	assert.equal(snapshot.modelQuotas["Claude"]?.primary?.usedPercent, 0);
	assert.equal(snapshot.modelQuotas["Claude"]?.secondary?.usedPercent, 0);
});

test("a window is labelled by its real length, and the provider's verdict beats the percentage", () => {
	// Two ways the footer misled at once. A Codex free plan meters a THIRTY-DAY window, and it was
	// labelled "5h" because that is the slot the field sits in — so a number that resets next month
	// read as one that resets this afternoon. And the account this was shown for was answering
	// `allowed: true`: it could serve work while the footer said `0% left`, which is exactly the
	// reading that convinces someone their working accounts are being ignored.
	const now = Date.now();
	const snapshot = parseCodexUsageBody(
		"openai-codex-account-6",
		{
			plan_type: "free",
			email: "bob@example.com",
			rate_limit: {
				allowed: true,
				limit_reached: false,
				primary_window: {
					used_percent: 100,
					limit_window_seconds: 2592000,
					reset_at: Math.floor(now / 1000) + 27 * 86400,
				},
				secondary_window: null,
			},
		},
		now,
	);
	const footer = formatUsageCompact(snapshot!, now);
	assert.doesNotMatch(
		footer,
		/5h/,
		`a 30-day window must not be labelled 5h; footer: ${footer}`,
	);
	assert.match(
		footer,
		/30d/,
		`it must carry its real length; footer: ${footer}`,
	);
	assert.match(
		footer,
		/ok|usable|✓/i,
		`and an account the provider allows must not read as spent; footer: ${footer}`,
	);
});

test("a blocked account still reads as blocked", () => {
	const now = Date.now();
	const snapshot = parseCodexUsageBody(
		"openai-codex-account-3",
		{
			plan_type: "free",
			rate_limit: {
				allowed: false,
				limit_reached: true,
				primary_window: {
					used_percent: 100,
					limit_window_seconds: 2592000,
					reset_at: Math.floor(now / 1000) + 27 * 86400,
				},
			},
		},
		now,
	);
	assert.match(
		formatUsageCompact(snapshot!, now),
		/spent|blocked|✗/i,
		"the negative verdict must be just as visible",
	);
});
