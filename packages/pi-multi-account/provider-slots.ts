/** Provider registration and OAuth adapters. No failover/session/command entrypoint. */

import { piAiGetModel, requirePiAiOauth, tryLoadPiAiOauth } from "./pi-ai-bridge.ts";
import {
	type AuthEntry,
	refreshWithDiskRetry,
	storedRefreshToken,
	oauthRefreshSignal,
	mergeRefreshedCredentials,
	readAuthFile,
	rejectDuplicateLogin,
} from "./auth-state.ts";
import {
	refreshAntigravityToken,
	loginAntigravity,
	getApiKey as getAntigravityApiKey,
} from "./antigravity/auth/index.js";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ANTHROPIC_BASE, CODEX_BASE, DEFAULT_QWEN_PROVIDER, OLLAMA_BASE } from "./provider-ids.ts";
import { formatSlotDisplayName } from "./account-display.ts";
import { readFileSync } from "node:fs";
import { MODELS_CONFIG_PATH } from "./agent-paths.ts";
import { placeholderKeyFor } from "./slot-proxy.ts";
import { getCurrentAntigravityCatalog } from "./antigravity/models/index.js";
import { DEFAULT_ENDPOINT } from "./antigravity/client/index.js";
import { ANTIGRAVITY_API, streamAntigravity } from "./antigravity/stream/index.js";

const CODEX_MODEL_DEFS: Record<string, Record<string, unknown>> = {
	"gpt-5.3-codex-spark": {
		id: "gpt-5.3-codex-spark",
		name: "GPT-5.3 Codex Spark",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", minimal: "low" },
		input: ["text"],
		cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 128000,
	},
	"gpt-5.4": {
		id: "gpt-5.4",
		name: "GPT-5.4",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", minimal: "low" },
		input: ["text", "image"],
		cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	},
	"gpt-5.4-mini": {
		id: "gpt-5.4-mini",
		name: "GPT-5.4 mini",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", minimal: "low" },
		input: ["text", "image"],
		cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	},
	"gpt-5.5": {
		id: "gpt-5.5",
		name: "GPT-5.5",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", minimal: "low" },
		input: ["text", "image"],
		cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	},
};
// Deliberately NOT listing the 5.6 family (gpt-5.6-sol / -terra / -luna) or anything newer here.
// Those come from the host model registry and the live per-account catalog, which carry their real
// costs, context windows and reasoning levels — and `compareCodexModelStrength` already ranks an
// unknown generation correctly by version and variant. Hard-coding guessed ids would risk offering
// a model a given plan cannot serve, and re-introduce the release-per-generation treadmill.

// Offline last resort ONLY — newest first. Both the live per-account catalog and the host
// model registry outrank this list (see refreshRegistryCodexModels), which is what makes a
// new generation such as gpt-5.6 win with no release here. Deliberately conservative: it must
// never *invent* a model the host has never heard of and OpenAI may not serve for this plan.
export const DEFAULT_CODEX_MODELS = [
	"gpt-5.5",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.3-codex-spark",
];
// Newest first. Offline fallback ordering: the host model registry is consulted too (see
// refreshRegistryAnthropicModels), so a newer flagship wins even before it is listed here.
export const DEFAULT_ANTHROPIC_MODELS = [
	"claude-opus-5",
	"claude-opus-4-8",
	"claude-opus-4-5",
	// claude-sonnet-4-6 contributed by @RuslanAsadov (PR #1).
	"claude-sonnet-4-6",
	"claude-sonnet-4-5",
	"claude-haiku-4-5",
];

export const DEFAULT_OLLAMA_MODELS = ["glm-5.2:cloud"];
export const DEFAULT_QWEN_MODELS = ["qwen3.8-max", "qwen-max", "qwen-plus"];
export const DEFAULT_CURSOR_MODELS = ["cursor-grok-4.6", "grok-4.6", "composer-2.5"];

// ---------------------------------------------------------------------------
// Model definitions for registered alias providers
// ---------------------------------------------------------------------------

export function anthropicModelDef(id: string, providerId: string) {
	const canonical = piAiGetModel("anthropic", id) as any;
	if (canonical) return { ...canonical, provider: providerId };
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: providerId,
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	};
}

export function codexModelDef(id: string) {
	return (
		CODEX_MODEL_DEFS[id] ?? {
			id,
			name: id,
			reasoning: true,
			thinkingLevelMap: { xhigh: "xhigh", minimal: "low" },
			input: ["text", "image"],
			contextWindow: 272000,
			maxTokens: 128000,
		}
	);
}

/**
 * Refresh one Antigravity slot while preserving its Cloud Code Assist project and
 * recovering from a competing Pi process that refreshed the token first.
 */
export async function refreshAntigravityCredentials(
	credentials: AuthEntry,
	providerId?: string,
): Promise<AuthEntry> {
	if (!credentials.refresh)
		throw new Error("No refresh token present for antigravity");
	const refresh = (candidate: AuthEntry) =>
		refreshAntigravityToken(candidate as any) as Promise<AuthEntry>;
	const refreshed = providerId
		? await refreshWithDiskRetry({
				credentials,
				refresh,
				storedRefresh: () => storedRefreshToken(providerId),
			})
		: await refresh(credentials);
	return { ...credentials, ...refreshed };
}

export async function refreshAnthropicCredentials(
	credentials: any,
	signal?: AbortSignal,
	providerId?: string,
) {
	const attempt = (creds: any) =>
		requirePiAiOauth().anthropic.refresh(creds, oauthRefreshSignal(signal));
	// Without a slot id there is nothing on disk to consult, so this degrades to a plain refresh.
	if (!providerId)
		return mergeRefreshedCredentials(credentials, await attempt(credentials));
	const refreshed = await refreshWithDiskRetry({
		credentials,
		refresh: attempt,
		storedRefresh: () => storedRefreshToken(providerId),
	});
	return mergeRefreshedCredentials(credentials, refreshed);
}

/** Bind the refresher to the slot it belongs to, so a lost race can be recovered from disk. */
export function anthropicRefresherFor(providerId: string) {
	return (credentials: any, signal?: AbortSignal) =>
		refreshAnthropicCredentials(credentials, signal, providerId);
}

export function registerAnthropicSlot(
	pi: ExtensionAPI,
	id: string,
	modelIds: string[] = DEFAULT_ANTHROPIC_MODELS,
	displayName?: string,
) {
	if (id === ANTHROPIC_BASE && !displayName) return; // base provider: oauth + shaping registered in piMultiAccount()
	const name =
		displayName ??
		formatSlotDisplayName(id, readAuthFile()[id], "anthropic");
	const models = modelIds.map((m) => anthropicModelDef(m, id));
	pi.registerProvider(id, {
		name,
		baseUrl: "https://api.anthropic.com",
		api: "anthropic-messages" as any,
		oauth: {
			name,
			async login(callbacks: any) {
				return rejectDuplicateLogin(
					id,
					await requirePiAiOauth().anthropic.login(callbacks),
				);
			},
			refreshToken: anthropicRefresherFor(id),
			getApiKey: (credentials: any) => credentials.access,
		},
		models: models as any,
	});
}

export function codexOAuthOverride(providerId: string, name: string) {
	const getProvider = () => requirePiAiOauth().codex;
	return {
		name,
		// Read-only flag: Pi reads it while merely LISTING providers, long before any
		// login. It must never throw — an unresolvable pi-ai here is what used to blow
		// up the whole extension load. `true` mirrors pi-ai's own Codex provider, and an
		// actual login attempt still fails loudly with an actionable message.
		get usesCallbackServer() {
			return tryLoadPiAiOauth()?.codex.usesCallbackServer ?? true;
		},
		async login(callbacks: any) {
			return rejectDuplicateLogin(
				providerId,
				await getProvider().login(callbacks),
			);
		},
		async refreshToken(credentials: any, signal?: AbortSignal) {
			return getProvider().refresh(credentials, oauthRefreshSignal(signal));
		},
		getApiKey(credentials: any) {
			return getProvider().getApiKey(credentials);
		},
	};
}

export function registerCodexSlot(
	pi: ExtensionAPI,
	id: string,
	models: Array<Record<string, unknown>> = DEFAULT_CODEX_MODELS.map(
		codexModelDef,
	),
	displayName?: string,
) {
	if (id === CODEX_BASE && !displayName) return; // base provider is native until live catalog sync enriches it
	registerCodexCatalog(pi, id, models, displayName);
}

function isOwnedCodexChildRoute(baseUrl: unknown, id: string): boolean {
	if (typeof baseUrl !== "string") return false;
	try {
		const url = new URL(baseUrl);
		return url.protocol === "http:" && url.hostname === "127.0.0.1" && !!url.port &&
			url.pathname === `/${id}` && !url.search && !url.hash && !url.username && !url.password;
	} catch {
		return false;
	}
}

/** Codex RPC children gain slot OAuth without replacing a user's custom route/catalog. */
export function registerCodexChildProvider(pi: ExtensionAPI, id: string) {
	let configured: any;
	try {
		configured = JSON.parse(readFileSync(MODELS_CONFIG_PATH, "utf8"))?.providers?.[id];
	} catch {
		// Pi owns reporting malformed model configuration; absent files use defaults.
	}
	const hasRoute = typeof configured?.baseUrl === "string" && configured.baseUrl.trim().length > 0;
	const hasCatalog = Array.isArray(configured?.models) && configured.models.length > 0 &&
		configured.models.every((model: any) => typeof model?.id === "string" && model.id.length > 0);
	if (configured?.apiKey === placeholderKeyFor("codex") && isOwnedCodexChildRoute(configured?.baseUrl, id)) {
		// Our published proxy only admits its placeholder, never a real OAuth token.
		// An OAuth-capable child instead owns its selected slot and goes upstream,
		// avoiding dependence on the parent's loopback proxy lifetime. Retain the
		// published catalog (including custom/live IDs), rewriting only owned URLs.
		const models = hasCatalog ? configured.models.map((model: any) => ({
			...model,
			...(isOwnedCodexChildRoute(model.baseUrl, id) ? { baseUrl: "https://chatgpt.com/backend-api" } : {}),
		})) : undefined;
		registerCodexSlot(pi, id, models, id);
	} else if (hasRoute && (hasCatalog || id === CODEX_BASE)) {
		// Legacy registrations can take precedence over models.json. Register auth
		// only here so a local proxy/catalog is not replaced with upstream defaults.
		pi.registerProvider(id, { oauth: codexOAuthOverride(id, id) });
	} else {
		// Explicit name registers even the base provider without loading parent hooks.
		registerCodexSlot(pi, id, undefined, id);
	}
}

/**
 * Antigravity uses its own Cloud Code Assist transport rather than Pi's native
 * OpenAI/Anthropic transports. Every slot has the same provider definition but
 * its own OAuth credential and project id, which `getApiKey` serializes for the
 * stream at request time.
 *
 * Dynamic model discovery remains intentionally disabled here: the upstream
 * catalog module stores one global routing table, whereas a Google plan can give
 * different Antigravity accounts different catalogs. Static models plus the
 * stream's authenticated runtime lookup avoid leaking one account's entitlement
 * into another slot.
 */
function antigravityOAuthOverride(providerId: string, name: string) {
	return {
		name,
		async login(callbacks: any) {
			return rejectDuplicateLogin(providerId, await loginAntigravity(callbacks));
		},
		refreshToken: (credentials: AuthEntry) =>
			refreshAntigravityCredentials(credentials, providerId),
		getApiKey: (credentials: AuthEntry) => getAntigravityApiKey(credentials as any),
	};
}

function antigravitySlotModels(): Array<Record<string, unknown>> {
	return getCurrentAntigravityCatalog().models.map((model) => ({ ...model }));
}

export function registerAntigravitySlot(
	pi: ExtensionAPI,
	id: string,
	displayName?: string,
) {
	const name =
		displayName ??
		formatSlotDisplayName(id, readAuthFile()[id], "antigravity");
	pi.registerProvider(id, {
		name,
		baseUrl: DEFAULT_ENDPOINT,
		api: ANTIGRAVITY_API,
		oauth: antigravityOAuthOverride(id, name),
		models: antigravitySlotModels() as any,
		streamSimple: streamAntigravity,
	} as any);
}

/** Replace one Codex provider's model list while preserving its OAuth behavior. */
export function registerCodexCatalog(
	pi: ExtensionAPI,
	id: string,
	models: Array<Record<string, unknown>>,
	displayName?: string,
) {
	const name =
		displayName ??
		formatSlotDisplayName(id, readAuthFile()[id], "openai-codex");
	pi.registerProvider(id, {
		name,
		baseUrl: "https://chatgpt.com/backend-api",
		api: "openai-codex-responses" as any,
		oauth: codexOAuthOverride(id, name),
		models: models as any,
	});
}

// ----- Kimi For Coding (subscription, device-flow OAuth) ---------------------

export const KIMI_BASE = "kimi-coding";
export const KIMI_BASE_URL = "https://api.kimi.com/coding";
// Mirrors pi-ai's bundled kimi-coding catalog; piAiGetModel() enriches each entry
// with canonical metadata when the installed pi-ai is new enough to have it.
export const DEFAULT_KIMI_MODELS = [
	"k3",
	"k3-256k",
	"kimi-for-coding",
	"kimi-for-coding-highspeed",
];

export function kimiModelDef(id: string, providerId: string) {
	const canonical = piAiGetModel(KIMI_BASE, id) as any;
	if (canonical) return { ...canonical, provider: providerId };
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: providerId,
		baseUrl: KIMI_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 32768,
	};
}

function kimiOAuthOverride(providerId: string, name: string) {
	// kimi exists only in pi-ai's provider-factories era, so the bridge field is
	// optional — resolve it lazily and fail loudly only on a real login attempt,
	// never while Pi is merely listing providers.
	const getProvider = () => {
		const kimi = requirePiAiOauth().kimi;
		if (!kimi) {
			throw new Error(
				"pi-multi-account: this @earendil-works/pi-ai exposes no Kimi OAuth flow; upgrade pi-ai to log Kimi slots in via subscription.",
			);
		}
		return kimi;
	};
	return {
		name,
		isSubscription: true,
		async login(callbacks: any) {
			return rejectDuplicateLogin(
				providerId,
				await getProvider().login(callbacks),
			);
		},
		async refreshToken(credentials: any, signal?: AbortSignal) {
			return getProvider().refresh(credentials, oauthRefreshSignal(signal));
		},
		getApiKey(credentials: any) {
			return credentials.access;
		},
	};
}

export function registerKimiSlot(
	pi: ExtensionAPI,
	id: string,
	modelIds: string[] = DEFAULT_KIMI_MODELS,
	displayName?: string,
) {
	if (id === KIMI_BASE && !displayName) return; // base provider is native to Pi (pi-ai ships it)
	const name =
		displayName ??
		formatSlotDisplayName(id, readAuthFile()[id], "kimi-coding");
	pi.registerProvider(id, {
		name,
		baseUrl: KIMI_BASE_URL,
		api: "anthropic-messages" as any,
		oauth: kimiOAuthOverride(id, name),
		models: modelIds.map((m) => kimiModelDef(m, id)) as any,
	});
}

// Base URLs and model lists for API-key provider families that support multiple
// accounts (each account = a separate API key in a numbered slot).
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
export const OLLAMA_CLOUD_BASE_URL = "https://ollama.com/v1";

const OLLAMA_MODEL_DEFS: Record<string, Record<string, unknown>> = {
	"glm-5.2:cloud": {
		id: "glm-5.2:cloud",
		name: "GLM-5.2 (Ollama Cloud)",
		contextWindow: 1000000,
		maxTokens: 32768,
		input: ["text"],
		cost: ZERO_COST,
		reasoning: true,
	},
};
export function ollamaModelDef(id: string, providerId: string) {
	const def = OLLAMA_MODEL_DEFS[id] ?? {
		id,
		name: id,
		contextWindow: 1000000,
		maxTokens: 32768,
		input: ["text"],
		cost: ZERO_COST,
		reasoning: true,
	};
	return { ...def, provider: providerId, baseUrl: OLLAMA_CLOUD_BASE_URL };
}

// Alibaba Model Studio (Qwen), OpenAI-compatible International endpoint. The old default pointed at
// a `token-plan.*.maas.aliyuncs.com` promo endpoint that ACCEPTS the key on /models but returns
// 401 invalid_api_key on /chat/completions once the token plan lapses — so a perfectly valid Qwen
// key looked "invalid" and the account was wrongly dropped from rotation. Verified with a live
// request: the same key 200s on dashscope-intl for completions.
export const QWEN_BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const QWEN_MODEL_DEFS: Record<string, Record<string, unknown>> = {
	"qwen3.8-max": {
		id: "qwen3.8-max",
		name: "Qwen3.8 Max",
		contextWindow: 1000000,
		maxTokens: 65536,
		input: ["text"],
		cost: ZERO_COST,
		reasoning: true,
		thinkingLevelMap: {
			high: "high",
			low: null,
			medium: null,
			minimal: null,
			xhigh: "max",
		},
	},
	"qwen-max": {
		id: "qwen-max",
		name: "Qwen Max",
		contextWindow: 1000000,
		maxTokens: 8192,
		input: ["text"],
		cost: ZERO_COST,
		reasoning: true,
	},
	"qwen-plus": {
		id: "qwen-plus",
		name: "Qwen Plus",
		contextWindow: 1000000,
		maxTokens: 8192,
		input: ["text"],
		cost: ZERO_COST,
		reasoning: true,
	},
};
export function qwenModelDef(id: string, providerId: string) {
	const def = QWEN_MODEL_DEFS[id] ?? {
		id,
		name: id,
		contextWindow: 1000000,
		maxTokens: 8192,
		input: ["text"],
		cost: ZERO_COST,
		reasoning: true,
	};
	return { ...def, provider: providerId };
}

/**
 * Register an API-key provider slot (ollama-account-2, alibaba-account-3, ...).
 * Unlike OAuth slots, these never log in interactively — the user adds them by
 * placing a key in auth.json (type "api_key", key "sk-..."). Discovery then
 * picks the slot up exactly like a Codex/Anthropic alias.
 *
 * Pi requires every provider that defines models to also supply credentials —
 * either `oauth` or `apiKey`. For API-key slots we read the key from auth.json
 * at registration time and pass it straight through. If the key is missing
 * (slot added via `/multi-account add` but not yet filled), we skip model
 * registration so the slot stays dormant until the user adds a real key.
 */
/**
 * Model tags the HOST already knows for a provider, newest-first as Pi lists them.
 *
 * Anthropic and Codex were taught to learn their model lists from the host registry so a newly
 * released generation works with no release of this extension. Ollama and Qwen never were: their
 * slots carried a hardcoded array, so a user running six Ollama cloud tags could reach exactly the
 * one written down here. This closes that gap without inventing a strength ranking for arbitrary
 * tags — the built-in list still leads, so the known flagship stays the account's representative
 * and nothing is silently downgraded.
 */
export function hostModelIdsFor(ctx: any, baseProvider: string): string[] {
	try {
		const all = ctx?.modelRegistry?.getAll?.() ?? [];
		return all
			.filter(
				(model: any) =>
					model?.provider === baseProvider && typeof model?.id === "string",
			)
			.map((model: any) => model.id);
	} catch {
		return [];
	}
}

export function registerApiKeySlot(
	pi: ExtensionAPI,
	id: string,
	family: "ollama" | "qwen",
	qwenBase: string = DEFAULT_QWEN_PROVIDER,
	ctx?: any,
	displayName?: string,
) {
	// The qwen arm read OLLAMA_BASE too, so the "this IS the base provider" guard could never
	// fire for a qwen slot. Harmless while the value was only compared against; it decides which
	// provider's host models are inherited now, so it has to be the real base.
	const baseId = family === "ollama" ? OLLAMA_BASE : qwenBase;
	if (id === baseId && !displayName) return;
	// Read the key from auth.json. No key → no models → Pi won't complain and
	// the slot simply won't be selectable until the user fills it in.
	const entry = readAuthFile()[id];
	const key =
		entry && typeof entry.key === "string" && entry.key.length > 0
			? entry.key
			: undefined;
	if (!key) return;
	const baseUrl = family === "ollama" ? OLLAMA_CLOUD_BASE_URL : QWEN_BASE_URL;
	const preferred =
		family === "ollama" ? DEFAULT_OLLAMA_MODELS : DEFAULT_QWEN_MODELS;
	// Built-in tags first (the flagship this extension knows), then everything the host has for
	// the base provider — so a tag the user configured, or one the provider shipped after this
	// release, is selectable instead of invisible.
	const ids = [...preferred];
	for (const hostId of hostModelIdsFor(ctx, baseId)) {
		if (!ids.includes(hostId)) ids.push(hostId);
	}
	const models = ids.map((m) =>
		family === "ollama" ? ollamaModelDef(m, id) : qwenModelDef(m, id),
	);
	const name = displayName ?? formatSlotDisplayName(id, entry, family);
	pi.registerProvider(id, {
		name,
		baseUrl,
		api: "openai-completions" as any,
		apiKey: key,
		// No oauth block → no interactive login, no refresh path.
		models: models as any,
	});
	return ids;
}
