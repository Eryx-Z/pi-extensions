export type UsageFamily =
	| "codex"
	| "anthropic"
	| "ollama"
	| "cursor"
	| "qwen"
	| "kimi-coding"
	| "antigravity";

export type UsageWindow = {
	usedPercent: number;
	resetAt: number;
	windowSeconds?: number;
};

export type UsageSnapshot = {
	provider: string;
	family: UsageFamily;
	fetchedAt: number;
	credentialHash?: string;
	plan?: string;
	/** Sanitized partial subscription-query failure; quotas may still be fresh. */
	planWarning?: string;
	/**
	 * Which real account this is — the email the provider reports, when it reports one.
	 *
	 * Slot ids (`openai-codex-account-5`) are positions in a config file, not identities. With
	 * several slots the position says nothing about whose quota is being spent, which is the fact
	 * a person actually needs when deciding where to switch.
	 */
	account?: string;
	/**
	 * The provider's OWN verdict on whether this account can be used right now.
	 *
	 * Everything else in this snapshot is arithmetic we do on quota windows — a forecast about
	 * one window, which cannot see session limits, plan limits or an early reset. This field is
	 * not that: it is the account answering the question directly. `undefined` means the response
	 * stated no verdict, and only then is the forecast the best information available.
	 */
	serviceable?: boolean;
	primary?: UsageWindow;
	secondary?: UsageWindow;
	credits?: {
		hasCredits?: boolean;
		unlimited?: boolean;
		balance?: string;
	};
	/** Number of provider-granted manual rate-limit resets still available. */
	rateLimitResetCredits?: number;
};

export function preserveKnownPlan(snapshot: UsageSnapshot, previous?: UsageSnapshot): UsageSnapshot {
	if (snapshot.family !== "antigravity" || !snapshot.planWarning || snapshot.plan ||
		!snapshot.credentialHash || snapshot.credentialHash !== previous?.credentialHash ||
		snapshot.provider !== previous.provider || snapshot.account !== previous.account ||
		!previous.plan || previous.plan === "subscription") return snapshot;
	return { ...snapshot, plan: previous.plan };
}

export type UsageCredential = {
	type?: string;
	access?: string;
	accountId?: string;
	key?: string;
	expires?: number;
	email?: string;
	projectId?: string;
};

export class UsageFetchError extends Error {
	readonly status?: number;

	constructor(message: string, status?: number) {
		super(message);
		this.name = "UsageFetchError";
		this.status = status;
	}
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

function finiteNumber(value: unknown): number | undefined {
	const number = typeof value === "number" ? value : Number(value);
	return Number.isFinite(number) ? number : undefined;
}

function percent(value: unknown): number | undefined {
	const number = finiteNumber(value);
	return number === undefined ? undefined : Math.min(100, Math.max(0, number));
}

function epochMs(value: unknown): number | undefined {
	if (
		typeof value === "string" &&
		value.trim() &&
		!Number.isFinite(Number(value))
	) {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	const number = finiteNumber(value);
	if (number === undefined || number <= 0) return undefined;
	return number < 10_000_000_000 ? number * 1000 : number;
}

function usageWindow(
	value: unknown,
	fallbackWindowSeconds?: number,
): UsageWindow | undefined {
	const source = record(value);
	const usedPercent = percent(source.used_percent ?? source.utilization);
	const resetAt = epochMs(source.reset_at ?? source.resets_at);
	if (usedPercent === undefined || resetAt === undefined) return undefined;
	const windowSeconds =
		finiteNumber(source.limit_window_seconds) ?? fallbackWindowSeconds;
	return {
		usedPercent,
		resetAt,
		...(windowSeconds !== undefined ? { windowSeconds } : {}),
	};
}

export function usageFamily(provider: string): UsageFamily | undefined {
	if (
		provider === "openai-codex" ||
		/^openai-codex-account-\d+$/.test(provider)
	)
		return "codex";
	if (provider === "anthropic" || /^anthropic-account-\d+$/.test(provider))
		return "anthropic";
	if (provider === "ollama" || /^ollama-account-\d+$/.test(provider))
		return "ollama";
	if (provider === "cursor" || /^cursor-account-\d+$/.test(provider))
		return "cursor";
	if (
		provider === "alibaba" ||
		/^alibaba-account-\d+$/.test(provider) ||
		/^qwen/i.test(provider)
	)
		return "qwen";
	if (provider === "kimi-coding" || /^kimi-coding-account-\d+$/.test(provider))
		return "kimi-coding";
	if (provider === "antigravity" || /^antigravity-account-\d+$/.test(provider))
		return "antigravity";
	return undefined;
}

export function parseCodexUsageBody(
	provider: string,
	body: unknown,
	fetchedAt = Date.now(),
	credentialHash?: string,
): UsageSnapshot | undefined {
	const source = record(body);
	const rateLimit = record(source.rate_limit);
	const primary = usageWindow(rateLimit.primary_window, 5 * 60 * 60);
	const secondary = usageWindow(rateLimit.secondary_window, 7 * 24 * 60 * 60);
	if (!primary && !secondary) return undefined;
	const credits = record(source.credits);
	const resetCreditsValue = source.rate_limit_reset_credits;
	const resetCredits = record(resetCreditsValue);
	const parsedResetCredits =
		finiteNumber(resetCreditsValue) ??
		finiteNumber(
			resetCredits.available_count ??
				resetCredits.available ??
				resetCredits.remaining ??
				resetCredits.balance ??
				resetCredits.count,
		);
	// The live endpoint uses `available_count` for the total shown as "Usage limit resets";
	// `applicable_available_count` can legitimately be zero when all two resets still exist.
	// Treat null as no resets, but leave an unknown object shape unknown rather than claiming zero.
	const rateLimitResetCredits = !Object.hasOwn(
		source,
		"rate_limit_reset_credits",
	)
		? undefined
		: resetCreditsValue === null
			? 0
			: parsedResetCredits === undefined
				? undefined
				: Math.max(0, Math.floor(parsedResetCredits));
	return {
		provider,
		family: "codex",
		fetchedAt,
		credentialHash,
		plan: typeof source.plan_type === "string" ? source.plan_type : undefined,
		account:
			typeof source.email === "string" && source.email.trim()
				? source.email
				: undefined,
		// `limit_reached` is the negative statement and `allowed` the positive one; either alone
		// is enough. Read both so a response that carries only one of them still answers.
		serviceable:
			typeof rateLimit.limit_reached === "boolean"
				? !rateLimit.limit_reached
				: typeof rateLimit.allowed === "boolean"
					? rateLimit.allowed
					: undefined,
		primary,
		secondary,
		credits: {
			hasCredits:
				typeof credits.has_credits === "boolean"
					? credits.has_credits
					: undefined,
			unlimited:
				typeof credits.unlimited === "boolean" ? credits.unlimited : undefined,
			balance:
				typeof credits.balance === "string" ||
				typeof credits.balance === "number"
					? String(credits.balance)
					: undefined,
		},
		rateLimitResetCredits,
	};
}

export function parseAnthropicUsageBody(
	provider: string,
	body: unknown,
	fetchedAt = Date.now(),
	credentialHash?: string,
): UsageSnapshot | undefined {
	const source = record(body);
	const primary = usageWindow(source.five_hour, 5 * 60 * 60);
	const secondary = usageWindow(source.seven_day, 7 * 24 * 60 * 60);
	if (!primary && !secondary) return undefined;
	return {
		provider,
		family: "anthropic",
		fetchedAt,
		credentialHash,
		primary,
		secondary,
	};
}

function headerValue(headers: unknown, name: string): string | undefined {
	const getter = (headers as any)?.get;
	if (typeof getter === "function") {
		const value = getter.call(headers, name);
		return typeof value === "string" ? value : undefined;
	}
	for (const [key, value] of Object.entries(record(headers))) {
		if (key.toLowerCase() === name.toLowerCase() && value !== undefined)
			return String(value);
	}
	return undefined;
}

function headerWindow(
	headers: unknown,
	prefix: "primary" | "secondary",
): UsageWindow | undefined {
	const usedPercent = percent(
		headerValue(headers, `x-codex-${prefix}-used-percent`),
	);
	const resetAt = epochMs(headerValue(headers, `x-codex-${prefix}-reset-at`));
	const windowMinutes = finiteNumber(
		headerValue(headers, `x-codex-${prefix}-window-minutes`),
	);
	if (usedPercent === undefined || resetAt === undefined) return undefined;
	return {
		usedPercent,
		resetAt,
		...(windowMinutes !== undefined
			? { windowSeconds: windowMinutes * 60 }
			: {}),
	};
}

export function parseCodexUsageHeaders(
	provider: string,
	headers: unknown,
	fetchedAt = Date.now(),
	credentialHash?: string,
): UsageSnapshot | undefined {
	const primary = headerWindow(headers, "primary");
	const secondary = headerWindow(headers, "secondary");
	if (!primary && !secondary) return undefined;
	return {
		provider,
		family: "codex",
		fetchedAt,
		credentialHash,
		plan: headerValue(headers, "x-codex-plan-type"),
		primary,
		secondary,
		credits: {
			hasCredits:
				headerValue(headers, "x-codex-credits-has-credits")?.toLowerCase() ===
				"true",
			unlimited:
				headerValue(headers, "x-codex-credits-unlimited")?.toLowerCase() ===
				"true",
			balance: headerValue(headers, "x-codex-credits-balance"),
		},
		rateLimitResetCredits: finiteNumber(
			headerValue(headers, "x-codex-rate-limit-reset-credits"),
		),
	};
}

export function parseOllamaMeBody(
	provider: string,
	body: unknown,
	fetchedAt = Date.now(),
	credentialHash?: string,
): UsageSnapshot {
	const source = record(body);
	const planName =
		typeof source.Plan === "string"
			? source.Plan
			: typeof source.plan === "string"
				? source.plan
				: undefined;
	// Ollama's /api/me exposes NO session/weekly token counters, but it DOES carry the plan tier,
	// the billing-period end (when the monthly allowance renews) and a suspended flag — all worth
	// surfacing. Fold them into the plan string since UsageSnapshot has no dedicated field.
	const nullableTime = (value: unknown): string | undefined => {
		if (!value || typeof value !== "object") return undefined;
		const v = value as { Time?: unknown; Valid?: unknown };
		return v.Valid === true && typeof v.Time === "string" ? v.Time : undefined;
	};
	const planParts: string[] = [];
	if (planName) planParts.push(planName);
	if (nullableTime(source.SuspendedAt)) planParts.push("SUSPENDED");
	const periodEnd = nullableTime(source.SubscriptionPeriodEnd);
	if (periodEnd) {
		const d = new Date(periodEnd);
		if (!Number.isNaN(d.getTime()))
			planParts.push(`renews ${d.toISOString().slice(0, 10)}`);
	}
	const plan = planParts.length > 0 ? planParts.join(" · ") : planName;
	const sessionSource =
		source.session ??
		source.Session ??
		source.session_usage ??
		source.SessionUsage;
	const weeklySource =
		source.weekly ?? source.Weekly ?? source.weekly_usage ?? source.WeeklyUsage;
	const primary = usageWindow(sessionSource, 5 * 60 * 60);
	const secondary = usageWindow(weeklySource, 7 * 24 * 60 * 60);
	return {
		provider,
		family: "ollama",
		fetchedAt,
		credentialHash,
		plan,
		primary,
		secondary,
	};
}

async function fetchOllamaUsageSnapshot(
	provider: string,
	credential: UsageCredential,
	options: {
		fetchImpl?: typeof fetch;
		timeoutMs?: number;
		credentialHash?: string;
	} = {},
): Promise<UsageSnapshot> {
	if (credential.type !== "api_key" || !credential.key) {
		throw new UsageFetchError(`${provider} has no API key`);
	}
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(),
		options.timeoutMs ?? 10_000,
	);
	const fetchImpl = options.fetchImpl ?? fetch;
	const headers = {
		Authorization: `Bearer ${credential.key}`,
		Accept: "application/json",
		"Content-Type": "application/json",
	};
	try {
		let response = await fetchImpl("https://ollama.com/api/me", {
			method: "POST",
			headers,
			body: "{}",
			signal: controller.signal,
		});
		if (!response.ok) {
			response = await fetchImpl("http://127.0.0.1:11434/api/me", {
				method: "POST",
				headers,
				body: "{}",
				signal: controller.signal,
			});
		}
		if (!response.ok) {
			throw new UsageFetchError(
				`${provider} Ollama account check returned HTTP ${response.status}`,
				response.status,
			);
		}
		const body = await response.json();
		return parseOllamaMeBody(
			provider,
			body,
			Date.now(),
			options.credentialHash,
		);
	} catch (error) {
		if (error instanceof UsageFetchError) throw error;
		if ((error as any)?.name === "AbortError") {
			throw new UsageFetchError(`${provider} Ollama usage request timed out`);
		}
		throw new UsageFetchError(
			`${provider} Ollama usage request failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		clearTimeout(timer);
	}
}

function fetchCursorUsageSnapshot(
	provider: string,
	credential: UsageCredential,
	credentialHash?: string,
): UsageSnapshot {
	if (credential.type !== "oauth" || !credential.access) {
		throw new UsageFetchError(`${provider} has no OAuth access token`);
	}
	const now = Date.now();
	// Cursor does not expose a usage/quota API. Only the subscription status is
	// knowable, so report it honestly instead of fabricating a usage percentage
	// from the OAuth token expiry. Token expiry is tracked separately by the
	// invalidation/re-auth system.
	return {
		provider,
		family: "cursor",
		fetchedAt: now,
		credentialHash,
		plan: "subscription",
	};
}

async function fetchAntigravityUsageSnapshot(
	provider: string,
	credential: UsageCredential,
	options: {
		fetchImpl?: typeof fetch;
		timeoutMs?: number;
		credentialHash?: string;
	} = {},
): Promise<UsageSnapshot> {
	if (credential.type !== "oauth" || !credential.access) {
		throw new UsageFetchError(`${provider} has no OAuth access token`);
	}
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeout = options.timeoutMs ?? 10_000;
	const headers = {
		Authorization: `Bearer ${credential.access}`,
		"Content-Type": "application/json",
		"User-Agent": "antigravity/hub/2.8.0",
		"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
		"Client-Metadata": JSON.stringify({
			ideType: "ANTIGRAVITY",
			platform: "PLATFORM_UNSPECIFIED",
			pluginType: "GEMINI",
		}),
	};

	let tierName: string | undefined;
	let projectId: string | undefined = (credential as any).projectId;
	const email: string | undefined = (credential as any).email;
	let endpoint = "https://daily-cloudcode-pa.googleapis.com";
	const candidateEndpoints = [
		"https://daily-cloudcode-pa.googleapis.com",
		"https://cloudcode-pa.googleapis.com",
	];

	// 1. loadCodeAssist for plan tier + project
	const planFailures: string[] = [];
	for (const ep of candidateEndpoints) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeout);
		try {
			const res = await fetchImpl(
				`${ep}/v1internal:loadCodeAssist`,
				{
					method: "POST",
					headers,
					body: JSON.stringify({
						metadata: {
							ideType: "ANTIGRAVITY",
							platform: "PLATFORM_UNSPECIFIED",
							pluginType: "GEMINI",
						},
					}),
					signal: controller.signal,
				},
			);
			if (res.status === 401) {
				throw new UsageFetchError("Antigravity loadCodeAssist: HTTP 401", 401);
			}
			if (res.ok) {
				endpoint = ep;
				const data = (await res.json()) as any;
				tierName = [data.paidTier?.name, data.paidTier?.id,
					data.currentTier?.name, data.currentTier?.id]
					.find((value) => typeof value === "string" && value.trim());
				if (!projectId && typeof data.cloudaicompanionProject === "string") {
					projectId = data.cloudaicompanionProject;
				}
				if (tierName) break;
				planFailures.push(`${new URL(ep).hostname}: missing tier`);
			} else {
				planFailures.push(`${new URL(ep).hostname}: HTTP ${res.status}`);
			}
		} catch (error) {
			if (error instanceof UsageFetchError && error.status === 401) throw error;
			// Do not expose response bodies, tokens, or arbitrary transport error messages.
			planFailures.push(`${new URL(ep).hostname}: ${controller.signal.aborted ? "timeout" : "request/response failed"}`);
		} finally {
			clearTimeout(timer);
		}
	}

	// 2. retrieveUserQuotaSummary or fetchAvailableModels for quota pools
	let primary: UsageWindow | undefined;
	let secondary: UsageWindow | undefined;
	let serviceable: boolean | undefined;

	let geminiRemaining: number | undefined;
	let geminiReset: number | undefined;
	let geminiWindowSeconds = 5 * 3600;
	let claudeRemaining: number | undefined;
	let claudeReset: number | undefined;
	let claudeWindowSeconds = 5 * 3600;

	// 2a. Try retrieveUserQuotaSummary first (returns exact group buckets)
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeout);
		const res = await fetchImpl(
			`${endpoint}/v1internal:retrieveUserQuotaSummary`,
			{
				method: "POST",
				headers,
				body: JSON.stringify(projectId ? { project: projectId } : {}),
				signal: controller.signal,
			},
		);
		clearTimeout(timer);
		if (res.ok) {
			const data = (await res.json()) as any;
			for (const group of data?.groups || []) {
				const name = String(group?.displayName || "").toLowerCase();
				const desc = String(group?.description || "").toLowerCase();
				const isGemini = name.includes("gemini") || desc.includes("gemini");
				const isClaude =
					name.includes("claude") || desc.includes("claude") || name.includes("3p");
				if (!isGemini && !isClaude) continue;

				let best5h: { fraction: number; resetTime?: number } | undefined;
				let bestWeekly: { fraction: number; resetTime?: number } | undefined;

				for (const b of group?.buckets || []) {
					if (typeof b?.remainingFraction !== "number") continue;
					const fraction = Math.max(0, Math.min(1, b.remainingFraction));
					const resetTime = b.resetTime ? Date.parse(b.resetTime) : undefined;
					const is5h =
						b.window === "5h" || (typeof b.bucketId === "string" && b.bucketId.includes("5h"));
					const isWeekly =
						b.window === "weekly" ||
						(typeof b.bucketId === "string" && b.bucketId.includes("weekly"));

					if (is5h) {
						best5h = { fraction, resetTime };
					} else if (isWeekly) {
						bestWeekly = { fraction, resetTime };
					}
				}

				let target = best5h;
				let targetSeconds = 5 * 3600;
				if (bestWeekly && (!target || bestWeekly.fraction < target.fraction)) {
					target = bestWeekly;
					targetSeconds = 7 * 86400;
				}

				if (target) {
					if (isGemini) {
						geminiRemaining = target.fraction;
						geminiReset = target.resetTime;
						geminiWindowSeconds = targetSeconds;
					} else if (isClaude) {
						claudeRemaining = target.fraction;
						claudeReset = target.resetTime;
						claudeWindowSeconds = targetSeconds;
					}
				}
			}
		}
	} catch {
		// retrieveUserQuotaSummary is best-effort
	}

	// 2b. Fall back to fetchAvailableModels if retrieveUserQuotaSummary yielded nothing
	if (geminiRemaining === undefined && claudeRemaining === undefined) {
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeout);
			const res = await fetchImpl(
				`${endpoint}/v1internal:fetchAvailableModels`,
				{
					method: "POST",
					headers,
					body: JSON.stringify(projectId ? { project: projectId } : {}),
					signal: controller.signal,
				},
			);
			clearTimeout(timer);
			if (res.ok) {
				const data = (await res.json()) as any;
				const models =
					data?.models && typeof data.models === "object" ? data.models : {};

				// Find quota info for Gemini pool and Claude pool
				for (const [id, m] of Object.entries<any>(models)) {
					const qi = m?.quotaInfo;
					if (!qi || typeof qi.remainingFraction !== "number") continue;
					const fraction = Math.max(0, Math.min(1, qi.remainingFraction));
					const resetTime = qi.resetTime ? Date.parse(qi.resetTime) : undefined;

					if (id.startsWith("gemini-") || id.startsWith("gemini_")) {
						if (geminiRemaining === undefined || fraction < geminiRemaining) {
							geminiRemaining = fraction;
							geminiReset = resetTime;
						}
					} else if (id.startsWith("claude-") || id.startsWith("claude_")) {
						if (claudeRemaining === undefined || fraction < claudeRemaining) {
							claudeRemaining = fraction;
							claudeReset = resetTime;
						}
					}
				}
			}
		} catch {
			// fetchAvailableModels is best-effort
		}
	}

	if (geminiRemaining !== undefined) {
		primary = {
			usedPercent: Math.round((1 - geminiRemaining) * 100),
			resetAt: geminiReset ?? Date.now() + geminiWindowSeconds * 1000,
			windowSeconds: geminiWindowSeconds,
		};
	}
	if (claudeRemaining !== undefined) {
		secondary = {
			usedPercent: Math.round((1 - claudeRemaining) * 100),
			resetAt: claudeReset ?? Date.now() + claudeWindowSeconds * 1000,
			windowSeconds: claudeWindowSeconds,
		};
	}

	if (geminiRemaining !== undefined || claudeRemaining !== undefined) {
		serviceable = (geminiRemaining ?? 1) > 0 || (claudeRemaining ?? 1) > 0;
	}

	return {
		provider,
		family: "antigravity",
		fetchedAt: Date.now(),
		credentialHash: options.credentialHash,
		plan: tierName,
		planWarning: tierName ? undefined : `Antigravity subscription: ${planFailures.join("; ")}`,
		account: email,
		serviceable,
		primary,
		secondary,
	};
}

export async function fetchUsageSnapshot(
	provider: string,
	credential: UsageCredential,
	options: {
		fetchImpl?: typeof fetch;
		timeoutMs?: number;
		credentialHash?: string;
	} = {},
): Promise<UsageSnapshot> {
	const family = usageFamily(provider);
	if (!family)
		throw new UsageFetchError(`Usage is not supported for ${provider}`);

	if (family === "ollama") {
		return fetchOllamaUsageSnapshot(provider, credential, options);
	}
	if (family === "cursor") {
		return fetchCursorUsageSnapshot(
			provider,
			credential,
			options.credentialHash,
		);
	}
	if (family === "kimi-coding") {
		// Kimi For Coding is a subscription behind an API key, and it publishes no quota endpoint —
		// /usage, /quota, /me, /subscription and the Moonshot balance path all 404 against
		// api.kimi.com/coding. Falling through to the OAuth branch made every probe throw
		// "has no OAuth access token" for a healthy key, blanking the footer and filling the log.
		return {
			provider,
			family: "kimi-coding",
			fetchedAt: Date.now(),
			credentialHash: options.credentialHash,
			plan: "subscription · no usage endpoint",
		};
	}
	if (family === "antigravity") {
		return fetchAntigravityUsageSnapshot(provider, credential, options);
	}
	if (family === "qwen") {
		// Qwen/Alibaba exposes no usage/quota endpoint over its API-key plans, so we
		// report the plan honestly instead of attempting (and failing) an OAuth usage
		// fetch. Keeps `limits` from throwing "not supported".
		return {
			provider,
			family: "qwen",
			fetchedAt: Date.now(),
			credentialHash: options.credentialHash,
			plan: "api-key · no usage endpoint",
		};
	}
	if (credential.type !== "oauth" || !credential.access) {
		throw new UsageFetchError(`${provider} has no OAuth access token`);
	}

	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(),
		options.timeoutMs ?? 10_000,
	);
	const headers: Record<string, string> = {
		Authorization: `Bearer ${credential.access}`,
		Accept: "application/json",
	};
	let url: string;
	if (family === "codex") {
		url = "https://chatgpt.com/backend-api/wham/usage";
		if (credential.accountId)
			headers["ChatGPT-Account-Id"] = credential.accountId;
	} else {
		url = "https://api.anthropic.com/api/oauth/usage";
		headers["anthropic-beta"] = "oauth-2025-04-20";
	}

	try {
		const response = await (options.fetchImpl ?? fetch)(url, {
			method: "GET",
			headers,
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new UsageFetchError(
				`${provider} usage endpoint returned HTTP ${response.status}`,
				response.status,
			);
		}
		const body = await response.json();
		const snapshot =
			family === "codex"
				? parseCodexUsageBody(
						provider,
						body,
						Date.now(),
						options.credentialHash,
					)
				: parseAnthropicUsageBody(
						provider,
						body,
						Date.now(),
						options.credentialHash,
					);
		if (!snapshot)
			throw new UsageFetchError(
				`${provider} usage endpoint returned no 5h/7d windows`,
			);
		return snapshot;
	} catch (error) {
		if (error instanceof UsageFetchError) throw error;
		if ((error as any)?.name === "AbortError")
			throw new UsageFetchError(`${provider} usage request timed out`);
		throw new UsageFetchError(
			`${provider} usage request failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		clearTimeout(timer);
	}
}

export function providerUsageLabel(provider: string): string {
	const index = provider.match(/-account-(\d+)$/)?.[1];
	if (provider.startsWith("openai-codex"))
		return index ? `Codex A${index}` : "Codex";
	if (provider.startsWith("anthropic"))
		return index ? `Claude A${index}` : "Claude";
	if (provider.startsWith("ollama"))
		return index ? `Ollama A${index}` : "Ollama";
	if (provider.startsWith("cursor"))
		return index ? `Cursor A${index}` : "Cursor";
	if (provider.startsWith("kimi-coding"))
		return index ? `Kimi A${index}` : "Kimi";
	if (provider.startsWith("antigravity"))
		return index ? `Antigravity A${index}` : "Antigravity";
	if (provider.startsWith("alibaba") || /^qwen/i.test(provider))
		return index ? `Qwen A${index}` : "Qwen/Alibaba";
	return provider;
}

export function remainingPercent(window: UsageWindow): number {
	return Math.max(0, Math.round(100 - window.usedPercent));
}

export function formatResetDuration(resetAt: number, now = Date.now()): string {
	const minutes = Math.max(0, Math.ceil((resetAt - now) / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const restMinutes = minutes % 60;
	if (hours < 24) return restMinutes ? `${hours}h${restMinutes}m` : `${hours}h`;
	const days = Math.floor(hours / 24);
	const restHours = hours % 24;
	return restHours ? `${days}d${restHours}h` : `${days}d`;
}

/** Keep an email readable in a one-line footer without letting it dominate the line. */
export function shortAccount(account: string | undefined): string | undefined {
	if (!account) return undefined;
	const local = account.includes("@")
		? account.slice(0, account.indexOf("@"))
		: account;
	return local.length > 18 ? `${local.slice(0, 17)}…` : local;
}

/**
 * Name a quota window by how long it actually is.
 *
 * The label used to be positional — whatever sat in the "primary" slot was called `5h` — but a
 * Codex free plan meters a THIRTY-DAY window there. A number that resets next month then read as
 * one resetting this afternoon, which is a materially different decision about whether to wait.
 */
export function windowLabel(
	window: UsageWindow,
	family: UsageFamily,
	position: "primary" | "secondary",
): string {
	if (family === "cursor") return position === "primary" ? "auth" : "7d";
	if (family === "ollama") return position === "primary" ? "cloud" : "weekly";
	if (family === "antigravity")
		return position === "primary" ? "gemini" : "claude";
	const seconds = window.windowSeconds;
	if (!seconds) return position === "primary" ? "5h" : "7d";
	if (seconds >= 20 * 86_400) return "30d";
	if (seconds >= 6 * 86_400) return "7d";
	if (seconds >= 20 * 3_600) return "24h";
	return `${Math.max(1, Math.round(seconds / 3_600))}h`;
}

export function formatUsageCompact(
	snapshot: UsageSnapshot,
	now = Date.now(),
): string {
	const who = shortAccount(snapshot.account);
	const parts = [
		who
			? `${providerUsageLabel(snapshot.provider)} · ${who}`
			: providerUsageLabel(snapshot.provider),
	];
	// The plan is what decides how much quota those percentages are a percentage OF — a free slot
	// at 60% left and a Plus slot at 60% left are not comparable amounts of work.
	if (snapshot.plan && (snapshot.primary || snapshot.secondary))
		parts.push(snapshot.plan);
	// The account's own answer, when it gave one. A percentage is arithmetic on one window and can
	// disagree with reality in both directions — an account reading 0% left was answering
	// `allowed: true`, and showing only the 0% is what makes a working account look dead.
	if (snapshot.serviceable === true) parts.push("ok");
	else if (snapshot.serviceable === false) parts.push("spent");
	if (snapshot.primary) {
		parts.push(
			`${windowLabel(snapshot.primary, snapshot.family, "primary")} ${remainingPercent(snapshot.primary)}% left/${formatResetDuration(snapshot.primary.resetAt, now)}`,
		);
	}
	if (snapshot.secondary) {
		parts.push(
			`${windowLabel(snapshot.secondary, snapshot.family, "secondary")} ${remainingPercent(snapshot.secondary)}% left/${formatResetDuration(snapshot.secondary.resetAt, now)}`,
		);
	}
	if (!snapshot.primary && !snapshot.secondary && snapshot.plan) {
		if (snapshot.family === "ollama") {
			parts.push(`${snapshot.plan} · no session/weekly API`);
		} else {
			parts.push(snapshot.plan);
		}
	}
	return parts.join(" | ");
}

export function formatUsageStatus(
	snapshot: UsageSnapshot,
	now = Date.now(),
): string {
	const who = shortAccount(snapshot.account);
	const parts = [
		`${providerUsageLabel(snapshot.provider)}${who ? ` ${who}` : ""}`,
	];
	if (snapshot.serviceable === false) parts.push("spent");
	if (snapshot.primary)
		parts.push(
			`${windowLabel(snapshot.primary, snapshot.family, "primary")} ${remainingPercent(snapshot.primary)}%/${formatResetDuration(snapshot.primary.resetAt, now)}`,
		);
	if (snapshot.secondary)
		parts.push(
			`${windowLabel(snapshot.secondary, snapshot.family, "secondary")} ${remainingPercent(snapshot.secondary)}%/${formatResetDuration(snapshot.secondary.resetAt, now)}`,
		);
	if (snapshot.rateLimitResetCredits !== undefined)
		parts.push(`reset ${snapshot.rateLimitResetCredits}`);
	if (!snapshot.primary && !snapshot.secondary && snapshot.plan)
		parts.push(snapshot.plan);
	return parts.join(" · ");
}

export function formatUsageDetails(
	snapshot: UsageSnapshot,
	now = Date.now(),
): string {
	const lines = [
		`Limits for ${providerUsageLabel(snapshot.provider)}${snapshot.account ? ` — ${snapshot.account}` : ""}${snapshot.plan ? ` (${snapshot.plan})` : ""}`,
	];
	if (snapshot.serviceable !== undefined)
		lines.push(
			snapshot.serviceable
				? "The account reports it can be used right now."
				: "The account reports it is currently blocked, whatever the percentages below say.",
		);
	if (!snapshot.primary && !snapshot.secondary && snapshot.plan) {
		if (snapshot.family === "ollama") {
			lines.push(
				`Plan: ${snapshot.plan}. Session/weekly limits are not exposed via Ollama's API yet — check https://ollama.com/settings`,
			);
		} else {
			lines.push(`Status: ${snapshot.plan}`);
		}
	}
	for (const [position, window] of [
		["primary", snapshot.primary],
		["secondary", snapshot.secondary],
	] as const) {
		if (!window) continue;
		const label =
			snapshot.family === "ollama" && position === "primary"
				? "session"
				: windowLabel(window, snapshot.family, position);
		lines.push(
			`${label}: ${remainingPercent(window)}% left (${Math.round(window.usedPercent)}% used), resets in ${formatResetDuration(window.resetAt, now)} at ${new Date(window.resetAt).toLocaleString()}`,
		);
	}
	if (snapshot.credits?.unlimited) lines.push("Credits: unlimited");
	else if (snapshot.credits?.balance !== undefined)
		lines.push(`Credits: ${snapshot.credits.balance}`);
	if (snapshot.rateLimitResetCredits !== undefined)
		lines.push(
			`Available rate-limit resets: ${snapshot.rateLimitResetCredits}`,
		);
	lines.push(`Updated ${formatResetDuration(now, snapshot.fetchedAt)} ago`);
	return lines.join("\n");
}

export function usageColor(
	snapshot: UsageSnapshot,
): "success" | "warning" | "error" {
	const remaining = [snapshot.primary, snapshot.secondary]
		.filter((window): window is UsageWindow => !!window)
		.map(remainingPercent);
	const lowest = remaining.length > 0 ? Math.min(...remaining) : 100;
	if (lowest <= 10) return "error";
	if (lowest <= 30) return "warning";
	return "success";
}
