/**
 * pi-multi-account — automatic multi-account failover & rotation for Pi.
 *
 * What it does
 * ------------
 * - Auto-discovers every authenticated account from ~/.pi/agent/auth.json
 *   (Anthropic Claude Pro/Max, OpenAI/ChatGPT Codex, Google Antigravity,
 *   Kimi For Coding, Cursor, Qwen/Alibaba, and Ollama) and
 *   builds the failover rotation dynamically — no manual config editing.
 * - Pre-registers a pool of login slots so `/login` can offer numbered account
 *   targets such as `anthropic-account-3` and `openai-codex-account-5`.
 * - Drops an account from the rotation the moment its token is expired or its
 *   authorization is revoked, and restores it automatically once you re-login.
 * - On a quota/rate-limit (429/402/403) it marks the account on cooldown and
 *   transparently switches to the next available account/model, optionally
 *   queuing a safe continuation prompt.
 *
 * Anthropic OAuth (Claude Pro/Max) and Google Antigravity work out of the box:
 * this package owns Antigravity's Google OAuth and Cloud Code Assist stream for
 * the base provider plus each numbered alias (without image generation).
 * It also enables
 * OAuth login on the base `anthropic` provider and on every `anthropic-account-*`
 * alias, and shapes the outgoing requests itself (billing header + system-prompt
 * normalization, vendored from gotgenes/pi-anthropic-auth, MIT). No separate
 * pi-anthropic-auth install is needed; if you have one, both coexist (idempotent).
 *
 * Config:  ~/.pi/agent/provider-failover.json
 * State:   ~/.pi/agent/provider-failover-state.json
 */

import {
	readFileSync,
	existsSync,
	writeFileSync,
	renameSync,
	statSync,
	mkdirSync,
	appendFileSync,
} from "node:fs";
import { MODELS_CONFIG_PATH, AUTH_PATH, AGENT_DIR, CONFIG_PATH } from "./agent-paths.ts";
import {
	type ShapeVerdict,
	describeContractDrift,
	observedAssumptions,
} from "./pi-contract.ts";
import { defaultRouteWarning } from "./child-usability.ts";
import {
	shapeAnthropicOAuthPayload,
	rewriteDeveloperRoleToSystem,
} from "./request-shaping.ts";
import { join, dirname } from "node:path";
import {
	type UsageSnapshot,
	usageFamily,
	formatUsageStatus,
	usageColor,
	preserveKnownPlan,
	UsageFetchError,
	fetchUsageSnapshot,
	formatUsageDetails,
	remainingPercent,
	formatResetDuration,
	windowLabel,
	formatUsageCompact,
	providerUsageLabel,
	parseCodexUsageHeaders,
} from "./usage.ts";
import {
	rejectDuplicateLogin,
	type AuthEntry,
	credentialHash,
	readAuthFile,
	canPersistRefreshedCredentials,
	mergeRefreshedCredentials,
	persistRefreshedCredentials,
	isEntryUsable,
	accountIdentity,
	authMtimeMs,
	stableAccountFingerprint,
	jwtExpMs,
} from "./auth-state.ts";
import { requirePiAiOauth, piAiOauthUnavailableReason } from "./pi-ai-bridge.ts";
import {
	anthropicRefresherFor,
	refreshAnthropicCredentials,
	refreshAntigravityCredentials,
	DEFAULT_ANTHROPIC_MODELS,
	registerAnthropicSlot,
	DEFAULT_CODEX_MODELS,
	codexModelDef,
	registerCodexCatalog,
	DEFAULT_OLLAMA_MODELS,
	ollamaModelDef,
	OLLAMA_CLOUD_BASE_URL,
	hostModelIdsFor,
	codexOAuthOverride,
	registerAntigravitySlot,
	registerCodexSlot,
	DEFAULT_KIMI_MODELS,
	KIMI_BASE,
	registerKimiSlot,
	KIMI_BASE_URL,
	kimiModelDef,
	registerApiKeySlot,
	DEFAULT_QWEN_MODELS,
	DEFAULT_CURSOR_MODELS,
	QWEN_BASE_URL,
	qwenModelDef,
	anthropicModelDef,
} from "./provider-slots.ts";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { registerGrokProvider } from "./grok/register.ts";
import { registerFastCommand } from "./fast-command.ts";
import {
	loadConfig,
	type ReasoningLevel,
	REASONING_LEVELS,
	DEFAULT_PROVIDER_ORDER,
	DEFAULT_IGNORE_PATTERNS,
} from "./failover-config.ts";
import {
	loadState,
	type InvalidationRecord,
	type SwitchRecord,
	type ProviderFailoverState,
	STATE_VERSION,
	saveState,
} from "./failover-state.ts";
import {
	sameModelIdentity,
	type ModelRef,
	ref,
	classifyProvider,
	CODEX_BASE,
	ANTHROPIC_BASE,
	OLLAMA_BASE,
	type ProviderFamily,
	slotIndex,
	isCursorProviderId,
	CURSOR_BASE,
	slotId,
	parseTarget,
	accountGroup,
	parseFamilyArg,
	resolveRemoveTarget,
} from "./provider-ids.ts";
import {
	type CodexCatalogSnapshot,
	type CodexCatalogModel,
	compareCodexModelStrength,
	rankAnthropicModelIds,
	CodexCatalogFetchError,
	fetchCodexModelCatalog,
	fetchOllamaCloudCatalog,
} from "./model-catalog.ts";
import {
	refreshCursorCredentials,
	isCursorProviderInstalled,
	setupCursorSubscription,
	CURSOR_PROXY_PLACEHOLDER_KEY,
} from "./cursor-bridge.ts";
import { formatSlotDisplayName } from "./account-display.ts";
import {
	comparePriority,
	normalizeGroup,
	describePriority,
	DEFAULT_PROVIDER_PRIORITY,
	normalizePriority,
} from "./provider-priority.ts";
import { handleGrokFast } from "./grok/fast.ts";
import {
	writeCodexFastEnabled,
	readCodexFastEnabled,
	isCodexFastModel,
	shapeCodexFastPayload,
} from "./codex-fast.ts";
import { preserveInterruptedTurns } from "./interrupted-turns.ts";
import { cooldownFromHeaders, cooldownFromErrorText, cooldownMsFromUsage } from "./cooldown.ts";
import {
	configuredModelIds,
	readHostDefaultModel,
	inspectPiContract,
	slotsAsAChildSeesThem,
	unprovisionNativeSlot,
	provisionNativeSlot,
} from "./pi-files.ts";
import { type Server, createServer } from "node:http";
import {
	type ProxyRoute,
	type ProxyFamily,
	admitRequest,
	shapeUpstreamRequest,
	publishedRouteFor,
	placeholderKeyFor,
} from "./slot-proxy.ts";
import { Readable } from "node:stream";

// Preserve the existing entry-point exports while keeping ownership in focused modules.
export { piAiRootCandidates } from "./pi-ai-bridge.ts";
export {
	canPersistRefreshedCredentials,
	persistRefreshedCredentials,
	mergeRefreshedCredentials,
	refreshWithDiskRetry,
} from "./auth-state.ts";
export { modelIdentityKey, sameModelIdentity } from "./provider-ids.ts";
export {
	formatAccountIdentifier,
	maskAccount,
	familyDisplayLabel,
	slotAccountDetails,
	formatSlotDisplayName,
} from "./account-display.ts";
export { registerCodexChildProvider, registerAntigravitySlot } from "./provider-slots.ts";
export { renderHandoffRecord, preserveInterruptedTurns } from "./interrupted-turns.ts";

// "Black box" flight recorder: a structured, append-only log of every decision the
// extension makes (switches, errors, watchdog actions, breaker trips).
// When something misbehaves, this file is the exact reproduction trail —
// no guessing from screenshots. It NEVER contains tokens/credentials (only provider
// ids, model ids, truncated reasons). Bounded size with one rotation so it can never
// fill the disk.
const DEBUG_LOG_PATH = join(AGENT_DIR, "provider-failover-debug.log");
const DEBUG_LOG_MAX_BYTES = 4 * 1024 * 1024; // rotate to .log.1 past this
const CODEX_MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;
const OLLAMA_MODEL_CATALOG_TTL_MS = 30 * 60 * 1000;
const MIN_ANTHROPIC_USAGE_REFRESH_MS = 10 * 60 * 1000;
// v1.13.7 — Hard ceiling on any LIVE-parsed cooldown. Codex/usage error bodies can report the
// reset of a long ROLLING window (weekly/monthly) as `resets_at`, which — taken literally — evicts
// an account from rotation for weeks even though its short (primary) window has already freed. Any
// single estimate is capped here so a mis-parsed or long-window reset can never lock a live account
// for more than this; the account is re-probed at the cap and cooldownMsFromUsage self-corrects the
// moment the primary window has headroom. Cooling-down accounts are otherwise never probed, so
// without this cap the far-future estimate is a dead end (the "bogus cooldown" bug, open since v1.13.1).
const MAX_LIVE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const MIN_PENDING_WAKE_MS = 1000;
// The usage-% endpoint tracks an account's QUOTA window; it does NOT reflect session/rate limits.
// So a session-limited account keeps 429ing "usage limit reached" while usage still reports
// headroom. Trusting usage as ground truth then reports the account "free now", schedules a ~1s
// retry, gets 429 again, and loops. Once a provider limit-errors TWICE within this window (no
// success in between), the usage reading is proven a liar for this account and is distrusted.
const LIMIT_STREAK_WINDOW_MS = 15 * 60 * 1000;
// How long to ignore "usage says free" for a provider after usage has been proven wrong, so the
// recorded cooldown from the real error sticks instead of being cleared on the next poll.
const USAGE_UNTRUSTED_MS = 30 * 60 * 1000;
// Minimum backoff to record for a session/rate limit the usage window cannot see, so the wake
// timer polls (every PENDING_POLL_MS) instead of hot-retrying a maxed account every second.
const SESSION_LIMIT_FLOOR_MS = 5 * 60 * 1000;
const AUTH_CHANGE_POLL_MS = 5000;
const MAX_QUEUED_USER_INPUTS = 20;
// Runaway-loop guards (added). Without these, when every account is rate-limited the
// failover bounces between accounts every 1-9s forever, growing the session history
// until the machine swaps itself to death.
const ANTI_PINGPONG_MS = 60 * 1000; // don't switch straight back to the account we just left
// A 401 on an OAuth account usually just means "access token expired, refresh it" — Pi refreshes
// on the next call. So a single 401 must NOT permanently kill a refreshable account (that was the
// "it dropped me off an account that still had tokens" bug). Only kill it after this many 401s in a
// row with no successful response in between. Non-refreshable (API-key) 401 is fatal immediately.
// Bumped on every release. Printed at startup and in `/multi-account status` so you can verify
// which version Pi actually loaded (a running Pi keeps the version it started with — /login and
// /reload do NOT reload extension code; only a full restart does).
const VERSION = "1.20.0";
const MODEL_CATALOG_REQUEST_EVENT = "pi:model-catalog:request:v1";
const MODEL_CATALOG_SNAPSHOT_EVENT = "pi:model-catalog:snapshot:v1";
const TRANSIENT_PENDING_PREFIX = "temporary provider failure:";
// Pending reason for a turn that was NOT a model/account failure — the prior turn simply had
// not gone idle in time, so we re-arm to resume the SAME model. This must never be treated as
// a failure of the current model (doing so would downgrade it to an older sibling on the same
// account, which shares the same quota pool and gains nothing).
const BUSY_RETRY_REASON = "previous turn was still busy; auto-retry";
// Raised from 3 → 8. A single transient 401 burst from OpenAI Codex (one physical event
// that Pi surfaces as 3 error hooks: response/message/agent) hit the old threshold instantly
// and permanently killed a live account. The threshold now tolerates a retry burst plus a
// few genuinely distinct failures. Dedup in markAuthFailure (same-hash repeats do not count)
// is the other half of this fix.
const MAX_CONSECUTIVE_AUTH_FAILURES = 8;
const TRANSIENT_AUTH_COOLDOWN_MS = 60 * 1000; // brief skip after a 401 so the next call can refresh

// For non-refreshable (API-key) providers, repeated 401s with the SAME key are not a
// transient blip — the key is permanently invalid. After this many consecutive same-key
// failures, invalidate the account so the user is told to re-login instead of looping
// on a 1-minute cooldown forever.
const MAX_SAME_KEY_AUTH_FAILURES = 3;
const STUCK_REMINDER_MS = 120 * 1000; // re-surface the stuck notice this often while it stays stuck
// --- Circuit breaker (v1.13.0) ---------------------------------------------
// The reliability FLOOR. If automatic recovery keeps failing (resume wedges, switch
// makes no progress) the extension stops trying to be clever and drops to "advisory
// mode": it still flags rate limits and tells you which account to switch to, but it
// no longer attempts the auto-continue that was hanging. Guarantee: the extension can
// never make the experience WORSE than switching accounts by hand. Closes again on any
// real forward progress, a new user prompt, /multi-account reset, or after a cooldown.
const BREAKER_FAILURE_THRESHOLD = 3; // consecutive failed recoveries before tripping
const BREAKER_COOLDOWN_MS = 10 * 60 * 1000; // how long advisory mode lasts once tripped

// These are explicit provider verdicts that reusing or refreshing the current credential cannot
// repair. Unlike a generic 401, they should remove the account from rotation immediately.
const TERMINAL_AUTH_ERROR_PATTERNS = [
	"authentication token has been invalidated",
	"token has been invalidated",
	"invalid_grant",
	"revoked",
	"invalid api key",
	"invalid api-key",
	"incorrect api key",
	"incorrect api-key",
	"api-key provided",
	"apikey-error",
];

const FORCE_REFRESH_AUTH_ERROR_PATTERNS = [
	"authentication token has been invalidated",
	"token has been invalidated",
];

// These are explicit refresh-endpoint verdicts that re-login cannot wait out.
// IMPORTANT: "refresh_token_invalidated" and "session has ended" were REMOVED from this list in
// v1.9.0 — OpenAI Codex returns them transiently under load even when the account is alive
// (a parallel Pi session can refresh the same token moments later). They are now treated as
// transient: the account gets a short cooldown and the next attempt can still refresh.
const TERMINAL_REFRESH_ERROR_PATTERNS = ["invalid_grant", "revoked"];

// ---------------------------------------------------------------------------
// "Black box" decision log — structured, append-only, credential-free, bounded.
// ---------------------------------------------------------------------------

// Set from the extension closure once config is known. Module-level so the writer
// (a plain function) can be called from anywhere without threading config through.
let debugLogEnabled = false;
const DEBUG_TOKENISH =
	/(sk-[\w-]{8,}|ey[A-Za-z0-9._-]{12,}|Bearer\s+\S+|[A-Za-z0-9_-]{40,})/g;

// Redact anything that smells like a token/JWT/api key so the log is always safe to
// share. We never deliberately log credentials, but error strings from providers can
// occasionally embed one; this is the belt-and-braces guarantee.
function redactForLog(text: string): string {
	return text.replace(DEBUG_TOKENISH, "«redacted»");
}

function rotateDebugLogIfNeeded() {
	try {
		const size = statSync(DEBUG_LOG_PATH).size;
		if (size >= DEBUG_LOG_MAX_BYTES) {
			renameSync(DEBUG_LOG_PATH, `${DEBUG_LOG_PATH}.1`); // keep exactly one previous file
		}
	} catch {
		/* no file yet, or rotation failed — non-fatal */
	}
}

// Append one structured event. Best-effort and utterly silent on failure: logging must
// NEVER affect failover behaviour or crash the host. `data` should already be free of
// secrets; string fields are still redacted defensively.
function logEvent(kind: string, data: Record<string, unknown> = {}) {
	if (!debugLogEnabled) return;
	try {
		const safe: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(data)) {
			safe[k] = typeof v === "string" ? redactForLog(v).slice(0, 300) : v;
		}
		const line = `${JSON.stringify({ t: new Date().toISOString(), kind, ...safe })}\n`;
		rotateDebugLogIfNeeded();
		mkdirSync(dirname(DEBUG_LOG_PATH), { recursive: true, mode: 0o700 });
		appendFileSync(DEBUG_LOG_PATH, line, { encoding: "utf8", mode: 0o600 });
	} catch {
		/* diagnostics are best-effort; never throw */
	}
}

function readDebugLogTail(maxLines: number): string {
	try {
		const raw = readFileSync(DEBUG_LOG_PATH, "utf8");
		const lines = raw.split("\n").filter((l) => l.trim().length > 0);
		return lines.slice(-maxLines).join("\n");
	} catch {
		return "";
	}
}

// ---------------------------------------------------------------------------
// Misc helpers (cooldown parsing from headers / error bodies)
// ---------------------------------------------------------------------------

function patternMatch(text: string, patterns: string[]) {
	const lower = text.toLowerCase();
	return patterns.some((p) => p && lower.includes(p.toLowerCase()));
}

function formatUntil(timestamp: number) {
	const ms = timestamp - Date.now();
	if (ms <= 0) return "expired";
	const minutes = Math.ceil(ms / 60000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/** Human-readable wait duration: "45s", "12m", "2h 20m" — never the misleading hours-only ceil. */
function formatDelay(ms: number): string {
	if (ms < 60_000) return `${Math.ceil(ms / 1000)}s`;
	const totalMinutes = Math.ceil(ms / 60_000);
	if (totalMinutes < 60) return `${totalMinutes}m`;
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

/** stopReason of the most recent assistant message — "aborted" means the user pressed Esc. */
function lastAssistantStopReason(messages: any[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "assistant")
			return messages[i]?.stopReason as string | undefined;
	}
	return undefined;
}

/** OAuth override enabling Claude Pro/Max login on a provider (base or alias). */
function anthropicOAuthOverride(providerId: string, name: string) {
	return {
		name,
		usesCallbackServer: true,
		async login(callbacks: any) {
			return rejectDuplicateLogin(
				providerId,
				await requirePiAiOauth().anthropic.login(callbacks),
			);
		},
		refreshToken: anthropicRefresherFor(providerId),
		getApiKey: (credentials: any) => credentials.access,
	};
}

// ===========================================================================
// Extension entry point
// ===========================================================================

export default function piMultiAccount(pi: ExtensionAPI) {
	// Advertise a provider-only child entrypoint, not this extension's account
	// rotation, session hooks, commands or model-selection behavior.
	pi.events.on("rpc-subagents:provider-source:v1", (data: unknown) => {
		const request = data as { provider?: string; register?: (path: string) => void };
		if (!request || typeof request.provider !== "string" || typeof request.register !== "function") return;
		if (/^(?:antigravity|openai-codex)(?:-account-\d+)?$/.test(request.provider)) {
			request.register(fileURLToPath(new URL("./subagent-provider.ts", import.meta.url)));
		} else if (request.provider === "grok-cli") {
			// grok-4.7-build-fast is a Grok CLI catalog model, not a Codex service tier.
			request.register(fileURLToPath(new URL("./grok-cli-provider.ts", import.meta.url)));
		}
	});
	registerGrokProvider(pi);
	registerFastCommand(pi);
	// Warm up the OAuth helpers before any provider registration: providers are
	// registered synchronously below and their `usesCallbackServer`/`getApiKey`
	// read from the cached module. Deliberately NON-fatal — if pi-ai's oauth entry
	// cannot be resolved (hoisted npm layout, incompatible pi-ai), the extension
	// still loads and every non-OAuth account keeps working; only subscription
	// logins are unavailable, and the user is told once at session start.
	const oauthUnavailable = piAiOauthUnavailableReason();
	let config = loadConfig();
	debugLogEnabled = config.debugLog;
	let configuredFallbacks = config.fallbacks.slice();
	let persistedState = loadState();
	let lastModelByFamily: Record<string, string> = {
		...(persistedState.lastModelByFamily ?? {}),
	};
	/** Settles once Cursor fallback models are registered. Pi awaits the factory return, so createAgentSession can getModel(cursor, grok-4.6) instead of falling back. */
	let cursorReady: Promise<unknown> | undefined;
	let modelCatalogContext: any;

	// ----- only-active model filter -------------------------------------------
	// When enabled, /model drops this extension's OTHER rotation slots: each is
	// re-registered with `models: []` (Pi merges re-registrations, so auth/OAuth
	// config survives) and restored from here on switch or disable.
	//
	// It may only ever narrow slots THIS extension invented. Pi's registry is the
	// single place anything — Pi itself, another extension, a `--models` pattern —
	// asks "does this model exist?", and re-registering a provider with no models
	// answers "no" to every one of them. Emptying a provider Pi knows on its own
	// (a built-in, a models.json entry, another extension's registration) therefore
	// does not hide a model, it DELETES it: a pinned `zai/glm-5.1` stops resolving,
	// and a caller that falls back to "just use the session model" silently starts
	// running on whichever account rotation happens to be on. That is invisible from
	// here and undebuggable from there. Slots we invented are ours to narrow —
	// nothing else in Pi knows the name `openai-codex-account-3` — and every model
	// Pi knows independently stays resolvable by reference while the filter is on.
	let onlyActiveModels = config.onlyActive;
	/** Models of the providers WE hid, freshest copy — the only way back. */
	const hiddenProviderModels = new Map<string, any[]>();

	/**
	 * A provider that exists ONLY because this extension registered it. Pi has no
	 * built-in and no models.json entry under a `-account-N` name unless we made it,
	 * so narrowing these takes nothing away from anyone else.
	 */
	function isOwnRotationSlot(provider: string): boolean {
		return /-account-\d+$/.test(provider);
	}

	function unhideProvider(provider: string) {
		const models = hiddenProviderModels.get(provider);
		if (!models) return;
		try {
			pi.registerProvider(provider, { models } as any);
			hiddenProviderModels.delete(provider);
		} catch (error) {
			logEvent("only_active_restore_failed", {
				provider,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}

	function clearOnlyActiveFilter() {
		for (const provider of [...hiddenProviderModels.keys()])
			unhideProvider(provider);
	}

	/**
	 * Narrow /model to the active account. Idempotent and cheap: a provider we already
	 * hid shows zero models in the registry, so there is nothing to re-hide, and a
	 * provider that re-registered itself (catalog sync) is re-hidden with the FRESH
	 * model list stored for restore. Never touches the active provider's registration
	 * beyond restoring what we previously hid.
	 */
	function applyOnlyActiveFilter(ctx: any, activeProvider?: string) {
		if (!onlyActiveModels) return;
		const active = activeProvider ?? ctx?.model?.provider;
		if (!active) return;
		let all: any[] = [];
		try {
			all = ctx?.modelRegistry?.getAll?.() ?? [];
		} catch {
			return;
		}
		const visibleByProvider = new Map<string, any[]>();
		for (const model of all) {
			if (!model?.provider || typeof model.id !== "string") continue;
			const list = visibleByProvider.get(model.provider);
			if (list) list.push(model);
			else visibleByProvider.set(model.provider, [model]);
		}
		for (const [provider, models] of visibleByProvider) {
			if (provider === active) {
				unhideProvider(provider);
				continue;
			}
			// Not ours to remove: emptying it would unregister models Pi knows on its
			// own, and every caller resolving one by reference would stop finding it.
			if (!isOwnRotationSlot(provider)) continue;
			if (!models.length) continue; // already hidden (or genuinely empty)
			hiddenProviderModels.set(provider, models);
			try {
				pi.registerProvider(provider, { models: [] } as any);
			} catch (error) {
				hiddenProviderModels.delete(provider);
				logEvent("only_active_hide_failed", {
					provider,
					reason: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	/** pi.setModel that first restores the target's models when the filter hid them. */
	async function setModelEnsuringVisible(
		target: { provider: string; id: string },
		_ctx: any,
	) {
		if (onlyActiveModels) unhideProvider(target.provider);
		return pi.setModel(target as any);
	}

	/**
	 * Registry lookup that also sees providers the filter hid. Without it the failover's
	 * own candidate search would starve: a hidden provider shows zero models, so the
	 * rotation could never switch INTO it.
	 */
	function findModelIncludingHidden(
		ctx: any,
		provider: string,
		modelId: string,
	) {
		const direct =
			ctx.modelRegistry.find(provider, modelId) ??
			hiddenProviderModels.get(provider)?.find((m: any) => m.id === modelId);
		if (direct) return direct;
		try {
			const fromRegistry = (ctx.modelRegistry.getAll?.() ?? []).filter(
				(m: any) => m.provider === provider,
			);
			const pool = [
				...fromRegistry,
				...(hiddenProviderModels.get(provider) ?? []),
			];
			const exact = pool.find((m: any) => m.id === modelId);
			if (exact) return exact;
			// Cursor catalogs fold effort variants (`cursor-grok-4.6-high` → `cursor-grok-4.6`).
			// A remembered or in-flight id with the suffix must still resolve to the folded model.
			return pool.find((m: any) => sameModelIdentity(m.id, modelId));
		} catch {
			return undefined;
		}
	}

	// Clamp any persisted far-future cooldown on load: a pre-fix (or mis-parsed long-window) state
	// could carry a weeks-away reset that would keep evicting a live account until it expired. Cap it
	// so the account is re-probed within MAX_LIVE_COOLDOWN_MS and usage reconciliation takes over.
	const clampCooldownUntil = (until: number, now = Date.now()): number =>
		Number.isFinite(until) ? Math.min(until, now + MAX_LIVE_COOLDOWN_MS) : until;
	const exhaustedUntilByProvider = new Map<string, number>(
		Object.entries(persistedState.exhaustedUntilByProvider ?? {}).map(
			([provider, until]) => [provider, clampCooldownUntil(until)],
		),
	);
	const exhaustedUntilByModel = new Map<string, number>(
		Object.entries(persistedState.exhaustedUntilByModel ?? {}),
	);
	const invalidatedByProvider = new Map<string, InvalidationRecord>(
		Object.entries(persistedState.invalidatedByProvider ?? {}),
	);
	const usageByProvider = new Map<string, UsageSnapshot>(
		Object.entries(persistedState.usageByProvider ?? {}),
	);
	const codexModelCatalogByProvider = new Map<string, CodexCatalogSnapshot>(
		Object.entries(persistedState.codexModelCatalogByProvider ?? {}),
	);
	const usageFetches = new Map<string, Promise<UsageSnapshot>>();
	const usageErrors = new Map<string, string>();
	// Per-provider 401 tracking (in-memory, reset on any success): the token hash that last failed
	// and how many DISTINCT (refreshed) tokens have failed in a row. Only 401s on a *rotated* token
	// advance toward a permanent kill, so a refreshable account whose refresh isn't reaching the wire
	// is never wrongly revoked.
	const authFailures = new Map<string, { hash: string; distinct: number }>();
	// Response headers arrive before the final assistant message. Keep their cooldown hints, but
	// never switch accounts from that early hook: Pi may still be retrying the same HTTP request.
	const responseCooldownHints = new Map<string, number>();
	const handledAssistantErrors = new Set<string>();
	// Consecutive limit-error accounting per provider (in-memory, reset on any success). Two limit
	// errors in a row prove the usage-% window is not seeing this account's real limit, so usage is
	// distrusted until `usageUntrustedUntilByProvider` expires — this is what stops the ~1s
	// retry-loop against a session-limited account whose quota window still shows headroom.
	const limitStreakByProvider = new Map<
		string,
		{ count: number; lastAt: number }
	>();
	// Seeded from disk: the proof that an account's meter lies must outlive the process that
	// observed it, or every new session re-selects the spent account all over again. Only
	// still-future entries are carried; an expired one has already served its purpose.
	const usageUntrustedUntilByProvider = new Map<string, number>(
		Object.entries(persistedState.usageUntrustedUntilByProvider ?? {}).filter(
			([, until]) => typeof until === "number" && until > Date.now(),
		),
	);

	// An account the user picked by hand (`next` / `switch`), still owed its one attempt.
	//
	// Manual selection deliberately ignores the cooldown bookkeeping, because that bookkeeping is
	// a forecast and actually asking the account is the only way to prove it wrong. The preflight
	// that runs on the next user message re-applied the same forecast and moved the user off — so
	// the override survived only until it was used, which is the one moment it had to hold. This
	// reprieve is spent by the first attempt, so a user cannot strand themselves on a dead account.
	let manualPinnedProvider: string | undefined;
	// Whether the reprieve has already covered a message. The attempt spans several hooks, so
	// "spent" cannot mean "the first hook asked about it"; it means "a message has gone out under
	// it". The next message retires it — which is also why nothing here depends on a particular
	// host emitting a particular event: a reprieve can never outlive the message it was granted
	// for, even on a host that never reaches `before_agent_start`.
	let manualPinCoveredMessage = false;

	function pinManualChoice(provider: string | undefined) {
		manualPinnedProvider = provider;
		manualPinCoveredMessage = false;
	}

	/** Retire a reprieve that has already had its message. Called when a new prompt arrives. */
	function retireSpentManualPin() {
		if (manualPinCoveredMessage) manualPinnedProvider = undefined;
	}

	/**
	 * Whether the account currently selected is the one the user just chose by hand.
	 *
	 * Deliberately does NOT clear the reprieve. Pi runs the readiness preflight twice for a single
	 * user message — once on `input`, then again in `before_agent_start` — so a reprieve spent by
	 * the first "is this account ready?" question was already gone when the second asked, and the
	 * user was moved off the account they had just picked, one moment before it was used. The
	 * reprieve covers the ATTEMPT; only the attempt may spend it.
	 */
	function hasManualPin(provider: string | undefined): boolean {
		return !!provider && manualPinnedProvider === provider;
	}

	/** Mark the reprieve as having covered this message; the next prompt retires it. */
	function markManualPinUsed(provider: string | undefined) {
		if (hasManualPin(provider)) manualPinCoveredMessage = true;
	}

	// Automatic failover onto a same-family sibling whose usage forecast still says spent.
	// Without a one-attempt pin, the next preflight treats that forecast as a verdict and
	// bounces to another family (the openai-codex/gpt-5.6-sol → anthropic/claude-opus-5 hop).
	let failoverPinnedProvider: string | undefined;
	let failoverPinCoveredMessage = false;

	function pinFailoverProbe(provider: string | undefined) {
		failoverPinnedProvider = provider;
		// The hop itself is the attempt. The continuation is not a new user prompt, so the pin
		// must survive until the next genuine `input`. Marking it covered here means a host that
		// never emits `before_agent_start` still retires it on the next typed message, instead of
		// leaving a dead account pinned forever.
		failoverPinCoveredMessage = true;
	}

	function retireSpentFailoverPin() {
		if (failoverPinCoveredMessage) failoverPinnedProvider = undefined;
	}

	function hasFailoverPin(provider: string | undefined): boolean {
		return !!provider && failoverPinnedProvider === provider;
	}

	function markFailoverPinUsed(provider: string | undefined) {
		if (hasFailoverPin(provider)) failoverPinCoveredMessage = true;
	}

	// Discovered, authed, deduped provider ids in rotation order.
	let rotation: string[] = [];
	let duplicateSlots: Array<{ duplicate: string; primary: string }> = [];
	// Whether the one-time host-capability notice has already been shown this process.
	let preflightNotified = false;
	// Slot ids registered as targets in the interactive /login provider picker.
	const registeredSlots = new Set<string>();
	// Host model list an api-key slot was last registered with, so it is refreshed, not re-done.
	const apiKeySlotHostSignature = new Map<string, string>();
	// One notice per process when the optional Cursor provider cannot be loaded.
	let cursorSetupFailureNotified = false;
	// Strongest-first order learned from OpenAI's live per-account catalogs. It feeds the same
	// cross-account ranking path as explicit preferredModels, so newly released flagships win
	// immediately without hard-coding their names in this extension.
	let discoveredCodexModelOrder: string[] = [];
	// Same idea one level down: strongest-first order learned from the HOST model registry
	// (plus our static list). Used whenever the live catalog is unavailable — offline, catalog
	// fetch failing, or autoDiscoverModels turned off.
	let registryCodexModelOrder: string[] = [];
	// The same, for Anthropic. Anthropic publishes no per-account catalog API, so the host
	// registry is the only way a new flagship (e.g. claude-opus-5) can win without a release.
	let registryAnthropicModelOrder: string[] = [];
	// Live Ollama Cloud catalog (`GET https://ollama.com/v1/models`). Unlike Codex, Ollama
	// publishes a single account-agnostic catalog per API key, so one fetch covers the base
	// provider and every cloned `ollama-account-N` slot. Bare ids (e.g. `kimi-k3`) are
	// registered verbatim — Ollama Cloud accepts them as-is.
	let discoveredOllamaModelIds: string[] = [];
	let ollamaCatalogFetchedAt = 0;
	let lastAuthMtime = -1;
	const credentialHashes = new Map<string, string>();
	// Stable per-slot account fingerprints (survive token refresh). A change means the slot was
	// re-logged into a DIFFERENT real account, which is the only reason to drop its cooldown.
	const credentialIdentities = new Map<string, string>();

	let currentPromptSwitch: SwitchRecord | undefined;
	// Number of auto-continuations issued for the CURRENT task. Crucially this is NOT
	// reset by the self-triggered re-prompts failover issues (only by a genuine new user
	// prompt — see before_agent_start), so config.maxAutoContinuesPerPrompt actually bounds
	// the failover loop instead of resetting to 0 on every iteration.
	let autoContinuesThisPrompt = 0;
	let pendingWakeTimer: ReturnType<typeof setTimeout> | undefined;
	let queuedInputWakeTimer: ReturnType<typeof setTimeout> | undefined;
	let usageStatusTimer: ReturnType<typeof setInterval> | undefined;
	const queuedUserInputs: Array<{ text: string; images?: any[] }> = [];
	let continuationDispatchedForAgentTurn = false; // avoid agent_end double-dispatch after message_end failover
	let userAbortedChain = false; // user pressed Esc → stop auto-continuing until a new prompt
	let lastLeftProvider: string | undefined; // account we just failed away from (anti-ping-pong)
	let lastLeftAt = 0;
	let automaticModelTarget: ModelRef | undefined;
	// Forward-progress watchdog state. A "resume in flight" is a continuation WE dispatched
	// (pi.continueAgent after a switch) whose new turn must keep showing activity. Any stream
	// token, tool event, or provider response is "progress" and disarms the stuck timer; total
	// silence past stuckWatchdogMs means the rotated turn wedged and the user is staring at a
	// spinner that will never finish — so we surface a concrete, actionable recovery.
	let resumeInFlight = false;
	let progressWatchdogTimer: ReturnType<typeof setTimeout> | undefined;
	let watchdogCtx: any;
	let lastResumeProgressAt = 0;
	let stuckReminders = 0;
	// True only while WE deliberately abort a wedged resumed turn, so agent_end can tell our
	// recovery abort apart from a real user Esc and auto-continue instead of stopping.
	/** Contract drift is stated once per session — it is a standing condition, not an event. */
	let contractDriftAnnounced = false;
	/** Last contract verdicts, for the status line. */
	let lastContractVerdicts: ShapeVerdict[] = [];

	let watchdogAborting = false;
	// How many tools are executing right now on the resumed turn. A long build/test command is
	// silent for minutes but is NOT stuck — never abort while a tool is in flight.
	let toolInFlight = 0;
	// Set right before we inject a continuation prompt as a user message (the fallback used when
	// the transcript tail is not continuable, e.g. after a watchdog abort). before_agent_start
	// checks it so our own continuation does NOT reset the per-task auto-continue counter — that
	// keeps maxAutoContinuesPerPrompt bounding the recovery loop.
	let expectingInjectedContinuation = false;
	// Circuit breaker: consecutive failed auto-recoveries, and the time until which advisory mode
	// (auto-continue paused) stays in effect once tripped.
	let recoveryFailures = 0;
	let breakerOpenUntil = 0;
	// The thinking level the user intends for this session. pi.setModel() re-clamps AND
	// persists the thinking level on every model switch, so without re-asserting it the level
	// drifts downward across failovers ("thinking level keeps dropping"). But the intent must be
	// read from the SESSION (per-agent `--thinking`, `/thinking`), not from a global default:
	// forcing config.reasoningLevel on every agent_start clobbered per-agent thinking, so an
	// agent configured `low` was flipped to `high` on its first turn (issue #6).
	let desiredThinkingLevel: ReasoningLevel | undefined;
	// What the host clamped our level down to, and on which model. A clamp is the fallback
	// model's cap, NOT a user decision — it must never become the new intent, otherwise one
	// failover to a weaker model would ratchet thinking down for the rest of the session.
	let thinkingClamp: { model: string; level: ReasoningLevel } | undefined;

	const thinkingRank = (level: unknown) =>
		REASONING_LEVELS.indexOf(level as ReasoningLevel);

	function readThinkingLevel(): ReasoningLevel | undefined {
		try {
			const level = (pi as any).getThinkingLevel?.();
			return thinkingRank(level) >= 0 ? (level as ReasoningLevel) : undefined;
		} catch {
			// Older hosts have no getThinkingLevel; we simply have nothing to preserve.
			return undefined;
		}
	}

	const thinkingModelKey = (ctx?: any) =>
		ctx?.model?.provider && ctx?.model?.id
			? ref(ctx.model.provider, ctx.model.id)
			: "unknown";

	// A level lower than the intent that is exactly what the host produced last time we asserted
	// the intent on THIS model is a clamp, not the user lowering thinking on purpose.
	function isKnownThinkingClamp(ctx: any, level: ReasoningLevel) {
		return (
			!!thinkingClamp &&
			thinkingClamp.level === level &&
			thinkingClamp.model === thinkingModelKey(ctx) &&
			thinkingRank(level) < thinkingRank(desiredThinkingLevel)
		);
	}

	function captureDesiredThinking(ctx?: any) {
		const forced =
			config.reasoningLevel === "auto" ? undefined : config.reasoningLevel;
		if (forced) {
			// Explicit config is an opt-in override: force it on every turn (old behaviour).
			desiredThinkingLevel = forced;
		} else {
			const actual = readThinkingLevel();
			if (!actual) {
				/* host cannot report the level: keep whatever we already know, force nothing */
			} else if (desiredThinkingLevel === undefined) {
				// First turn of the session: whatever the session runs at IS the user's intent.
				desiredThinkingLevel = actual;
			} else if (
				actual !== desiredThinkingLevel &&
				!isKnownThinkingClamp(ctx, actual)
			) {
				// The user changed it (`/thinking`, or a delegated agent with its own level).
				logEvent("thinking_intent", { from: desiredThinkingLevel, to: actual });
				desiredThinkingLevel = actual;
			}
		}
		restoreDesiredThinking(ctx);
	}

	function restoreDesiredThinking(ctx?: any) {
		if (!desiredThinkingLevel) return;
		try {
			(pi as any).setThinkingLevel?.(desiredThinkingLevel);
		} catch {
			/* setThinkingLevel clamps to model caps; ignore if unsupported */
		}
		// Record a clamp so the next turn does not mistake the fallback model's cap for intent.
		const applied = readThinkingLevel();
		if (!applied) return;
		if (applied !== desiredThinkingLevel) {
			thinkingClamp = { model: thinkingModelKey(ctx), level: applied };
			logEvent("thinking_clamped", {
				wanted: desiredThinkingLevel,
				applied,
				model: thinkingClamp.model,
			});
		} else {
			thinkingClamp = undefined;
		}
	}

	// ---- crash isolation (v1.12.0) ----------------------------------------
	// This extension hooks ~12 Pi events and runs several background timers. Node
	// terminates the whole process on an unhandled promise rejection, and a throw
	// inside an event handler can break the host. So EVERY handler and EVERY timer
	// callback is funnelled through these guards: the error is reported once
	// (deduped, so a repeating fault can't spam) and swallowed, the current failover
	// step is skipped, and Pi keeps running. This is the systemic net that makes the
	// whole surface fail-safe — not just the specific bugs we already know about.
	const reportedErrors = new Set<string>();
	function reportExtensionError(where: string, error: unknown, ctx?: any) {
		const msg = error instanceof Error ? error.message : String(error);
		const key = `${where}:${msg.slice(0, 80)}`;
		// Always record the raw fault in the black box (deduped only for the user-facing toast).
		logEvent("internal_error", { where, error: msg });
		if (reportedErrors.has(key)) return;
		// Bound both memory and UI noise: after the first 50 distinct faults, the black box remains
		// the diagnostic surface instead of turning every novel failure into another toast.
		if (reportedErrors.size >= 50) return;
		reportedErrors.add(key);
		try {
			ctx?.ui?.notify?.(
				`pi-multi-account: recovered from an internal error in ${where} (${msg.slice(0, 140)}). Failover continues; run /multi-account status if anything looks off.`,
				"warning",
			);
		} catch {
			/* even notify must never throw us out of the guard */
		}
	}

	// Register an event handler that can never crash the host. Preserves the handler's
	// return value (Pi uses these — e.g. the shaped payload or the input action);
	// on a sync throw OR async rejection it reports once and
	// returns undefined, which every Pi event treats as "no opinion / default".
	/**
	 * Look at the files Pi publishes, and say something only when one no longer has the shape this
	 * extension depends on.
	 *
	 * Neither auth.json nor models.json carries a schema version, so a Pi upgrade can change
	 * either without anything announcing it — both breakages this extension has already lived
	 * through were silent for days. Looking is the only detection available.
	 */
	function checkPiContract(ctx: any, why: string) {
		const verdicts = inspectPiContract();
		lastContractVerdicts = verdicts;
		const drift = describeContractDrift(verdicts);
		// A healthy check is logged once, at session start; after that only faults are worth a
		// line, or the black box fills with "still fine" on every turn.
		if (drift || why === "session_start") {
			logEvent("pi_contract_checked", {
				why,
				checked: verdicts.map((verdict) => verdict.file),
				problems: verdicts.flatMap((verdict) => verdict.problems),
				// Named on every logged check: after an upgrade these are the rows to re-verify by
				// hand, because nothing in Pi promises them.
				unpromised: observedAssumptions().map((assumption) => assumption.id),
			});
		}
		if (!drift) {
			// Cleared, so a fault that comes back later is announced again rather than swallowed.
			contractDriftAnnounced = false;
			return;
		}
		if (contractDriftAnnounced) return;
		contractDriftAnnounced = true;
		ctx?.ui?.notify?.(drift, "warning");
	}

	function safeOn(event: string, handler: (ev: any, ctx: any) => any) {
		pi.on(event as any, (ev: any, ctx: any) => {
			try {
				const out = handler(ev, ctx);
				if (out && typeof (out as any).then === "function") {
					return (out as Promise<unknown>).catch((error) => {
						reportExtensionError(`${event} handler`, error, ctx);
						return undefined;
					});
				}
				return out;
			} catch (error) {
				reportExtensionError(`${event} handler`, error, ctx);
				return undefined;
			}
		});
	}

	// Fire-and-forget an async background task (timer callbacks) without ever leaking
	// an unhandled rejection that would abort the Node process.
	function runBackground(where: string, ctx: any, fn: () => Promise<unknown>) {
		try {
			void fn().catch((error) => reportExtensionError(where, error, ctx));
		} catch (error) {
			reportExtensionError(where, error, ctx);
		}
	}

	function persist(extra?: Partial<ProviderFailoverState>) {
		persistedState = {
			...persistedState,
			...extra,
			stateVersion: STATE_VERSION,
			exhaustedUntilByProvider: Object.fromEntries(
				exhaustedUntilByProvider.entries(),
			),
			exhaustedUntilByModel: Object.fromEntries(exhaustedUntilByModel.entries()),
			invalidatedByProvider: Object.fromEntries(invalidatedByProvider.entries()),
			usageUntrustedUntilByProvider: Object.fromEntries(
				usageUntrustedUntilByProvider.entries(),
			),
			usageByProvider: Object.fromEntries(usageByProvider.entries()),
			codexModelCatalogByProvider: Object.fromEntries(
				codexModelCatalogByProvider.entries(),
			),
		};
		saveState(persistedState);
	}

	// ----- invalidation (dead authorization) --------------------------------

	function clearReauthedInvalidations(auth: Record<string, AuthEntry>) {
		let changed = false;
		for (const [provider, record] of [...invalidatedByProvider.entries()]) {
			const entry = auth[provider];
			const currentHash = entry ? credentialHash(entry) : undefined;
			// Re-login (credential changed) or entry removed → clear invalidation.
			if (!entry || (currentHash && currentHash !== record.tokenHash)) {
				invalidatedByProvider.delete(provider);
				exhaustedUntilByProvider.delete(provider);
				authFailures.delete(provider);
				changed = true;
			}
		}
		if (changed) persist();
	}

	function markInvalid(provider: string, reason: string) {
		const entry = readAuthFile()[provider];
		const tokenHash = entry ? (credentialHash(entry) ?? "") : "";
		invalidatedByProvider.set(provider, {
			tokenHash,
			at: Date.now(),
			reason: reason.slice(0, 500),
		});
		// Invalidation = "drop from rotation until the user re-logs in / replaces the key".
		// We do NOT also set a 365-day cooldown — that polluted cooldown displays ("Cooldowns:
		// account-2: 8696h") and confused users into thinking a dead account was merely rate-
		// limited. Selection logic checks isInvalidated() directly, so the cooldown entry is
		// redundant. State stays clean: invalidated providers are reported separately.
		persist();
	}

	function isInvalidated(provider: string) {
		return invalidatedByProvider.has(provider);
	}

	/** True if this account can self-heal a 401 by refreshing its OAuth token. */
	function isRefreshable(provider: string): boolean {
		const entry = readAuthFile()[provider];
		return (
			!!entry && typeof entry.refresh === "string" && entry.refresh.length > 0
		);
	}

	type ForcedRefreshResult =
		| { status: "refreshed" }
		| { status: "terminal"; error: string }
		| { status: "transient"; error: string }
		| { status: "unsupported" };

	/**
	 * Pi normally refreshes OAuth only after the local expiry timestamp. Providers can revoke an
	 * access token earlier, leaving Pi stuck on a token that looks locally valid. On that explicit
	 * provider verdict, force one refresh immediately and persist it through Pi's AuthStorage.
	 */
	async function forceRefreshProvider(
		ctx: any,
		provider: string,
	): Promise<ForcedRefreshResult> {
		const entry = readAuthFile()[provider];
		if (
			!entry ||
			entry.type !== "oauth" ||
			typeof entry.refresh !== "string" ||
			entry.refresh.length === 0
		) {
			return { status: "unsupported" };
		}

		const authStorage = ctx?.modelRegistry?.authStorage;
		// Test harnesses and future Pi versions can provide a first-class forced refresh operation.
		if (typeof authStorage?.forceRefreshProvider === "function") {
			return authStorage.forceRefreshProvider(provider);
		}
		// Refuse to refresh at all if the result has nowhere to go: the refresh itself
		// revokes the token currently on disk.
		if (!canPersistRefreshedCredentials(authStorage)) {
			return { status: "unsupported" };
		}

		const family = classifyProvider(provider, config.qwenProvider);
		try {
			let refreshed: AuthEntry | undefined;
			if (family === "anthropic") {
				refreshed = await refreshAnthropicCredentials(entry, undefined, provider);
			} else if (family === "openai-codex") {
				refreshed = mergeRefreshedCredentials(
					entry,
					await requirePiAiOauth().codex.refresh(
						entry as any,
						AbortSignal.timeout(30_000),
					),
				);
			} else if (family === "cursor") {
				refreshed = mergeRefreshedCredentials(
					entry,
					await refreshCursorCredentials(entry.refresh),
				);
			} else if (family === "antigravity") {
				refreshed = mergeRefreshedCredentials(
					entry,
					await refreshAntigravityCredentials(entry, provider),
				);
			} else {
				return { status: "unsupported" };
			}

			if (!refreshed?.access) {
				return {
					status: "transient",
					error: "OAuth refresh returned no usable access token",
				};
			}
			if (
				entry.accountId &&
				refreshed.accountId &&
				entry.accountId !== refreshed.accountId
			) {
				return {
					status: "terminal",
					error: "OAuth refresh returned credentials for a different account",
				};
			}

			const persisted = await persistRefreshedCredentials(authStorage, provider, {
				type: "oauth",
				...entry,
				...refreshed,
			});
			if (!persisted) {
				// The refresh already rotated the token server-side, so the old one on
				// disk is dead either way. Say so instead of pretending it is transient.
				return {
					status: "terminal",
					error:
						"OAuth refresh succeeded but the rotated credential could not be written to auth.json; run /login for this account",
				};
			}
			reloadHostAuth(ctx);
			refreshDiscovery(true, ctx);
			return { status: "refreshed" };
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			return patternMatch(text, TERMINAL_REFRESH_ERROR_PATTERNS)
				? { status: "terminal", error: text }
				: { status: "transient", error: text };
		}
	}

	function registryCodexModels(ctx: any): CodexCatalogModel[] {
		let models: any[] = [];
		try {
			models =
				ctx?.modelRegistry
					?.getAll?.()
					?.filter((model: any) => model?.provider === CODEX_BASE) ?? [];
		} catch {
			return [];
		}
		return models
			.filter(
				(model) =>
					typeof model?.id === "string" &&
					// Codex only ever serves OpenAI ids. Guard against a host registry that
					// lists something else under this provider leaking into a Codex model list.
					/gpt|codex|^o\d/i.test(model.id),
			)
			.map((model) => ({
				id: model.id,
				name: typeof model.name === "string" ? model.name : model.id,
				reasoning: model.reasoning !== false,
				...(model.thinkingLevelMap
					? { thinkingLevelMap: model.thinkingLevelMap }
					: {}),
				input:
					Array.isArray(model.input) && model.input.length > 0
						? model.input
						: ["text"],
				cost:
					model.cost && typeof model.cost === "object"
						? model.cost
						: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow:
					typeof model.contextWindow === "number" ? model.contextWindow : 272_000,
				maxTokens: typeof model.maxTokens === "number" ? model.maxTokens : 128_000,
			})) as CodexCatalogModel[];
	}

	function mergeCodexModels(
		...groups: CodexCatalogModel[][]
	): CodexCatalogModel[] {
		const byId = new Map<string, CodexCatalogModel>();
		for (const group of groups) {
			for (const model of group)
				if (!byId.has(model.id)) byId.set(model.id, model);
		}
		return [...byId.values()].sort(compareCodexModelStrength);
	}

	/** Publish a credential-free, account-specific model snapshot over Pi's neutral event bus.
	 * Hidden providers are included, while each Codex account's live catalog overrides any
	 * base-provider fallback. No extension name, credential, quota or account identity is sent. */
	function emitModelCatalogSnapshot(ctx: any) {
		const auth = readAuthFile();
		const byProvider = new Map<string, any[]>();
		const put = (model: any) => {
			if (
				!model ||
				typeof model.provider !== "string" ||
				typeof model.id !== "string" ||
				!auth[model.provider]
			)
				return;
			const list = byProvider.get(model.provider) ?? [];
			if (!list.some((entry) => entry.id === model.id)) list.push(model);
			byProvider.set(model.provider, list);
		};
		try {
			for (const model of ctx?.modelRegistry?.getAll?.() ?? []) put(model);
		} catch {
			/* runtime catalog is best effort; hidden/live snapshots follow */
		}
		for (const models of hiddenProviderModels.values())
			for (const model of models) put(model);
		for (const [provider, snapshot] of codexModelCatalogByProvider) {
			if (!auth[provider] || !snapshot.models.length) continue;
			const template =
				byProvider.get(provider)?.[0] ?? byProvider.get(CODEX_BASE)?.[0] ?? {};
			byProvider.set(
				provider,
				snapshot.models.map((model) => ({
					...model,
					provider,
					api: template.api ?? "openai-codex-responses",
					baseUrl: template.baseUrl,
				})),
			);
		}
		const models = [...byProvider]
			.sort(([left], [right]) => left.localeCompare(right))
			.flatMap(([, providerModels]) => providerModels)
			.map((model) => ({
				provider: model.provider,
				id: model.id,
				name: model.name ?? model.id,
				api: model.api,
				baseUrl: model.baseUrl,
				reasoning: model.reasoning !== false,
				input: Array.isArray(model.input) ? model.input : ["text"],
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
			}));
		pi.events?.emit?.(MODEL_CATALOG_SNAPSHOT_EVENT, { schemaVersion: 1, models });
	}

	pi.events?.on?.(MODEL_CATALOG_REQUEST_EVENT, () =>
		emitModelCatalogSnapshot(modelCatalogContext),
	);

	/**
	 * Offline Codex ordering: everything the HOST (Pi) knows about the Codex provider, merged
	 * with our static list and sorted strongest-first.
	 *
	 * Without this, the built-in `DEFAULT_CODEX_MODELS` list was consulted BEFORE the host
	 * registry, so a Pi that already shipped a newer flagship (e.g. gpt-5.6) kept failing over
	 * to the newest model this extension happened to have been released with (gpt-5.5) — a
	 * silent downgrade that needed a new release for every OpenAI generation. Registry-learned
	 * models now win by version, so the next generation works with no release at all. The live
	 * per-account catalog (when reachable) still outranks this.
	 */
	/**
	 * Offline Anthropic ordering: every Claude model the HOST knows, merged with our static list
	 * and ranked strongest-first. Without this, a new flagship shipped by Pi (claude-opus-5 while
	 * this extension's list still topped out at claude-opus-4-8) was invisible to failover, which
	 * silently broke the project's hard rule of always staying on a provider's top model.
	 */
	function refreshRegistryAnthropicModels(ctx: any) {
		let hostIds: string[] = [];
		try {
			hostIds =
				ctx?.modelRegistry
					?.getAll?.()
					?.filter((model: any) => model?.provider === ANTHROPIC_BASE)
					?.map((model: any) => model?.id) ?? [];
		} catch {
			hostIds = [];
		}
		const ranked = rankAnthropicModelIds([
			...hostIds,
			...DEFAULT_ANTHROPIC_MODELS,
		]);
		if (ranked.length === 0) return;
		if (ranked.join(",") === registryAnthropicModelOrder.join(",")) return;
		registryAnthropicModelOrder = ranked;
		// Alias slots are registered from the static list, so a model only the host knows about
		// would not be selectable on them even once it is ranked first.
		for (const provider of registeredSlots) {
			if (classifyProvider(provider, config.qwenProvider) !== "anthropic")
				continue;
			registerAnthropicSlot(pi, provider, ranked);
		}
	}

	function refreshRegistryCodexModels(ctx: any) {
		const merged = mergeCodexModels(
			registryCodexModels(ctx),
			DEFAULT_CODEX_MODELS.map((id) => codexModelDef(id) as CodexCatalogModel),
		);
		const ids = merged.map((model) => model.id);
		if (ids.join(",") === registryCodexModelOrder.join(",")) return;
		registryCodexModelOrder = ids;
		// Alias slots are registered from our static list, so a model only the host knows about
		// would not be selectable on them. Re-register — but never over a live catalog, which is
		// authoritative for that specific account.
		for (const provider of registeredSlots) {
			if (classifyProvider(provider, config.qwenProvider) !== "openai-codex")
				continue;
			if (
				config.autoDiscoverModels &&
				codexModelCatalogByProvider.get(provider)?.models.length
			)
				continue;
			registerCodexCatalog(pi, provider, merged as Array<Record<string, unknown>>);
		}
	}

	async function fetchFreshCodexCatalog(
		ctx: any,
		provider: string,
	): Promise<CodexCatalogModel[]> {
		let entry = readAuthFile()[provider];
		if (!entry)
			throw new CodexCatalogFetchError(`${provider} has no stored credential`);
		const runFetch = () =>
			fetchCodexModelCatalog(entry, { clientVersion: VERSION });
		try {
			return await runFetch();
		} catch (error) {
			if (
				!(error instanceof CodexCatalogFetchError) ||
				error.status !== 401 ||
				!isRefreshable(provider)
			) {
				throw error;
			}
			const refreshed = await forceRefreshProvider(ctx, provider);
			if (refreshed.status !== "refreshed") throw error;
			entry = readAuthFile()[provider];
			if (!entry) throw error;
			return runFetch();
		}
	}

	/**
	 * Pull OpenAI's account-specific catalog and immediately replace every Codex alias model list.
	 * The backend's priority is authoritative; Pi's built-in registry and our static definitions are
	 * only an offline fallback. Catalog snapshots are credential-free and safe to persist.
	 */
	async function syncCodexModelCatalog(ctx: any, force = false) {
		if (!config.autoDiscoverModels) return;
		const auth = readAuthFile();
		const duplicateIds = new Set(
			discoverDuplicateSlots(auth).map(({ duplicate }) => duplicate),
		);
		const providers = Object.keys(auth).filter(
			(provider) =>
				classifyProvider(provider, config.qwenProvider) === "openai-codex" &&
				isEntryUsable(auth[provider]) &&
				!duplicateIds.has(provider),
		);
		const registryFallback = mergeCodexModels(
			registryCodexModels(ctx),
			DEFAULT_CODEX_MODELS.map((id) => codexModelDef(id) as CodexCatalogModel),
		);
		let changed = false;
		await Promise.all(
			providers.map(async (provider) => {
				const cached = codexModelCatalogByProvider.get(provider);
				if (
					!force &&
					cached &&
					Date.now() - cached.fetchedAt < CODEX_MODEL_CATALOG_TTL_MS
				) {
					return;
				}
				try {
					const models = await fetchFreshCodexCatalog(ctx, provider);
					codexModelCatalogByProvider.set(provider, {
						fetchedAt: Date.now(),
						models,
					});
					changed = true;
					logEvent("model_catalog_refresh", {
						provider,
						models: models.map((model) => model.id).join(","),
					});
				} catch (error) {
					logEvent("model_catalog_error", {
						provider,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}),
		);

		const allKnown = mergeCodexModels(
			...providers.map(
				(provider) => codexModelCatalogByProvider.get(provider)?.models ?? [],
			),
			registryFallback,
		);
		discoveredCodexModelOrder = allKnown.map((model) => model.id);

		for (const provider of providers) {
			const cached = codexModelCatalogByProvider.get(provider)?.models;
			const models = cached?.length ? cached : registryFallback;
			registerCodexCatalog(pi, provider, models as Array<Record<string, unknown>>);
		}
		// Also keep unauthenticated spare login slots current so a newly logged-in account can select
		// the new flagship before the next restart/session refresh.
		for (const provider of registeredSlots) {
			if (classifyProvider(provider, config.qwenProvider) !== "openai-codex")
				continue;
			if (providers.includes(provider)) continue;
			registerCodexCatalog(
				pi,
				provider,
				allKnown as Array<Record<string, unknown>>,
			);
		}
		if (changed) persist();
		emitModelCatalogSnapshot(ctx);
		// Catalogs just changed while some providers may be hidden by only-active. Re-apply the
		// filter NOW so the stored hidden copies hold the FRESH lists — otherwise a manual switch
		// that lands before the next message_start would restore the stale pre-sync models.
		applyOnlyActiveFilter(ctx);
	}

	/**
	 * The full Ollama model id set the base provider and every cloned slot should expose:
	 * built-in flagship first, then the user's configured `models.json` ids, then the live
	 * Cloud catalog. Deduped, order-stable. Live ids win visibility without dropping the
	 * configured ones, so a user-pinned tag is never silently replaced.
	 */
	function ollamaRotationModelIds(): string[] {
		const ids = [...DEFAULT_OLLAMA_MODELS];
		for (const configured of configuredModelIds(OLLAMA_BASE)) {
			if (!ids.includes(configured)) ids.push(configured);
		}
		for (const discovered of discoveredOllamaModelIds) {
			if (!ids.includes(discovered)) ids.push(discovered);
		}
		return ids;
	}

	/**
	 * Pull Ollama Cloud's live catalog and re-register the base provider + every cloned slot
	 * with the merged set. Idempotent and cheap: a fresh fetch is bounded by OLLAMA_MODEL_CATALOG_TTL_MS
	 * and the TTL sweep only re-registers when the id set actually changed. Mirrors syncCodexModelCatalog
	 * but simpler — one API key, one account-agnostic catalog.
	 */
	async function syncOllamaModelCatalog(ctx: any, force = false) {
		if (!config.autoDiscoverModels || !config.includeOllama) return;
		const entry = readAuthFile()[OLLAMA_BASE];
		const key =
			entry && typeof entry.key === "string" && entry.key.length > 0
				? entry.key
				: undefined;
		if (!key) return; // no credential → nothing to discover, configured ids still serve
		if (
			!force &&
			ollamaCatalogFetchedAt &&
			Date.now() - ollamaCatalogFetchedAt < OLLAMA_MODEL_CATALOG_TTL_MS
		) {
			return;
		}
		try {
			const ids = await fetchOllamaCloudCatalog(key);
			discoveredOllamaModelIds = ids;
			ollamaCatalogFetchedAt = Date.now();
			logEvent("ollama_catalog_refresh", {
				models: ids.length,
				sample: ids.slice(0, 12).join(","),
			});
		} catch (error) {
			logEvent("ollama_catalog_error", {
				error: error instanceof Error ? error.message : String(error),
			});
			return; // keep the previous (or empty) discovered set; configured ids still serve
		}
		const models = ollamaRotationModelIds().map((m) =>
			ollamaModelDef(m, OLLAMA_BASE),
		);
		pi.registerProvider(OLLAMA_BASE, {
			name: "Ollama",
			baseUrl: OLLAMA_CLOUD_BASE_URL,
			api: "openai-completions" as any,
			apiKey: key,
			models: models as any,
		} as any);
		for (const provider of registeredSlots) {
			if (classifyProvider(provider, config.qwenProvider) !== "ollama") continue;
			const slotEntry = readAuthFile()[provider];
			const slotKey =
				slotEntry && typeof slotEntry.key === "string" && slotEntry.key.length > 0
					? slotEntry.key
					: undefined;
			if (!slotKey) continue;
			pi.registerProvider(provider, {
				name: `Ollama (${provider})`,
				baseUrl: OLLAMA_CLOUD_BASE_URL,
				api: "openai-completions" as any,
				apiKey: slotKey,
				models: ollamaRotationModelIds().map((m) =>
					ollamaModelDef(m, provider),
				) as any,
			} as any);
		}
		// Same repair as the Codex sync: keep only-active hidden copies fresh immediately.
		applyOnlyActiveFilter(ctx);
	}

	function cachedUsage(provider: string): UsageSnapshot | undefined {
		const snapshot = usageByProvider.get(provider);
		if (!snapshot) return undefined;
		const entry = readAuthFile()[provider];
		const currentHash = entry ? credentialHash(entry) : undefined;
		if (snapshot.credentialHash && snapshot.credentialHash !== currentHash)
			return undefined;
		return snapshot;
	}

	function usageCacheTtl(provider: string): number {
		const family = usageFamily(provider);
		if (family === "anthropic") {
			return Math.max(config.usageRefreshMs, MIN_ANTHROPIC_USAGE_REFRESH_MS);
		}
		if (family === "ollama" || family === "cursor") {
			return Math.max(config.usageRefreshMs, 5 * 60_000);
		}
		return config.usageRefreshMs;
	}

	// Qwen/Alibaba publishes NO live quota endpoint (verified: every usage/billing path 404s and no
	// rate-limit headers come back), so a real "% left" is impossible. The honest, useful thing to
	// show instead is the account's live operational state from OUR OWN tracking: available now,
	// rate-limited until a known time (recorded from a caught 429), or needs re-login.
	function qwenLiveStatus(provider: string): string {
		if (isInvalidated(provider))
			return "needs re-login (/login → subscription → alibaba)";
		const now = Date.now();
		const until = providerRecoveryAt(provider, now);
		if (until > now) return `rate-limited · retry in ${formatDelay(until - now)}`;
		return "available · Alibaba exposes no quota API";
	}

	// For display only: Qwen carries no usage windows, so swap its plan text for the live status.
	function displayUsageSnapshot(snapshot: UsageSnapshot): UsageSnapshot {
		return snapshot.family === "qwen"
			? { ...snapshot, plan: qwenLiveStatus(snapshot.provider) }
			: snapshot;
	}

	/**
	 * How many OTHER accounts could take over right now.
	 *
	 * "This account is nearly out" is only half the information; the half that decides what to do
	 * is whether anywhere else is ready. Counted from bookkeeping already in memory — no probes,
	 * no reconciliation — because this runs on a footer timer, not on a decision.
	 */
	function readyElsewhereCount(ctx: any, current: string | undefined): number {
		const now = Date.now();
		return rotation.filter(
			(provider) =>
				provider !== current &&
				!isInvalidated(provider) &&
				providerHasUsableAuth(ctx, provider) &&
				providerRecoveryAt(provider, now) <= now,
		).length;
	}

	function updateUsageStatus(ctx: any, provider = ctx?.model?.provider) {
		if (typeof ctx?.ui?.setStatus !== "function") return;
		// Footer rendering touches host UI + formatting helpers; never let a render hiccup
		// (theme shape change, formatter edge case) bubble up and break the turn it runs in.
		try {
			if (!config.showUsage || !provider || !usageFamily(provider)) {
				ctx.ui.setStatus("multi-account-quota", undefined);
				return;
			}
			// Prefer the hash-verified snapshot, but for DISPLAY fall back to the last stored one even
			// if the OAuth token has since rotated (hash mismatch) — a slightly stale "% left" beats a
			// blank footer, which is what the user saw when Codex's token rotated between usage fetches.
			// Qwen may have no snapshot at all (nothing to fetch) — synthesize a bare one so its live
			// availability/rate-limit status still shows.
			const snapshot =
				cachedUsage(provider) ??
				usageByProvider.get(provider) ??
				(usageFamily(provider) === "qwen"
					? {
							provider,
							family: "qwen" as const,
							fetchedAt: Date.now(),
							plan: "",
						}
					: undefined);
			if (!snapshot) {
				ctx.ui.setStatus("multi-account-quota", undefined);
				return;
			}
			const display = displayUsageSnapshot(snapshot);
			const spare = readyElsewhereCount(ctx, provider);
			const text = `${formatUsageStatus(display)} · ${
				spare > 0 ? `+${spare}` : "no spare"
			}`;
			const color =
				snapshot.family === "qwen"
					? isInvalidated(provider)
						? "error"
						: providerRecoveryAt(provider) > Date.now()
							? "warning"
							: "success"
					: usageColor(display);
			// A theme.fg that throws (host theme API drift) must not blank the whole footer — always
			// fall back to plain text so setStatus is still called with something visible.
			let rendered: string = text;
			try {
				if (ctx.ui.theme?.fg) rendered = ctx.ui.theme.fg(color, text);
			} catch {
				rendered = text;
			}
			ctx.ui.setStatus("multi-account-quota", rendered);
		} catch {
			/* footer is cosmetic — a render error must not affect failover */
		}
	}

	function storeUsage(ctx: any, snapshot: UsageSnapshot) {
		snapshot = preserveKnownPlan(snapshot, usageByProvider.get(snapshot.provider));
		usageByProvider.set(snapshot.provider, snapshot);
		if (snapshot.planWarning) usageErrors.set(snapshot.provider, snapshot.planWarning);
		else usageErrors.delete(snapshot.provider);
		// AUTHORITATIVE PROACTIVE BENCH. If the account's own usage endpoint reports a hard block (a
		// window at >=100% with a future reset), record the cooldown NOW — even if the account never
		// threw a limit error and had no prior cooldown. Without this, a known-spent account (a
		// free-tier Codex slot maxed on its monthly window) stayed fully "available" for selection
		// until it was actively tried and failed, so failover kept landing on dead accounts one after
		// another instead of jumping straight to a live one. markExhausted caps the STORED value at the
		// live ceiling and fans it out to sibling slots on the same account; providerRecoveryAt still
		// reports the real reset from the live snapshot. Never benches an account with headroom
		// (cooldownMsFromUsage returns 0 while the primary window is < 100%).
		const blockMs = cooldownMsFromUsage(snapshot);
		if (blockMs !== undefined && blockMs > 0) {
			markExhausted(snapshot.provider, blockMs);
		} else if (blockMs === 0) {
			// A live account probe is allowed to contradict an older reset estimate. Plans can be
			// upgraded, credits can be purchased, and providers can restore capacity before the
			// previously advertised resetAt. Fresh headroom therefore clears the old cooldown; the
			// usage-untrusted guard inside applyUsageToCooldown still protects session limits that
			// the quota endpoint is known not to see.
			applyUsageToCooldown(snapshot.provider, snapshot, Date.now());
		}
		logEvent("usage_refresh", {
			provider: snapshot.provider,
			family: snapshot.family,
			plan: snapshot.plan ?? "unknown",
			primaryUsedPercent: snapshot.primary?.usedPercent ?? "unknown",
			blocked: blockMs !== undefined && blockMs > 0,
		});
		persist();
		updateUsageStatus(ctx);
	}

	async function fetchFreshUsage(
		ctx: any,
		provider: string,
	): Promise<UsageSnapshot> {
		let entry = readAuthFile()[provider];
		if (!entry) throw new UsageFetchError(`${provider} has no stored credential`);
		const runFetch = () =>
			fetchUsageSnapshot(provider, entry, {
				credentialHash: credentialHash(entry),
			});
		try {
			return await runFetch();
		} catch (error) {
			if (
				!(error instanceof UsageFetchError) ||
				error.status !== 401 ||
				!isRefreshable(provider)
			)
				throw error;
			const refreshed = await forceRefreshProvider(ctx, provider);
			if (refreshed.status !== "refreshed") throw error;
			entry = readAuthFile()[provider];
			if (!entry) throw error;
			return runFetch();
		}
	}

	async function refreshUsage(
		ctx: any,
		provider = ctx?.model?.provider,
		force = false,
		includeWhenFooterHidden = false,
	): Promise<UsageSnapshot | undefined> {
		// `showUsage` controls automatic footer polling. Explicit commands can opt in below so they
		// do not silently render an old persisted snapshot forever when the footer is disabled.
		if (
			(!config.showUsage && !includeWhenFooterHidden) ||
			!provider ||
			!usageFamily(provider)
		) {
			updateUsageStatus(ctx, provider);
			return undefined;
		}
		const cached = cachedUsage(provider);
		if (
			!force &&
			cached &&
			Date.now() - cached.fetchedAt < usageCacheTtl(provider)
		) {
			updateUsageStatus(ctx, provider);
			return cached;
		}
		const existing = usageFetches.get(provider);
		if (existing) {
			try {
				return await existing;
			} catch {
				updateUsageStatus(ctx, provider);
				return cached;
			}
		}
		const fetchPromise = fetchFreshUsage(ctx, provider);
		usageFetches.set(provider, fetchPromise);
		try {
			const snapshot = await fetchPromise;
			storeUsage(ctx, snapshot);
			return snapshot;
		} catch (error) {
			usageErrors.set(
				provider,
				error instanceof Error ? error.message : String(error),
			);
			updateUsageStatus(ctx, provider);
			return cached;
		} finally {
			usageFetches.delete(provider);
		}
	}

	/**
	 * Refresh every authenticated account independently, not just the account currently selected
	 * in the session. This is what detects an early quota restoration, a purchased credit balance,
	 * or a Free -> Plus/Pro plan upgrade while the account is benched by an older 100% snapshot.
	 *
	 * refreshUsage() already applies a per-family TTL and deduplicates in-flight requests, so calling
	 * this from the status timer is cheap: network traffic occurs only when an account's own snapshot
	 * is stale. Qwen/Cursor use honest capability-only snapshots because they expose no quota API.
	 */
	async function refreshRotationUsage(
		ctx: any,
		force = false,
		includeWhenFooterHidden = false,
	) {
		// Timers respect `showUsage`; an explicitly requested status refresh does not. This keeps a
		// hidden footer network-quiet while ensuring `/status` never presents an hour-old snapshot as
		// live data.
		if (!config.showUsage && !includeWhenFooterHidden) {
			updateUsageStatus(ctx);
			return;
		}
		const providers = [
			...new Set(
				rotation.filter(
					(provider) =>
						!!usageFamily(provider) && providerHasUsableAuth(ctx, provider),
				),
			),
		];
		await Promise.all(
			providers.map((provider) =>
				refreshUsage(ctx, provider, force, includeWhenFooterHidden),
			),
		);
		updateUsageStatus(ctx);
	}

	function clearUsageStatusTimer() {
		if (!usageStatusTimer) return;
		clearInterval(usageStatusTimer);
		usageStatusTimer = undefined;
	}

	function startUsageStatusTimer(ctx: any) {
		clearUsageStatusTimer();
		if (!config.showUsage && !config.autoDiscoverModels) {
			updateUsageStatus(ctx);
			return;
		}
		usageStatusTimer = setInterval(() => {
			runBackground("rotation metadata refresh", ctx, async () => {
				await refreshRotationUsage(ctx);
				// Re-registering provider models is safe while idle and avoids touching the registry in
				// the middle of a streaming request. The five-minute catalog TTL keeps this sweep cheap.
				if (ctx?.isIdle?.() !== false) await syncCodexModelCatalog(ctx);
				if (ctx?.isIdle?.() !== false) await syncOllamaModelCatalog(ctx);
			});
		}, config.usageStatusRefreshMs);
		(usageStatusTimer as any).unref?.();
	}

	/** A successful response → this account's auth is fine; clear its 401 streak. */
	function noteAuthSuccess(provider: string, modelId?: string) {
		// A real success proves the account works right now → the usage reading was not lying; reset
		// the limit-error streak and re-trust usage for this provider.
		limitStreakByProvider.delete(provider);
		// Distrust is not permanent: a real success is the only evidence that outranks the refusal
		// that created it, and it must be written down too or a restart would resurrect the bench.
		let changed = usageUntrustedUntilByProvider.delete(provider);
		changed = authFailures.delete(provider) || changed;
		changed = exhaustedUntilByProvider.delete(provider) || changed;
		changed = invalidatedByProvider.delete(provider) || changed;
		if (modelId)
			changed = exhaustedUntilByModel.delete(ref(provider, modelId)) || changed;
		if (changed) persist();
	}

	/**
	 * Handle a 401/auth failure WITHOUT nuking an account that just needs a token refresh.
	 * Non-refreshable (API key): historically a 401 was marked fatal at once, but in practice
	 * Ollama Cloud / Alibaba / OpenRouter return 401 transiently under load, or the key rotates
	 * on the server side without the client knowing. Only the explicit terminal patterns
	 * ("invalid api key", "incorrect api key", "revoked") kill the slot now; a bare 401 gets a
	 * transient cooldown and the same consecutive-failure accounting as OAuth, so a momentary
	 * blip no longer removes a working key for a year. However, repeated 401s with the SAME key
	 * (same hash) are not a transient blip for API-key providers — the key is permanently
	 * invalid. After MAX_SAME_KEY_AUTH_FAILURES consecutive same-key failures, the slot is
	 * invalidated so the user is told to re-login instead of looping on a 1-minute cooldown
	 * forever.
	 * Refreshable (OAuth): only a 401 on a *rotated* token — proof Pi actually refreshed and the NEW
	 * token still failed — counts toward the kill threshold. Repeated 401s on the SAME token mean the
	 * refresh isn't reaching the wire (a refresh/config fault, e.g. an alias that dropped the refreshed
	 * access token), which is NEVER proof the account is revoked; those only re-arm the transient
	 * cooldown so the next call keeps a chance to refresh. Only after MAX_CONSECUTIVE_AUTH_FAILURES
	 * distinct refreshed tokens fail do we mark it dead-until-relogin.
	 * Returns true if the account was permanently invalidated.
	 */
	function markAuthFailure(provider: string, reason: string): boolean {
		if (patternMatch(reason, TERMINAL_AUTH_ERROR_PATTERNS)) {
			authFailures.delete(provider);
			markInvalid(provider, reason);
			return true;
		}
		const entry = readAuthFile()[provider];
		const hash = (entry ? credentialHash(entry) : undefined) ?? "";
		const prev = authFailures.get(provider);
		if (prev && prev.hash === hash) {
			// Same token failed again → Pi's refresh never reached the wire, or (for API-key
			// providers) the same key failed again. For OAuth providers this is likely a refresh
			// fault (the refresh didn't reach the wire), so we keep the account recoverable.
			// For non-refreshable (API-key) providers, the same key failing repeatedly is NOT a
			// transient blip — the key is permanently invalid. Advance toward invalidation so
			// the user is told to re-login instead of looping on a 1-minute cooldown forever.
			if (!isRefreshable(provider)) {
				const distinct = (prev.distinct ?? 0) + 1;
				if (distinct >= MAX_SAME_KEY_AUTH_FAILURES) {
					authFailures.delete(provider);
					markInvalid(provider, `${reason} (after ${distinct} same-key 401s)`);
					return true;
				}
				authFailures.set(provider, { hash, distinct });
			}
			markExhausted(provider, TRANSIENT_AUTH_COOLDOWN_MS);
			return false;
		}
		// First failure, or the token rotated since the last 401 (Pi refreshed and it STILL failed).
		const distinct = (prev?.distinct ?? 0) + 1;
		if (distinct >= MAX_CONSECUTIVE_AUTH_FAILURES) {
			authFailures.delete(provider);
			markInvalid(provider, `${reason} (after ${distinct} refreshed-token 401s)`);
			return true;
		}
		authFailures.set(provider, { hash, distinct });
		// Transient: brief cooldown so selection skips it for a moment; Pi refreshes on next use.
		markExhausted(provider, TRANSIENT_AUTH_COOLDOWN_MS);
		return false;
	}

	// ----- cooldowns --------------------------------------------------------

	function pruneCooldowns() {
		const now = Date.now();
		let changed = false;
		const ceiling = now + MAX_LIVE_COOLDOWN_MS;
		for (const [provider, until] of exhaustedUntilByProvider) {
			if (until <= now && !isInvalidated(provider)) {
				exhaustedUntilByProvider.delete(provider);
				changed = true;
			} else if (until > ceiling) {
				// A far-future cooldown (mis-parsed long/rolling reset) never gets re-probed on its
				// own — cooling-down accounts are skipped. Clamp it so the account is retried at the
				// ceiling and usage reconciliation can free it the moment its short window has headroom.
				exhaustedUntilByProvider.set(provider, ceiling);
				changed = true;
			}
		}
		for (const [model, until] of exhaustedUntilByModel) {
			if (until <= now) {
				exhaustedUntilByModel.delete(model);
				changed = true;
			}
		}
		if (changed) persist();
	}

	function isTransientPendingReason(reason: string) {
		return reason.startsWith(TRANSIENT_PENDING_PREFIX);
	}

	// A "still busy" auto-retry is a timing issue, not a model failure: resume the SAME model,
	// never rotate to a sibling model/account (which would silently downgrade it).
	function isBusyRetryPendingReason(reason: string) {
		return reason === BUSY_RETRY_REASON;
	}

	// Reasons where the source model is healthy and must be resumed as-is — never downgraded.
	function isSameModelResumeReason(reason: string) {
		return isTransientPendingReason(reason) || isBusyRetryPendingReason(reason);
	}

	function isAuthPendingReason(reason: string) {
		const lower = reason.toLowerCase();
		return (
			lower.includes("auth invalid") ||
			lower.includes("auth failure") ||
			lower.includes("invalid api-key") ||
			lower.includes("invalid api key")
		);
	}

	/** When does this provider become usable again? Uses recorded cooldown AND fresh usage. */
	// True while a provider's usage-% reading is distrusted because a repeat limit error proved it
	// does not reflect the account's real (session/rate) limit. See LIMIT_STREAK_WINDOW_MS.
	function usageUntrusted(provider: string, now = Date.now()): boolean {
		return (usageUntrustedUntilByProvider.get(provider) ?? 0) > now;
	}

	// Record a limit error for a provider and return the consecutive streak. A second error within
	// LIMIT_STREAK_WINDOW_MS (no success reset in between) flips the account's usage reading to
	// "distrusted" so its real cooldown can no longer be cleared by a lying "usage says free".
	function noteLimitError(provider: string, now = Date.now()): number {
		const prev = limitStreakByProvider.get(provider);
		const count =
			prev && now - prev.lastAt < LIMIT_STREAK_WINDOW_MS ? prev.count + 1 : 1;
		limitStreakByProvider.set(provider, { count, lastAt: now });
		if (count >= 2) markUsageUntrusted(provider, now);
		return count;
	}

	/**
	 * Stop believing this provider's usage-% reading for a while, and write that down.
	 *
	 * The distinction that matters: a used-percentage is a FORECAST about one quota window, and
	 * that window cannot see a session or plan limit. A refusal is an OBSERVATION that just
	 * happened. When they disagree, the observation is the one that was actually measured — so it
	 * wins, and it keeps winning across restarts until the account proves otherwise by succeeding.
	 */
	function markUsageUntrusted(provider: string, now = Date.now()) {
		const until = now + USAGE_UNTRUSTED_MS;
		if ((usageUntrustedUntilByProvider.get(provider) ?? 0) >= until) return;
		usageUntrustedUntilByProvider.set(provider, until);
		persist();
	}

	/** True when a fresh snapshot carries the provider's own "usable right now" verdict. */
	function isConfirmedAvailable(provider: string, now = Date.now()): boolean {
		const cached = usageByProvider.get(provider);
		return (
			!!cached &&
			cached.serviceable === true &&
			now - cached.fetchedAt < usageCacheTtl(provider)
		);
	}

	function providerRecoveryAt(
		provider: string,
		now = Date.now(),
		options: { ignoreCeiling?: boolean } = {},
	): number {
		// Nothing may push the next attempt beyond the recheck ceiling. Providers refresh quota
		// windows early and unannounced, AND resize the windows themselves — so a reset timestamp
		// is a forecast and a used-percentage is a fraction whose denominator can change under us.
		// Neither is evidence about the future. Capping here is what converts this extension from
		// predicting availability to verifying it: worst case we ask again in `maxRecheckIntervalMs`
		// and the account itself answers. A refusal costs no tokens, so asking is close to free.
		//
		// Applied to the usage FORECAST only. A cooldown we recorded ourselves was already capped
		// when it was written (see markExhausted).
		//
		// The ceiling is anchored to when the snapshot was TAKEN, never to `now`: an offset from
		// `now` is recomputed on every call, so it stays permanently in the future and never
		// elapses. Anchoring says what we actually mean — this reading is worth believing for
		// maxRecheckIntervalMs after we took it, and then the account itself gets asked again.
		const capped = (at: number, takenAt: number) =>
			options.ignoreCeiling
				? at
				: Math.max(now, Math.min(at, takenAt + config.maxRecheckIntervalMs));
		let at = Math.max(now, exhaustedUntilByProvider.get(provider) ?? now);
		const cached = usageByProvider.get(provider);
		if (cached) {
			const fresh = now - cached.fetchedAt < usageCacheTtl(provider);
			// The provider's OWN verdict, when it states one, outranks every derived number here —
			// including a cooldown we recorded ourselves and the distrust we place on a meter that
			// once lied. Those exist precisely because a percentage is a forecast; `serviceable` is
			// not a forecast, it is the account answering "can I be used right now". Ignoring it is
			// what left two accounts benched for hours after ChatGPT had already gone back to
			// answering `allowed: true` for them, which from the outside looks exactly like an
			// extension that cannot see accounts that freed up.
			//
			// Only while FRESH: a verdict is a statement about the moment it was taken, so a stale
			// "yes" must not clear a cooldown recorded after it, and a stale "no" must not outlive
			// the recheck ceiling that governs every other stale reading.
			if (fresh && cached.serviceable === true) return now;
			if (fresh && cached.serviceable === false)
				return capped(
					Math.max(at, now + config.maxRecheckIntervalMs),
					cached.fetchedAt,
				);
			const usageMs = cooldownMsFromUsage(cached, now);
			// A HARD BLOCK — a usage window at >=100% whose reset is still in the future — is
			// authoritative ground truth REGARDLESS of snapshot age: a maxed 30-day (or 5h) window
			// cannot have "un-maxed" itself in the minutes since we last probed, and cooldownMsFromUsage
			// already drops any window whose reset has passed. So we trust it even when stale. This is
			// the fix for the real failure mode: a genuinely-spent account (e.g. a free-tier Codex slot
			// maxed on its monthly window) that never threw an error yet and had no recorded cooldown
			// was treated as "available" and selected as the failover target — so failover kept landing
			// on dead accounts instead of advancing to a live Qwen/Ollama one.
			if (usageMs !== undefined && usageMs > 0)
				return capped(now + usageMs, cached.fetchedAt);
			// "Available now" (usageMs === 0) is only trusted while FRESH — a stale pre-limit reading
			// must never clear a real cooldown early — AND only while usage is still trusted for this
			// provider. A session/rate-limited account keeps 429ing while its quota window shows
			// headroom; once that has been proven (usageUntrusted), we respect the recorded cooldown
			// (`at`) instead of falsely reporting "recovered now" and hot-looping a ~1s retry.
			if (fresh && usageMs === 0) return usageUntrusted(provider, now) ? at : now;
		}
		return at;
	}

	/** Human-readable summary for /multi-account status — earliest account to recover. */
	function nextRecoveryStatus(ctx: any): string {
		const now = Date.now();
		reconcileCooldownsFromUsage(ctx);
		const providers = rotation.filter((p) => !isInvalidated(p));
		if (providers.length === 0)
			return "none — no authenticated accounts in rotation";

		const cooling = providers
			.map((provider) => ({ provider, at: providerRecoveryAt(provider, now) }))
			.filter(({ at }) => at > now + 500)
			.sort((a, b) => a.at - b.at);

		if (cooling.length === 0) return "all rotation accounts available now";

		const parts: string[] = [];
		const first = cooling[0];
		parts.push(
			`first: ${first.provider} in ~${formatDelay(first.at - now)} (${formatUntil(first.at)})`,
		);
		if (cooling.length > 1) {
			const also = cooling
				.slice(1, 4)
				.map((r) => `${r.provider} ~${formatDelay(r.at - now)}`)
				.join(", ");
			parts.push(`then: ${also}${cooling.length > 4 ? ", …" : ""}`);
		}
		if (hasPendingResume()) {
			const wake = nextPendingWakeDelayMs();
			if (wake !== undefined)
				parts.push(`auto-resume check in ~${formatDelay(wake)}`);
		} else if (queuedUserInputs.length > 0) {
			const wake = nextModelAvailabilityDelayMs(ctx);
			if (wake !== undefined)
				parts.push(`queued input send in ~${formatDelay(wake)}`);
		}
		return parts.join(" · ");
	}

	async function resolveLimitCooldownMs(
		ctx: any,
		provider: string,
		errorText: string,
	): Promise<number> {
		const now = Date.now();
		// Count this limit error. The streak still drives longer-horizon behaviour; the immediate
		// decision below no longer waits for it.
		noteLimitError(provider, now);
		const statedMs = cooldownFromErrorText(errorText);
		// The provider named a concrete recovery horizon while our usage reading for this account
		// claims it is free right now. Those cannot both be true, and only one of them was
		// measured: the stated horizon came from the account being refused just now, the
		// percentage is a forecast about a quota window that cannot see a session or plan limit.
		// So the reading is wrong for this account and must stop being able to wipe the bench we
		// are about to set — that clearing is exactly what walked rotation back onto a spent
		// account seconds after it refused.
		//
		// Deliberately narrow. A bare throttle with no stated horizon ("429 rate limit") still
		// defers to the meter, because there the meter really is the better evidence and the
		// account may well be usable again immediately. Only an explicit horizon longer than the
		// floor counts as the provider contradicting the reading. Checked against the CACHED
		// snapshot because the live refresh below is best-effort, while the reconciliation pass
		// that did the clearing runs off the cache.
		const knownUsage = usageByProvider.get(provider);
		if (
			typeof statedMs === "number" &&
			statedMs > SESSION_LIMIT_FLOOR_MS &&
			knownUsage &&
			cooldownMsFromUsage(knownUsage, now) === 0
		) {
			markUsageUntrusted(provider, now);
		}
		const hintedCooldowns = [
			responseCooldownHints.get(provider),
			statedMs,
		].filter((value): value is number => typeof value === "number" && value > 0);
		const snapshot = await refreshUsage(ctx, provider, true);
		if (snapshot) {
			applyUsageToCooldown(provider, snapshot, now);
			const usageMs = cooldownMsFromUsage(snapshot);
			// Fresh usage is normally ground truth: a maxed long/rolling window must not evict an
			// account whose short window has already freed.
			//
			// But here the account has JUST REFUSED while the meter claims headroom
			// (usageMs === 0). That contradiction is itself the evidence — this account's real
			// limit is invisible to the quota window, so the reading is wrong for it right now.
			// Returning 0 on that reading is what put the user straight back onto a spent account:
			// the meter read 98%, the cooldown was wiped, rotation walked back in, and the same
			// refusal came again. Believing it once was already once too many, so the first
			// contradiction distrusts the meter and records a short real floor instead.
			//
			// The floor is deliberately small: if the short window truly had freed, the account
			// simply returns a few minutes later rather than being benched on a forecast.
			if (usageMs === 0) {
				markUsageUntrusted(provider, now);
				hintedCooldowns.push(SESSION_LIMIT_FLOOR_MS);
			} else if (usageMs !== undefined && usageMs > 0) {
				hintedCooldowns.push(usageMs);
			}
		}
		if (hintedCooldowns.length === 0) return config.cooldownMs;
		// Backstop: never let a single live estimate lock an account beyond the ceiling.
		return Math.min(Math.max(...hintedCooldowns), MAX_LIVE_COOLDOWN_MS);
	}

	function providersSharingAccount(provider: string): string[] {
		const auth = readAuthFile();
		const identity = auth[provider] ? accountIdentity(auth[provider]) : undefined;
		if (!identity) return [provider];
		const shared = Object.keys(auth).filter((p) => {
			const e = auth[p];
			return e && accountIdentity(e) === identity;
		});
		return shared.length > 0 ? shared : [provider];
	}

	/**
	 * Whether this account's availability can be checked WITHOUT spending a user turn.
	 *
	 * Codex, Anthropic, Ollama and Cursor all publish something we can poll in the background.
	 * Kimi and Qwen publish nothing, so their only "probe" is a real request that costs the user
	 * the turn it lands on.
	 */
	function hasCheapAvailabilityProbe(provider: string): boolean {
		const family = usageFamily(provider);
		return (
			family === "codex" ||
			family === "anthropic" ||
			family === "ollama" ||
			family === "cursor"
		);
	}

	function markExhausted(provider: string, cooldownMs: number) {
		if (cooldownMs <= 0) return; // killed accounts are in invalidatedByProvider, not cooldowns
		// Invariant backstop: no LIVE cooldown may exceed the recheck ceiling, regardless of what
		// the provider predicted. A reset timestamp is a forecast — providers refresh windows early
		// and unannounced and resize the windows themselves — so it may order the queue but must
		// never bench an account for hours or weeks. At the ceiling we simply ask again; a refusal
		// costs no tokens, and only the account itself can prove it is still spent.
		//
		// "Costs no tokens" is true only where asking is a background usage probe. For an account
		// with NO usage endpoint — Kimi answers 404 on every documented path, Qwen exposes none —
		// the only way to ask is to spend a real user turn: the message lands on the spent account,
		// is refused, and is bounced onward. Re-asking that way every ten minutes, of an account
		// that has just said its quota returns in the next billing cycle, is precisely the
		// thrashing the ceiling exists to prevent. So the ceiling applies where re-probing is
		// cheap, and the recorded cooldown stands where it is not.
		const until =
			Date.now() +
			Math.min(
				Math.max(cooldownMs, 1000),
				hasCheapAvailabilityProbe(provider)
					? config.maxRecheckIntervalMs
					: Number.POSITIVE_INFINITY,
				MAX_LIVE_COOLDOWN_MS,
			);
		for (const candidate of providersSharingAccount(provider)) {
			exhaustedUntilByProvider.set(
				candidate,
				Math.max(exhaustedUntilByProvider.get(candidate) ?? 0, until),
			);
		}
		persist();
	}

	function markModelExhausted(model: any, cooldownMs: number) {
		if (!model?.provider || !model?.id) return;
		const key = ref(model.provider, model.id);
		const until = Date.now() + Math.max(cooldownMs, 1000);
		exhaustedUntilByModel.set(
			key,
			Math.max(exhaustedUntilByModel.get(key) ?? 0, until),
		);
		persist();
	}

	/** Snap a recorded cooldown to what fresh usage actually reports for the account. */
	function applyUsageToCooldown(
		provider: string,
		snapshot: UsageSnapshot,
		now: number,
	) {
		// The account's own verdict settles it in both directions, before any arithmetic on
		// windows. "Usable" retires the bench AND the distrust: that distrust was recorded about
		// the METER after a refusal contradicted it, and the account has now answered for itself,
		// which is the evidence the distrust was waiting for. Leaving the record in place while
		// merely bypassing it at selection time keeps the account looking spent in `status` and
		// keeps the resume timer waiting on a bench that no longer means anything.
		if (snapshot.serviceable === true) {
			let changed = exhaustedUntilByProvider.delete(provider);
			changed = usageUntrustedUntilByProvider.delete(provider) || changed;
			if (changed) persist();
			return;
		}
		// "Blocked" is the account refusing outright; a window with headroom does not overrule it.
		if (snapshot.serviceable === false) return;
		const realMs = cooldownMsFromUsage(snapshot, now);
		if (realMs === undefined) return;
		const recorded = exhaustedUntilByProvider.get(provider) ?? 0;
		if (realMs <= 0) {
			// Usage says the account is free again — drop the cooldown so resume can pick it up,
			// even if our original estimate hasn't expired yet. But NOT when usage has been proven
			// unreliable for this account (a session/rate limit the quota window can't see): clearing
			// there would immediately re-select a still-maxed account and loop.
			if (usageUntrusted(provider, now)) return;
			if (exhaustedUntilByProvider.delete(provider)) persist();
			return;
		}
		const realUntil = now + realMs;
		// Only ever SHORTEN here: error-derived cooldowns may be more pessimistic than reality,
		// but never extend a cooldown from a usage probe.
		if (recorded > now && realUntil < recorded) {
			exhaustedUntilByProvider.set(provider, realUntil);
			persist();
		}
	}

	/**
	 * While paused, re-derive the real recovery time of every cooling account from its usage
	 * endpoint. This is what makes the FIRST account to actually recover resume the work, instead
	 * of waiting on a recorded estimate that may be longer than the server's true reset.
	 *
	 * Non-blocking by design: it kicks a background usage refresh (a no-op unless usage display is
	 * enabled) and acts only on a FRESH cached snapshot, so resume is never stalled on a slow probe
	 * and a stale pre-limit reading can never clear a cooldown prematurely.
	 */
	function reconcileCooldownsFromUsage(ctx: any) {
		const now = Date.now();
		for (const [provider, until] of [...exhaustedUntilByProvider.entries()]) {
			if (until <= now || isInvalidated(provider) || !usageFamily(provider))
				continue;
			runBackground("cooldown reconcile usage", ctx, () =>
				refreshUsage(ctx, provider, true),
			);
			const cached = usageByProvider.get(provider);
			if (cached && now - cached.fetchedAt < usageCacheTtl(provider))
				applyUsageToCooldown(provider, cached, now);
		}
	}

	// ----- discovery & dynamic rotation -------------------------------------

	function discoverRotation(auth: Record<string, AuthEntry>): string[] {
		const byFamily: Record<ProviderFamily, string[]> = {
			anthropic: [],
			"openai-codex": [],
			"kimi-coding": [],
			antigravity: [],
			cursor: [],
			qwen: [],
			ollama: [],
		};
		for (const [id, entry] of Object.entries(auth)) {
			const family = classifyProvider(id, config.qwenProvider);
			if (!family) continue;
			if (family === "qwen" && !config.includeQwen) continue;
			if (family === "ollama" && !config.includeOllama) continue;
			if (family === "cursor" && !config.includeCursor) continue;
			if (!isEntryUsable(entry)) continue;
			if (isInvalidated(id)) continue;
			byFamily[family].push(id);
		}
		// Sort each family base-first, then account-2,3,... and dedupe real accounts.
		const order = config.providerOrder.length
			? config.providerOrder
			: DEFAULT_PROVIDER_ORDER;
		const seenIdentity = new Set<string>();
		const result: string[] = [];
		for (const family of order) {
			const ids = byFamily[family].sort((a, b) => slotIndex(a) - slotIndex(b));
			for (const id of ids) {
				const identity = accountIdentity(auth[id]);
				if (identity && seenIdentity.has(identity)) continue; // same account in two slots
				if (identity) seenIdentity.add(identity);
				result.push(id);
			}
		}
		// Everything else the user is logged in to. Recognising five families by name and dropping
		// the rest meant a machine with fourteen accounts rotated across eight and silently left
		// six — several hundred models — unused, with nothing anywhere saying so. A provider does
		// not need to be understood in detail to be usable: if Pi can call it, it can carry work.
		//
		// They go LAST, after every managed family. A managed account has quota telemetry, OAuth
		// refresh and a live catalogue; an unmanaged one is a blind spend, so it is the account of
		// last resort rather than a peer. A provider Pi exposes no model for contributes no
		// candidate at selection time and is skipped there, so nothing is routed into a void.
		if (config.includeOtherProviders) {
			for (const [id, entry] of Object.entries(auth)) {
				if (classifyProvider(id, config.qwenProvider)) continue;
				if (!isEntryUsable(entry) || isInvalidated(id)) continue;
				const identity = accountIdentity(entry);
				if (identity && seenIdentity.has(identity)) continue;
				if (identity) seenIdentity.add(identity);
				result.push(id);
			}
		}
		return result;
	}

	/** Rotation members this extension carries but cannot measure — no quota endpoint. */
	function unmanagedRotationMembers(): string[] {
		return rotation.filter(
			(id) => !classifyProvider(id, config.qwenProvider) && !usageFamily(id),
		);
	}

	/**
	 * Rotation members the host knows no model for.
	 *
	 * Being in the rotation is not the same as being usable: selection asks the host registry for
	 * this provider's models and skips an account that yields none. Such an account was listed
	 * beside working ones with nothing to distinguish it, so it read as in service while being
	 * unreachable — the fix is to name it as needing configuration, not to hide it, because
	 * hiding it is how the original silent drop looked from the outside.
	 *
	 * Specially-managed families are exempt: this extension registers their slots itself, so a
	 * momentarily empty registry says nothing about whether they work.
	 */
	function unconfiguredRotationMembers(ctx: any): string[] {
		if (!ctx?.modelRegistry?.getAll) return [];
		return rotation.filter((id) => {
			if (classifyProvider(id, config.qwenProvider)) return false;
			return hostModelIdsFor(ctx, id).length === 0;
		});
	}

	function discoverDuplicateSlots(auth: Record<string, AuthEntry>) {
		const primaryByIdentity = new Map<string, string>();
		const duplicates: Array<{ duplicate: string; primary: string }> = [];
		for (const id of Object.keys(auth).sort(
			(a, b) => slotIndex(a) - slotIndex(b),
		)) {
			const family = classifyProvider(id, config.qwenProvider);
			if (!family || !isEntryUsable(auth[id])) continue;
			const identity = accountIdentity(auth[id]);
			if (!identity) continue;
			const primary = primaryByIdentity.get(identity);
			if (primary) duplicates.push({ duplicate: id, primary });
			else primaryByIdentity.set(identity, id);
		}
		return duplicates;
	}

	/**
	 * `explicit` = the user asked for Cursor by name (`/multi-account add cursor`), which is
	 * the ONLY case where a missing provider clone is worth a warning. On the automatic path
	 * a not-installed Cursor provider is a silent no-op: `includeCursor` defaults to true, so
	 * warning there nagged every user who never wanted Cursor at all.
	 */
	async function refreshCursorSlots(
		auth: Record<string, AuthEntry>,
		ctx?: any,
		explicit = false,
	) {
		if (!config.includeCursor) return;
		if (!explicit && !isCursorProviderInstalled()) return;
		const slotIds = [
			...new Set([
				...Object.keys(auth).filter(
					(id) =>
						isCursorProviderId(id) && id !== CURSOR_BASE && isEntryUsable(auth[id]),
				),
				...[...registeredSlots].filter(
					(id) => isCursorProviderId(id) && id !== CURSOR_BASE,
				),
			]),
		].sort((a, b) => slotIndex(a) - slotIndex(b));
		// Cursor lives in a separate repo we do not control, on whatever Node the user runs.
		// A version-incompatible clone (e.g. a JSON import that newer Node rejects) must never
		// escape as a rejected promise: on the automatic path this is fire-and-forget, so it
		// would surface as an unhandled rejection, and inside session_start it aborted the rest
		// of the handler — skipping the pending-resume reset that must run on every session.
		// Cursor is optional; nothing else may be lost because it failed.
		try {
			await setupCursorSubscription(pi, {
				readAuth: readAuthFile,
				rejectDuplicateLogin: (slot, creds) => rejectDuplicateLogin(slot, creds),
				slotIds,
				notify: (message, level) => ctx?.ui?.notify?.(message, level),
				log: (kind, data) => logEvent(kind, data),
				onProvision: (slots, port, models) => {
					// models.json entries point at the running proxy, so a bare child
					// `pi -p` resolves cursor/* while any parent Pi process is alive.
					//
					// The placeholder key is what makes that resolution USABLE. Pi refuses a
					// provider it has no credential for, and Cursor's credential is an OAuth
					// token this extension holds — a child cannot read it. The proxy already
					// treats this exact value as "no token on the request" and falls back to
					// the base slot's stored credential, so the child authenticates to a
					// LOCAL socket with a non-secret string and the real token never leaves
					// the parent. Without it a provisioned slot reports
					// `credentials_not_configured` and every child call dies at auth.
					for (const slot of slots) {
						provisionNativeSlot(slot, {
							api: "openai-completions",
							baseUrl: `http://127.0.0.1:${port}/v1`,
							apiKey: CURSOR_PROXY_PLACEHOLDER_KEY,
							models,
						});
					}
				},
			});
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			logEvent("cursor_setup_failed", { reason });
			// Once per process: the user cloned it deliberately, so silence would be wrong —
			// but repeating it on every discovery pass would be nagging. The flag is set only
			// once a notice was really delivered: the first attempt runs from discovery, which
			// has no ctx and therefore no UI to notify, and marking it "notified" there would
			// swallow the message for the session_start attempt that can actually show it.
			if (!cursorSetupFailureNotified && typeof ctx?.ui?.notify === "function") {
				cursorSetupFailureNotified = true;
				ctx.ui.notify(
					`pi-multi-account: built-in Cursor support failed to load, so Cursor accounts are unavailable this session (${reason.slice(0, 160)}). Everything else keeps working; set "includeCursor": false in ${CONFIG_PATH} to silence this.`,
					"warning",
				);
			}
		}
	}

	/** Register authed alias slots plus one spare per family for the next interactive /login. */
	function syncRegisteredSlots(auth: Record<string, AuthEntry>, ctx?: any) {
		// Pi's login menu labels every registered provider that has an auth.json entry
		// as "stored". Rotation already excludes duplicate real accounts, but exposing a
		// redundant OAuth alias here makes the picker look like the user has an extra
		// account and invites a second login into it. Keep the credential on disk (never
		// delete user auth implicitly) while withholding only the duplicate provider slot.
		const duplicateIds = new Set(
			discoverDuplicateSlots(auth).map(({ duplicate }) => duplicate),
		);
		for (const id of duplicateIds) {
			const family = classifyProvider(id, config.qwenProvider);
			// Base providers and Cursor are owned by Pi/its optional companion extension;
			// only unregister aliases that this extension previously registered itself.
			if (!family || family === "cursor" || slotIndex(id) <= 1)
				continue;
			registeredSlots.delete(id);
			pi.unregisterProvider(id);
			unprovisionNativeSlot(id);
		}
		// Cursor is the one family whose provider lives in a separate, optional repo. Unlike
		// anthropic/codex/qwen/ollama — which only ever create slots backed by a real auth
		// entry — cursor used to conjure a spare `cursor-account-2` out of nothing, so /login
		// offered a slot no provider could serve. Only offer cursor slots once the provider
		// is actually on disk.
		const cursorAvailable = config.includeCursor && isCursorProviderInstalled();
		const families: ProviderFamily[] = [
			"anthropic",
			"openai-codex",
			"kimi-coding",
			"antigravity",
			...(cursorAvailable ? (["cursor"] as const) : []),
			"ollama",
			"qwen",
		];
		for (const family of families) {
			const authedIndexes = Object.keys(auth)
				.filter(
					(id) =>
						classifyProvider(id, config.qwenProvider) === family &&
						isEntryUsable(auth[id]),
				)
				.map(slotIndex);
			const wanted = new Set<number>(
				Object.keys(auth)
					.filter(
						(id) =>
							classifyProvider(id, config.qwenProvider) === family &&
							isEntryUsable(auth[id]) &&
							!duplicateIds.has(id),
					)
					.map(slotIndex),
			);
			// For OAuth families, add the next free slot (>=2) so the user can select it
			// from /login. API-key families (ollama/qwen) have no interactive login, so a
			// spare slot with no key would just produce a Pi error ("apiKey or oauth
			// required when defining models") — skip the spare for those families.
			if (
				family === "anthropic" ||
				family === "openai-codex" ||
				family === "kimi-coding" ||
				family === "antigravity" ||
				family === "cursor"
			) {
				let spare = 2;
				// A redundant credential remains in auth.json for explicit user cleanup. Do
				// not reuse its number for the spare slot, or Pi would immediately render the
				// hidden duplicate as another "stored" login target.
				while (
					authedIndexes.includes(spare) &&
					spare <= config.maxAccountsPerProvider
				)
					spare++;
				if (spare <= config.maxAccountsPerProvider) wanted.add(spare);
			}
			for (const index of wanted) {
				const id = slotId(family, index, config.qwenProvider);
				const entry = auth[id];
				const usagePlan =
					cachedUsage(id)?.plan ?? usageByProvider.get(id)?.plan;
				const displayName = formatSlotDisplayName(
					id,
					entry,
					family,
					usagePlan,
				);

				if (index === 1) {
					if (family === "anthropic") {
						pi.registerProvider("anthropic", {
							name: displayName,
							oauth: anthropicOAuthOverride("anthropic", displayName),
						} as any);
					} else if (family === "openai-codex") {
						pi.registerProvider("openai-codex", {
							name: displayName,
							oauth: codexOAuthOverride("openai-codex", displayName),
						} as any);
					} else if (family === "antigravity") {
						registerAntigravitySlot(pi, "antigravity", displayName);
					}
					continue;
				}

				if (family === "cursor") {
					if (!registeredSlots.has(id)) registeredSlots.add(id);
					continue;
				}
				// An api-key slot registered before a ctx existed carries only the built-in tag.
				// Once the host registry is reachable its models must be folded in, so those slots
				// are re-registered whenever the host set changes rather than skipped forever.
				if (registeredSlots.has(id)) {
					if (!ctx || (family !== "ollama" && family !== "qwen")) continue;
					const base = family === "ollama" ? OLLAMA_BASE : config.qwenProvider;
					const signature = hostModelIdsFor(ctx, base).join(",");
					if (apiKeySlotHostSignature.get(id) === signature) continue;
					apiKeySlotHostSignature.set(id, signature);
				}
				if (family === "anthropic")
					registerAnthropicSlot(pi, id, undefined, displayName);
				else if (family === "openai-codex") {
					const cached = codexModelCatalogByProvider.get(id)?.models;
					registerCodexSlot(
						pi,
						id,
						config.autoDiscoverModels && cached?.length
							? (cached as Array<Record<string, unknown>>)
							: undefined,
						displayName,
					);
				} else if (family === "antigravity") {
					registerAntigravitySlot(pi, id, displayName);
				} else if (family === "kimi-coding") {
					const kimiModels = [
						...new Set([...DEFAULT_KIMI_MODELS, ...hostModelIdsFor(ctx, KIMI_BASE)]),
					];
					registerKimiSlot(pi, id, kimiModels, displayName);
					// Provision into Pi's native registry so an extension-free child can RESOLVE the
					// slot by name. That is all this buys: measured 2026-08-24, such a child then
					// fails with "No API key found", because Pi honours an OAuth credential only
					// for a provider definition that declares the flow and a models.json entry
					// declares none. Making the slot genuinely usable needs the Cursor pattern — a
					// parent-owned loopback route with a non-secret placeholder — which Kimi does
					// not have yet. See child-usability.ts.
					provisionNativeSlot(id, {
						api: "anthropic-messages",
						baseUrl: KIMI_BASE_URL,
						models: kimiModels.map((modelId) => kimiModelDef(modelId, id)),
					});
				} else if (family === "ollama" || family === "qwen") {
					registerApiKeySlot(
						pi,
						id,
						family,
						config.qwenProvider,
						ctx,
						displayName,
					);
				}
				registeredSlots.add(id);
			}
		}
		if (cursorAvailable) cursorReady = refreshCursorSlots(auth);
	}

	function reloadHostAuth(ctx: any) {
		try {
			ctx?.modelRegistry?.authStorage?.reload?.();
		} catch {
			// A malformed or concurrently replaced auth file is handled by the next poll.
		}
	}

	function refreshDiscovery(force = false, ctx?: any): boolean {
		if (ctx) reloadHostAuth(ctx);
		const mtime = authMtimeMs();
		if (!force && mtime === lastAuthMtime) return false;
		lastAuthMtime = mtime;
		const auth = readAuthFile();
		let cooldownsCleared = false;
		for (const provider of new Set([
			...credentialHashes.keys(),
			...Object.keys(auth),
		])) {
			const entry = auth[provider];
			const nextHash = entry ? credentialHash(entry) : undefined;
			const previousHash = credentialHashes.get(provider);
			const nextIdentity = entry ? stableAccountFingerprint(entry) : undefined;
			const previousIdentity = credentialIdentities.get(provider);
			// A routine OAuth refresh rotates the access token (hash changes) but the real account
			// is unchanged, so its rate-limit cooldown MUST survive. Only drop the cooldown when the
			// slot is re-logged into a DIFFERENT real account (stable fingerprint changed) — a token
			// rotation never lifts a server-side limit.
			if (previousIdentity && nextIdentity && nextIdentity !== previousIdentity) {
				if (exhaustedUntilByProvider.delete(provider)) cooldownsCleared = true;
				// Model availability is account/plan-specific. Never let a newly logged-in account
				// inherit the previous account's five-minute catalog snapshot for this slot.
				if (codexModelCatalogByProvider.delete(provider)) cooldownsCleared = true;
				// A different real account also clears any stale 401-streak tracking: the new
				// account's credentials are unrelated to the old failures.
				authFailures.delete(provider);
				exhaustedUntilByModel.forEach((_until, key) => {
					if (key.startsWith(`${provider}/`)) {
						exhaustedUntilByModel.delete(key);
						cooldownsCleared = true;
					}
				});
			}
			// The usage snapshot is tied to the token, so refresh it whenever the credential blob
			// changes (cheap to re-fetch, and never used to gate availability).
			// For non-refreshable (API-key) providers, a credential change means the user manually
			// replaced the key (re-login) — stale 401-streak tracking is irrelevant and must be
			// cleared so the new key gets a fresh start. For OAuth providers, a hash change is a
			// routine token refresh by Pi; the 401 streak MUST survive so rotated-token failures
			// can still accumulate toward the kill threshold. Rate-limit cooldowns are NOT
			// cleared here (they are server-side limits tied to the account, not the token).
			if (previousHash && nextHash !== previousHash) {
				usageByProvider.delete(provider);
				usageErrors.delete(provider);
				const refreshable =
					!!entry && typeof entry.refresh === "string" && entry.refresh.length > 0;
				if (!refreshable) authFailures.delete(provider);
			}
			if (nextHash) credentialHashes.set(provider, nextHash);
			else credentialHashes.delete(provider);
			if (nextIdentity) credentialIdentities.set(provider, nextIdentity);
			else credentialIdentities.delete(provider);
		}
		if (cooldownsCleared) persist();
		clearReauthedInvalidations(auth);
		syncRegisteredSlots(auth, ctx);
		// After the slots exist: learn the host's Codex model list, so a flagship that shipped
		// with Pi (and not with this extension) is selectable and preferred on every slot.
		if (ctx) {
			refreshRegistryCodexModels(ctx);
			refreshRegistryAnthropicModels(ctx);
		}
		duplicateSlots = discoverDuplicateSlots(auth);
		rotation = discoverRotation(auth);
		return true;
	}

	function activeFallbacks(): string[] {
		const auth = readAuthFile();
		const source = config.autoDiscover
			? [...configuredFallbacks, ...rotation]
			: configuredFallbacks.length > 0
				? configuredFallbacks
				: rotation;
		const result: string[] = [];
		const seenTargets = new Set<string>();
		const seenAccounts = new Set<string>();
		for (const target of source) {
			const parsed = parseTarget(target);
			if (!parsed) continue;
			const normalized = parsed.modelId
				? `${parsed.provider}/${parsed.modelId}`
				: parsed.provider;
			if (seenTargets.has(normalized)) continue;
			const entry = auth[parsed.provider];
			const identity = entry ? accountIdentity(entry) : undefined;
			if (identity && seenAccounts.has(identity)) continue;
			seenTargets.add(normalized);
			if (identity) seenAccounts.add(identity);
			result.push(normalized);
		}
		return result;
	}

	// ----- fallback selection ----------------------------------------------

	function providerHasUsableAuth(ctx: any, provider: string) {
		const entry = readAuthFile()[provider];
		if (entry) return isEntryUsable(entry);
		try {
			return (
				ctx.modelRegistry.authStorage?.hasAuth?.(provider) ??
				ctx.modelRegistry.getProviderAuthStatus?.(provider)?.configured ??
				true
			);
		} catch {
			return true;
		}
	}

	// Newest-first preferred model list for a family. A per-family config override
	// (preferredModels) wins so a new flagship can be pinned without a code change.
	function familyPreferredModels(family: string | undefined): string[] {
		if (!family) return [];
		const configured = config.preferredModels[family];
		if (configured && configured.length > 0) return configured;
		const defaults =
			family === "anthropic"
				? registryAnthropicModelOrder.length > 0
					? registryAnthropicModelOrder
					: DEFAULT_ANTHROPIC_MODELS
				: family === "openai-codex"
					? discoveredCodexModelOrder.length > 0
						? discoveredCodexModelOrder
						: registryCodexModelOrder.length > 0
							? registryCodexModelOrder
							: DEFAULT_CODEX_MODELS
					: family === "kimi-coding"
						? DEFAULT_KIMI_MODELS
						: family === "ollama"
							? DEFAULT_OLLAMA_MODELS
							: family === "qwen"
								? DEFAULT_QWEN_MODELS
								: family === "cursor"
									? DEFAULT_CURSOR_MODELS
									: [];
		const last = lastModelByFamily[family];
		if (!last) return defaults;
		return [last, ...defaults.filter((id) => id !== last)];
	}

	// Rank of a model within its family's newest-first preferred order (0 = newest).
	// Unknown models sort last. Used to keep the latest model across accounts, not
	// just within one account, during fallback ranking.
	function modelRecencyRank(model: any): number {
		const family = classifyProvider(model?.provider, config.qwenProvider);
		const order = familyPreferredModels(family);
		const idx = order.findIndex((id) => sameModelIdentity(id, model?.id));
		return idx < 0 ? Number.MAX_SAFE_INTEGER : idx;
	}

	function resolveTargets(
		ctx: any,
		target: string,
		currentModel: any,
		preferredOnly = false,
	) {
		const parsed = parseTarget(target);
		if (!parsed) return [];
		if (parsed.modelId) {
			const model = findModelIncludingHidden(ctx, parsed.provider, parsed.modelId);
			return model ? [model] : [];
		}

		const family = classifyProvider(parsed.provider, config.qwenProvider);
		const currentFamily = currentModel?.provider
			? classifyProvider(currentModel.provider, config.qwenProvider)
			: undefined;
		const sameFamily = !!family && !!currentFamily && family === currentFamily;
		// A per-family config override (preferredModels) wins, so a new flagship model can be
		// pinned without a code change. Order is newest-first either way.
		const preferred = familyPreferredModels(family);
		const keepCurrent = sameFamily && currentModel?.id ? [currentModel.id] : [];
		// `preferredOnly` means "take this family's flagship, not an arbitrary model". A provider
		// outside the managed families has no flagship list at all, so honouring it literally
		// yields no candidate and the switch fails — which is what made an unmanaged account
		// unreachable by name. Fall back to what Pi knows for it.
		const usePreferredOnly = preferredOnly && preferred.length > 0;
		const registryModels = usePreferredOnly
			? []
			: [
					...ctx.modelRegistry
						.getAll()
						.filter((model: any) => model.provider === parsed.provider),
					...(hiddenProviderModels.get(parsed.provider) ?? []),
				].map((model: any) => model.id);
		// preferLatestModel (default): try the newest preferred model FIRST, so a turn that was
		// once downgraded (e.g. gpt-5.4 after a momentary limit on gpt-5.5) is upgraded back to
		// the latest the moment it is available again — instead of carrying the old model forever.
		// Legacy mode keeps the current model first (never changes the model unless it has to).
		const modelIds = config.preferLatestModel
			? [...preferred, ...keepCurrent, ...registryModels]
			: [...keepCurrent, ...preferred, ...registryModels];
		const result: any[] = [];
		const seen = new Set<string>();
		for (const modelId of modelIds) {
			if (seen.has(modelId)) continue;
			const model = findModelIncludingHidden(ctx, parsed.provider, modelId);
			if (!model) {
				seen.add(modelId);
				continue;
			}
			if (seen.has(model.id)) continue;
			seen.add(modelId);
			seen.add(model.id);
			result.push(model);
		}
		return result;
	}

	/**
	 * Return fallback models in deterministic rotation order.
	 * Immediate failover only receives accounts whose known cooldown has expired.
	 */
	function findFallbackModels(
		ctx: any,
		currentModel: any,
		options: {
			availableNowOnly?: boolean;
			includeCurrent?: boolean;
			manualRoundRobin?: boolean;
			excludeProviders?: Set<string>;
			/**
			 * Automatic failover: try another account that still has THIS model (and family)
			 * before jumping to a different model. `best` turns this off so confirmation still
			 * outranks an unmeasurable sibling.
			 */
			preferSameIdentity?: boolean;
		} = {},
	) {
		reconcileCooldownsFromUsage(ctx);
		pruneCooldowns();
		// Cheap and idempotent: guarantees the newest Codex generation the host knows about is
		// ranked first at the exact moment we choose a fallback, even if no session_start ran.
		refreshRegistryCodexModels(ctx);
		refreshRegistryAnthropicModels(ctx);
		const fallbacks = activeFallbacks();
		if (fallbacks.length === 0) return [];

		const now = Date.now();

		type Scored = {
			model: any;
			remaining: number;
			rotIndex: number;
			rank: number;
			/** When this account last refused with a limit error. 0 = never, in this session. */
			lastRefusalAt: number;
			/**
			 * Whether the UNCAPPED forecast still considers this account spent. The recheck ceiling
			 * decides whether an account may be tried at all; this decides the ORDER. An account
			 * nothing predicts as spent is always tried before one we are only re-probing because
			 * its forecast went stale.
			 */
			predictedBusy: boolean;
			/**
			 * The provider itself said this account is usable, recently enough to believe.
			 *
			 * Distinct from "we hold no cooldown for it": that is absence of evidence, which is what
			 * an account with no usage endpoint at all always looks like. Treating the two as equal
			 * let an unmeasurable, out-of-quota account beat a measured, confirmed one.
			 */
			confirmed: boolean;
			/** Provider group this candidate belongs to — what the priority ladder ranks. */
			group: string;
			/** Same provider family (or un-numbered base) as the account that just failed. */
			sameFamily: boolean;
			/** Same model identity, including effort-folded Cursor ids. */
			sameModel: boolean;
		};
		// When preferLatestModel is on, the newest model wins ACROSS accounts — not just
		// within one account. Without this, failing over from gpt-5.5 could land on the
		// same account's older gpt-5.4 (lower rotIndex) instead of gpt-5.5 on a healthy
		// account, silently downgrading the model. rank is the primary tiebreak.
		const byRankThenRot = (a: Scored, b: Scored) =>
			(config.preferLatestModel ? a.rank - b.rank : 0) || a.rotIndex - b.rotIndex;
		const scored: Scored[] = [];
		const seen = new Set<string>();

		for (let i = 0; i < fallbacks.length; i++) {
			// HARD RULE (never auto-downgrade the model): each account contributes exactly ONE
			// candidate — its newest/flagship model. We must NOT enumerate an account's older or
			// "mini" models as separate rotation targets, or `/multi-account next` ping-pongs
			// between e.g. gpt-5.4 ↔ gpt-5.4-mini and one chatty provider drowns out the others.
			// resolveTargets returns this account's models newest-first, so models[0] is the flagship.
			const models = resolveTargets(ctx, fallbacks[i], currentModel).filter(
				(model: any) =>
					!options.excludeProviders?.has(model.provider) &&
					!isInvalidated(model.provider) &&
					providerHasUsableAuth(ctx, model.provider),
			);
			if (models.length === 0) continue;
			// Prefer the newest model that is not itself on a MODEL-level cooldown (a genuine
			// "model unavailable" error is the only sanctioned reason to fall to an older model).
			// A provider-level usage limit never demotes the model here: the flagship stays the
			// representative and the whole account simply cools — so we resume at the flagship, on
			// another account, instead of quietly dropping to a weaker model of the same account.
			const notModelCooled = (model: any) =>
				(exhaustedUntilByModel.get(`${model.provider}/${model.id}`) ?? 0) <= now;
			const flagshipPick = models.find(notModelCooled) ?? models[0];
			const currentId = currentModel?.id as string | undefined;
			const sameFamily =
				!!currentModel?.provider &&
				accountGroup(models[0].provider, config.qwenProvider) ===
					accountGroup(currentModel.provider, config.qwenProvider);
			const identityPick =
				options.preferSameIdentity !== false && sameFamily && currentId
					? models.find(
							(model: any) =>
								notModelCooled(model) && sameModelIdentity(model.id, currentId),
						)
					: undefined;
			let pick = flagshipPick;
			if (identityPick) {
				const flagRank = modelRecencyRank(flagshipPick);
				const idRank = modelRecencyRank(identityPick);
				// preferLatestModel still upgrades a known older sibling (gpt-5.4 → gpt-5.5)
				// on a healthy account. An unranked catalog leftover (claude-4-sonnet beating
				// grok only because it sorts first) must never steal the user's model.
				const upgrade =
					config.preferLatestModel &&
					idRank !== Number.MAX_SAFE_INTEGER &&
					flagRank < idRank;
				pick = upgrade ? flagshipPick : identityPick;
			}
			// Leaving the current account: skip it (we only ever re-offer it via the round-robin
			// wrap-around below). Excluding by the *representative* — never by the raw current
			// model — is what stops a weaker same-account model from bubbling up as a downgrade.
			// Equivalent ids (`cursor-grok-4.6-high` vs folded `cursor-grok-4.6`) are the same
			// account still, so they must not look like a destination.
			if (
				!options.includeCurrent &&
				pick.provider === currentModel?.provider &&
				(pick.id === currentModel?.id ||
					sameModelIdentity(pick.id, currentModel?.id))
			)
				continue;
			if (seen.has(pick.provider)) continue;
			seen.add(pick.provider);

			const key = `${pick.provider}/${pick.id}`;
			const providerUntil = providerRecoveryAt(pick.provider, now);
			const modelUntil = exhaustedUntilByModel.get(key) ?? 0;
			const remaining = Math.max(0, Math.max(providerUntil, modelUntil) - now);
			const group = accountGroup(pick.provider, config.qwenProvider);
			const currentGroup = currentModel?.provider
				? accountGroup(currentModel.provider, config.qwenProvider)
				: "";
			scored.push({
				model: pick,
				remaining,
				rotIndex: i,
				rank: modelRecencyRank(pick),
				lastRefusalAt: limitStreakByProvider.get(pick.provider)?.lastAt ?? 0,
				confirmed: isConfirmedAvailable(pick.provider, now),
				predictedBusy:
					providerRecoveryAt(pick.provider, now, { ignoreCeiling: true }) > now,
				group,
				sameFamily: !!currentGroup && group === currentGroup,
				sameModel:
					!!currentGroup &&
					group === currentGroup &&
					sameModelIdentity(pick.id, currentModel?.id),
			});
		}
		if (scored.length === 0) return [];

		// Manual `/multi-account next`: walk the rotation forward from the current account,
		// wrapping around, so repeated presses cycle through EVERY account. This is an explicit user
		// override: quota/cooldown metadata may be stale after an early provider reset, purchased
		// credits, or a plan upgrade, so it must never reorder the manual ring or permanently starve
		// an account. Automatic failover still prefers accounts known to be available right now.
		if (options.manualRoundRobin) {
			const n = fallbacks.length;
			const currentRotIndex = currentModel?.provider
				? fallbacks.findIndex(
						(t) => parseTarget(t)?.provider === currentModel.provider,
					)
				: -1;
			const forwardDistance = (rotIndex: number) =>
				currentRotIndex < 0 ? rotIndex : (rotIndex - currentRotIndex + n) % n || n;
			const byDistance = (a: Scored, b: Scored) =>
				forwardDistance(a.rotIndex) - forwardDistance(b.rotIndex);
			let ordered = [...scored].sort(byDistance);
			if (
				lastLeftProvider &&
				now - lastLeftAt < ANTI_PINGPONG_MS &&
				ordered.length > 1 &&
				ordered[0].model.provider === lastLeftProvider
			) {
				ordered = [...ordered.slice(1), ordered[0]];
			}
			return ordered.map((s) => s.model);
		}

		// Among accounts that are selectable right now, prefer the one that refused LONGEST ago —
		// an account that just answered "usage limit reached" is the least likely to answer
		// differently seconds later, no matter how good its position or model rank is. Without this
		// the rotation order alone could send us straight back to the account we just left, get the
		// same refusal, and loop between two spent accounts while a live one sat further down.
		const byRefusalAgeThenRank = (a: Scored, b: Scored) =>
			// Exhaustion of one account must try a sibling of the SAME family (same model first,
			// otherwise that account's flagship, same thinking level) before any other family.
			// A 100% usage forecast must not skip those siblings in favour of Claude — the live
			// hop openai-codex/gpt-5.6-sol → anthropic/claude-opus-5 was that skip. Predicted-busy
			// only orders siblings relative to each other, after family has already won.
			(options.preferSameIdentity !== false
				? Number(b.sameModel) - Number(a.sameModel) ||
					Number(b.sameFamily) - Number(a.sameFamily)
				: 0) ||
			Number(b.confirmed) - Number(a.confirmed) ||
			Number(a.predictedBusy) - Number(b.predictedBusy) ||
			// Every account of the family is spent — the step that had no policy at all. Of 602
			// automatic failovers in the black box, 588 stayed inside the family and the other 14
			// scattered across five different destinations, because nothing above rotation index
			// expressed a preference and the index almost never got a say.
			//
			// It sits BELOW the two liveness signals on purpose, and an earlier draft that put it
			// above them was wrong: evidence about a specific account has to beat a preference
			// about its category, or a group ranked first would pull work onto an account the
			// provider has already reported as spent while a live one waited. Two existing tests
			// said so before this comment did. What is left for the ladder is exactly the case
			// that was arbitrary — candidates the telemetry cannot separate — where it replaces
			// "whoever refused longest ago, then whatever order discovery happened to produce"
			// with a stated answer.
			comparePriority(a.group, b.group, config.providerPriority) ||
			a.lastRefusalAt - b.lastRefusalAt ||
			byRankThenRot(a, b);
		let availableNow = scored
			.filter((s) => {
				if (s.remaining === 0) return true;
				// Same-family sibling that has not refused this session: a 100% usage forecast
				// used to drop it from the candidate list, so failover jumped family (Codex →
				// Opus) without ever asking the other Codex slots. An actual limit-error
				// cooldown still excludes it (lastRefusalAt) so we do not ping-pong.
				// The current account itself is never admitted this way — a different model id
				// on the same spent slot would otherwise look like a destination and preflight
				// would keep a dead pin alive.
				return (
					options.preferSameIdentity !== false &&
					s.sameFamily &&
					s.lastRefusalAt === 0 &&
					s.model.provider !== currentModel?.provider
				);
			})
			.sort(byRefusalAgeThenRank);
		if (
			lastLeftProvider &&
			now - lastLeftAt < ANTI_PINGPONG_MS &&
			availableNow.length > 1
		) {
			const otherProvider = availableNow.filter(
				(s) => s.model.provider !== lastLeftProvider,
			);
			if (otherProvider.length > 0) availableNow = otherProvider;
		}
		if (availableNow.length > 0) return availableNow.map((s) => s.model);

		if (options.availableNowOnly) return [];
		return scored
			.sort((a, b) => a.remaining - b.remaining || byRefusalAgeThenRank(a, b))
			.map((s) => s.model);
	}

	/**
	 * Say where a manual selection actually landed, and what we believe about that account.
	 *
	 * `next` walks the ring regardless of cooldowns, so it can legitimately land on an account we
	 * think is spent. Saying so turns a confusing silent double-switch — land on a cooled account,
	 * get moved off it a second later — into one honest sentence, and it also reserves the one
	 * attempt that lets the user prove our bookkeeping wrong.
	 */
	function announceManualChoice(ctx: any) {
		const model = ctx.model;
		if (!model?.provider || !model?.id) return;
		pinManualChoice(model.provider);
		const now = Date.now();
		const until = providerRecoveryAt(model.provider, now, {
			ignoreCeiling: true,
		});
		const spent = until > now;
		// Quote the forecast AND the guarantee that limits it. The raw number alone — "cooling
		// down, ~672h left" — reads as a four-week lockout, when the account is in fact re-asked
		// within `maxRecheckIntervalMs` no matter what the forecast says. Someone reading only the
		// forecast concludes the extension has written the account off for a month and stopped
		// picking up accounts that freed up, which is the opposite of what it does.
		ctx.ui.notify(
			spent
				? `pi-multi-account: switched to ${model.provider}/${model.id} — its quota forecast still says spent (~${formatUntil(until)}), but a forecast is not a verdict: it is tried right now, and re-checked at least every ${formatDelay(config.maxRecheckIntervalMs)} regardless`
				: `pi-multi-account: switched to ${model.provider}/${model.id}`,
			"info",
		);
	}

	async function activateFallback(
		ctx: any,
		sourceModel: any,
		candidates: any[],
		reason: string,
		options: { armContinuation?: boolean; announceSwitch?: boolean } = {},
	) {
		const from =
			sourceModel?.provider && sourceModel?.id
				? ref(sourceModel.provider, sourceModel.id)
				: ("unavailable/account" as ModelRef);
		const failedProviders = new Set<string>();
		for (const fallback of candidates) {
			if (failedProviders.has(fallback.provider)) continue;
			const to = ref(fallback.provider, fallback.id);
			if (to === from) {
				markExhausted(fallback.provider, config.transientCooldownMs);
				failedProviders.add(fallback.provider);
				continue;
			}
			let ok = true;
			if (
				ctx.model?.provider !== fallback.provider ||
				ctx.model?.id !== fallback.id
			) {
				automaticModelTarget = to;
				try {
					ok = await setModelEnsuringVisible(fallback, ctx);
				} catch {
					ok = false;
				}
				if (!ok && automaticModelTarget === to) automaticModelTarget = undefined;
			}
			if (!ok) {
				reloadHostAuth(ctx);
				refreshDiscovery(true, ctx);
				if (providerHasUsableAuth(ctx, fallback.provider)) {
					automaticModelTarget = to;
					try {
						ok = await setModelEnsuringVisible(fallback, ctx);
					} catch {
						ok = false;
					}
					if (!ok && automaticModelTarget === to) automaticModelTarget = undefined;
				}
			}
			if (!ok) {
				ctx.ui.notify(
					`Provider failover: ${to} could not be activated; skipping it briefly`,
					"warning",
				);
				// A setModel failure is not a quota/rate-limit and must not receive the normal
				// multi-hour cooldown. Still cool it briefly so a broken or half-logged-in slot
				// does not get retried on every failover attempt.
				markExhausted(fallback.provider, config.transientCooldownMs);
				failedProviders.add(fallback.provider);
				continue;
			}
			restoreDesiredThinking(ctx);
			applyOnlyActiveFilter(ctx, fallback.provider);
			if (options.armContinuation !== false) {
				pinFailoverProbe(fallback.provider);
			}
			const record = { from, to, reason, at: Date.now() };
			currentPromptSwitch = options.armContinuation === false ? undefined : record;
			logEvent("switch", { from, to, reason });
			pi.appendEntry("provider-failover", record);
			persist({
				lastSwitches: [record, ...(persistedState.lastSwitches ?? [])].slice(0, 20),
			});
			if (options.announceSwitch !== false) {
				ctx.ui.notify(
					`Provider failover [v${VERSION}]: ${from} → ${to} (${reason})`,
					"warning",
				);
			}
			return true;
		}
		return false;
	}

	async function switchToFallback(
		ctx: any,
		failedModel: any,
		reason: string,
		cooldownMs = config.cooldownMs,
		options: { manual?: boolean; scope?: "provider" | "model" } = {},
	) {
		if (!config.enabled || !failedModel?.provider || !failedModel?.id)
			return false;

		if (options.scope === "model") {
			markModelExhausted(failedModel, cooldownMs);
		} else {
			markExhausted(failedModel.provider, cooldownMs);
			lastLeftProvider = failedModel.provider;
			lastLeftAt = Date.now();
		}

		if (
			!options.manual &&
			autoContinuesThisPrompt >= config.maxAutoContinuesPerPrompt
		) {
			ctx.ui.notify(
				`Provider failover: stopped after ${autoContinuesThisPrompt} auto-continues. Send a new message or run /multi-account reset to retry.`,
				"warning",
			);
			return false;
		}

		const excludeProviders = /auth (invalid|failure)/i.test(reason)
			? new Set<string>([failedModel.provider])
			: undefined;
		const candidates = findFallbackModels(ctx, failedModel, {
			availableNowOnly: !options.manual,
			manualRoundRobin: options.manual,
			excludeProviders,
		});
		// No OTHER account to move to. Because each account now offers only its flagship (the
		// never-downgrade rule), a single-account session with a just-cleared cooldown lands here
		// instead of enumerating a weaker sibling model — so this is the path that must resume the
		// current account when usage shows it actually recovered, rather than downgrading.
		if (candidates.length === 0) {
			if (armSameAccountResumeIfReady(ctx, failedModel, reason, options))
				return false;
			const cooldowns = [...exhaustedUntilByProvider.entries()]
				.filter(
					([provider, until]) => until > Date.now() && !isInvalidated(provider),
				)
				.map(([provider, until]) => `${provider}: ${formatUntil(until)}`)
				.join(", ");
			const invalids = [...invalidatedByProvider.keys()].join(", ");
			const availability = [
				cooldowns ? `Cooldowns: ${cooldowns}` : undefined,
				invalids ? `Invalidated (need re-login): ${invalids}` : undefined,
			]
				.filter(Boolean)
				.join(". ");
			logEvent("no_fallback", {
				after: `${failedModel.provider}/${failedModel.id}`,
				availability: availability || "none",
			});
			ctx.ui.notify(
				`Provider failover: no immediately available fallback after ${failedModel.provider}/${failedModel.id}. ${availability || "All known accounts may be unauthenticated, invalidated, or duplicate slots."}`,
				"warning",
			);
			if (!options.manual && config.autoContinue)
				setPendingContinuation(ctx, failedModel, reason);
			return false;
		}

		const switched = await activateFallback(
			ctx,
			failedModel,
			candidates,
			reason,
			{
				armContinuation: !options.manual,
				announceSwitch: !options.manual,
			},
		);
		if (!switched && !options.manual && config.autoContinue) {
			if (!armSameAccountResumeIfReady(ctx, failedModel, reason, options))
				setPendingContinuation(ctx, failedModel, reason);
		}
		return switched;
	}

	// If the account we just failed off is actually READY again (usage reconciliation cleared its
	// cooldown), arm a same-account resume instead of demoting the model or parking a pending wait.
	// Returns true when it armed the resume. Never fires for manual switches.
	function armSameAccountResumeIfReady(
		ctx: any,
		failedModel: any,
		reason: string,
		options: { manual?: boolean } = {},
	): boolean {
		if (options.manual || !config.autoContinue) return false;
		reconcileCooldownsFromUsage(ctx);
		pruneCooldowns();
		if (!isCurrentModelReady(ctx)) return false;
		const target = ref(failedModel.provider, failedModel.id);
		currentPromptSwitch = {
			from: target,
			to: target,
			reason: `${reason} (same account recovered)`,
			at: Date.now(),
		};
		return true;
	}

	function isCurrentModelReady(ctx: any) {
		const model = ctx.model;
		if (!model?.provider || !model?.id) return false;
		if (
			!providerHasUsableAuth(ctx, model.provider) ||
			isInvalidated(model.provider)
		)
			return false;
		const now = Date.now();
		return (
			providerRecoveryAt(model.provider, now) <= now &&
			(exhaustedUntilByModel.get(ref(model.provider, model.id)) ?? 0) <= now
		);
	}

	function rememberUserModel(
		model: { provider?: string; id?: string } | undefined,
	) {
		if (!model?.provider || !model?.id) return;
		const family = classifyProvider(model.provider, config.qwenProvider);
		if (family) lastModelByFamily[family] = model.id;
		persist({
			lastUserModel: { provider: model.provider, id: model.id },
			lastUserThinkingLevel: desiredThinkingLevel ?? readThinkingLevel(),
			lastModelByFamily: { ...lastModelByFamily },
		});
	}

	function intendedStartupModel(): { provider: string; id: string } | undefined {
		const remembered = persistedState.lastUserModel;
		if (remembered?.provider && remembered?.id) return remembered;
		return readHostDefaultModel();
	}

	async function restoreRememberedModel(ctx: any) {
		const intended = intendedStartupModel();
		if (!intended) {
			logEvent("remembered_model_skipped", { reason: "no intended model" });
			return false;
		}
		const alreadyThere =
			ctx.model?.provider === intended.provider && ctx.model?.id === intended.id;
		if (alreadyThere) {
			restoreDesiredThinking(ctx);
			return true;
		}
		if (cursorReady) {
			await cursorReady.catch(() => undefined);
		}
		let found = findModelIncludingHidden(ctx, intended.provider, intended.id);
		if (!found || !providerHasUsableAuth(ctx, intended.provider)) {
			logEvent("remembered_model_unavailable", {
				provider: intended.provider,
				model: intended.id,
				reason: !found ? "not in registry" : "no auth",
			});
			return false;
		}
		const from =
			ctx.model?.provider && ctx.model?.id
				? ref(ctx.model.provider, ctx.model.id)
				: "none";
		const to = ref(intended.provider, intended.id);
		automaticModelTarget = to;
		let ok = false;
		try {
			ok = await setModelEnsuringVisible(found, ctx);
		} catch {
			ok = false;
		}
		if (automaticModelTarget === to) automaticModelTarget = undefined;
		logEvent("remembered_model_restored", {
			from,
			to,
			ok,
			source: persistedState.lastUserModel ? "state" : "settings",
		});
		if (ok) {
			// Restore the user's level too — Pi clamped it to the fallback model's caps
			// while creating the session.
			const rememberedLevel = persistedState.lastUserThinkingLevel;
			if (rememberedLevel) {
				desiredThinkingLevel = rememberedLevel as ReasoningLevel;
			}
			restoreDesiredThinking(ctx);
			ctx.ui?.notify?.(
				`pi-multi-account: restored ${to} after catalog load (Pi had fallen back to ${from})`,
				"info",
			);
		}
		return ok;
	}

	async function ensureReadyModel(ctx: any, reason: string) {
		refreshDiscovery(false, ctx);
		pruneCooldowns();
		const intended = intendedStartupModel();
		const onIntended =
			!!intended &&
			ctx.model?.provider === intended.provider &&
			ctx.model?.id === intended.id;
		// Pi's createAgentSession often parks us on kimi/anthropic because Cursor was not
		// in the registry yet. That fallback is not the user's choice — restore first,
		// otherwise startup preflight failovers *away* from the accidental model.
		if (intended && !onIntended) {
			await restoreRememberedModel(ctx);
		}
		if (isCurrentModelReady(ctx)) return true;
		// The user chose this account by hand and has not spent the attempt yet. Let the request
		// through: our reason for believing it unusable is a forecast, and this is the only way
		// anyone finds out the forecast was stale. Merely being asked about it never spends it —
		// every readiness check of the same message must get the same answer.
		if (hasManualPin(ctx.model?.provider)) {
			markManualPinUsed(ctx.model?.provider);
			return true;
		}
		if (hasFailoverPin(ctx.model?.provider)) {
			markFailoverPinUsed(ctx.model?.provider);
			return true;
		}
		const candidates = findFallbackModels(ctx, ctx.model, {
			availableNowOnly: true,
			includeCurrent: true,
		});
		if (candidates.length === 0) return false;
		return activateFallback(ctx, ctx.model, candidates, reason, {
			armContinuation: false,
		});
	}

	// ----- pending auto-resume ---------------------------------------------

	function hasPendingResume(): boolean {
		return (
			!!(persistedState.pendingFrom && persistedState.pendingReason) ||
			!!persistedState.pendingContinuationPrompt
		);
	}

	// A context-size error (vs. a quota/auth/transient error). Detected against the intrinsic
	// overflow vocabulary so a user override of ignoreErrorPatterns cannot accidentally make us
	// treat "input is too long" as a rotate-able limit (rotating just hands the SAME oversized
	// context to the next account, which overflows again).
	function isContextOverflowError(text: string): boolean {
		if (!text.trim()) return false;
		return patternMatch(text, DEFAULT_IGNORE_PATTERNS);
	}

	// ----- forward-progress watchdog ---------------------------------------
	// A resumed turn (one WE started via continueAgent after a switch) must keep showing
	// activity. Any stream token / tool event / provider response calls noteResumeProgress and
	// disarms the timer. Total silence past stuckWatchdogMs surfaces an actionable recovery
	// instead of an eternal "Working…" spinner. This is a generic net: it catches stalls we
	// never specifically predicted, not just the ones we know about.
	// ----- circuit breaker (reliability floor) -----------------------------
	function isBreakerOpen(): boolean {
		return breakerOpenUntil > Date.now();
	}

	// Any genuine forward progress (a successful provider response / assistant turn) proves
	// recovery is working, so reset the failure streak and close advisory mode.
	function noteRecoveryProgress() {
		if (recoveryFailures !== 0 || breakerOpenUntil !== 0) {
			const wasOpen = breakerOpenUntil > Date.now();
			recoveryFailures = 0;
			breakerOpenUntil = 0;
			if (wasOpen) logEvent("breaker_close", { reason: "forward progress" });
		}
	}

	// A failed auto-recovery (a wedged/aborted resume, a resume that errored out). After
	// BREAKER_FAILURE_THRESHOLD in a row, trip the breaker: pause auto-continue and tell the
	// user we are now only advising manual switches — never hanging on a doomed auto-resume.
	function noteRecoveryFailure(ctx: any) {
		recoveryFailures++;
		logEvent("recovery_failure", { count: recoveryFailures });
		if (recoveryFailures >= BREAKER_FAILURE_THRESHOLD && !isBreakerOpen()) {
			breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
			logEvent("breaker_open", {
				failures: recoveryFailures,
				cooldownMs: BREAKER_COOLDOWN_MS,
			});
			ctx?.ui?.notify?.(
				`pi-multi-account [v${VERSION}]: automatic resume failed ${recoveryFailures}× in a row, so it is pausing auto-continue for ${formatDelay(BREAKER_COOLDOWN_MS)} (safe mode) to avoid making things worse. ` +
					"It still flags rate limits and switches you to a fresh account — just send your next message, or use /multi-account next. (/multi-account reset re-enables auto-continue immediately.)",
				"warning",
			);
		}
	}

	function clearProgressWatchdog() {
		if (progressWatchdogTimer) {
			clearTimeout(progressWatchdogTimer);
			progressWatchdogTimer = undefined;
		}
	}

	function armStuckWatchdog() {
		clearProgressWatchdog();
		if (!resumeInFlight || !config.enabled) return;
		progressWatchdogTimer = setTimeout(
			onResumeStuck,
			Math.max(25, config.stuckWatchdogMs),
		);
		progressWatchdogTimer.unref?.();
	}

	function noteResumeProgress() {
		if (!resumeInFlight) return;
		lastResumeProgressAt = Date.now();
		stuckReminders = 0;
		armStuckWatchdog();
	}

	function beginResumeWatch(ctx: any) {
		resumeInFlight = true;
		watchdogCtx = ctx;
		lastResumeProgressAt = Date.now();
		stuckReminders = 0;
		toolInFlight = 0;
		armStuckWatchdog();
	}

	function endResumeWatch() {
		resumeInFlight = false;
		watchdogCtx = undefined;
		stuckReminders = 0;
		toolInFlight = 0;
		clearProgressWatchdog();
	}

	function onResumeStuck() {
		progressWatchdogTimer = undefined;
		if (!resumeInFlight) return;
		// A timer callback that throws crashes the whole Pi process — the exact "everything
		// dies" failure we are trying to eliminate. Never let anything escape here.
		try {
			const ctx = watchdogCtx;
			// A tool (build/test/long bash) running silently for minutes is NOT stuck. Never
			// abort real work — just re-check later.
			if (toolInFlight > 0) {
				armStuckWatchdog();
				return;
			}
			const silentMs = Date.now() - lastResumeProgressAt;
			const where = ctx?.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: "the active account";
			logEvent("resume_stuck", {
				model: where,
				silentMs,
				action: config.autoRecoverStuck !== false ? "auto_cancel" : "notify",
			});
			let recovery = "";
			try {
				const status = nextRecoveryStatus(ctx);
				if (status) recovery = ` (next recovery ${status})`;
			} catch {
				/* status is best-effort */
			}

			// ACTIVE recovery (default): the wedge is almost always a provider request or a
			// compaction that hung on an exhausted account. Just telling the user to press Esc
			// is not enough — they should not have to babysit it. So we abort the wedged turn
			// ourselves (which unblocks ctx.isIdle) and arm auto-resume; the pending-wake timer
			// then continues the work automatically the moment any account recovers. The abort
			// is flagged so agent_end treats it as recovery, not a user cancel.
			// A wedge is a failed recovery — feed the circuit breaker so repeated wedges drop us
			// to advisory mode instead of aborting/re-resuming forever.
			noteRecoveryFailure(ctx);
			if (config.autoRecoverStuck !== false && typeof ctx?.abort === "function") {
				ctx?.ui?.notify?.(
					`Provider failover [v${VERSION}]: the resumed turn on ${where} has been silent for ${formatDelay(silentMs)} — auto-cancelling it and will resume automatically when an account is free${recovery}. (/multi-account stop to cancel, /multi-account status to inspect.)`,
					"warning",
				);
				watchdogAborting = true;
				// Cool the wedged account briefly so the auto-resume does not immediately re-wedge
				// on the same dead account before usage reconciliation catches up.
				if (ctx.model?.provider)
					markExhausted(ctx.model.provider, config.transientCooldownMs);
				try {
					ctx.abort();
				} catch {
					/* if abort is unavailable, fall through to the reminder path below */
					watchdogAborting = false;
				}
				if (watchdogAborting) return; // agent_end(aborted) will arm the auto-resume
			}

			// Fallback (auto-recover disabled, or no abort available): notify + periodic reminder.
			ctx?.ui?.notify?.(
				`Provider failover: the resumed turn on ${where} has shown no activity for ${formatDelay(silentMs)} and looks stuck${recovery}. ` +
					"Press Esc to cancel it, then /multi-account next to rotate, or /compact to shrink the context.",
				"warning",
			);
			stuckReminders++;
			if (stuckReminders < 5 && resumeInFlight) {
				progressWatchdogTimer = setTimeout(
					onResumeStuck,
					Math.max(25, STUCK_REMINDER_MS),
				);
				progressWatchdogTimer.unref?.();
			}
		} catch {
			/* never crash the host from a watchdog tick */
		}
	}

	// Graceful degradation when a seamless in-place resume is not possible — either the host build
	// predates pi.continueAgent(), or the transcript tail is a completed assistant message that
	// continueAgent() cannot pick up. Inject the continuation prompt as a fresh USER turn so the
	// session keeps moving on the account we just switched to, WITHOUT the user re-typing anything.
	// Bounded by maxAutoContinuesPerPrompt. Returns true when it started a continuation turn.
	function injectContinuationPrompt(
		ctx: any,
		resumeFrom?: { from?: ModelRef; reason?: string },
	): boolean {
		// `currentPromptSwitch` is set ONLY when we actually rotated accounts. The pending-resume
		// path (transient overload, or a cooldown that expired on the same account) deliberately
		// returns to the SAME account, so it never has a switch record. Requiring one here meant
		// that on every host without `pi.continueAgent` — i.e. every pi-coding-agent 0.80.3+,
		// where seamless resume was removed — the pending resume silently refused to inject, and
		// the user had to re-send the prompt by hand. Accept an explicit resume context instead.
		const source = currentPromptSwitch ?? resumeFrom;
		const blocked = !source
			? "no switch or resume context"
			: !config.autoContinue
				? "autoContinue disabled"
				: userAbortedChain
					? "user aborted the chain"
					: ctx.signal?.aborted
						? "abort signal raised"
						: autoContinuesThisPrompt >= config.maxAutoContinuesPerPrompt
							? `auto-continue budget spent (${autoContinuesThisPrompt}/${config.maxAutoContinuesPerPrompt})`
							: typeof pi.sendUserMessage !== "function"
								? "host build has no pi.sendUserMessage"
								: undefined;
		if (blocked) {
			// Every refusal used to be silent, so a session that stopped continuing by itself left
			// nothing in the debug log to explain why. Record the reason.
			logEvent("continuation_injection_blocked", { reason: blocked });
			return false;
		}
		const to =
			currentPromptSwitch?.to ??
			(ctx.model ? ref(ctx.model.provider, ctx.model.id) : "the active account");
		const prompt = config.continuationPrompt
			.replaceAll("{from}", String(source?.from ?? "the previous account"))
			.replaceAll("{to}", String(to))
			.replaceAll("{reason}", source?.reason ?? "provider failover");
		try {
			expectingInjectedContinuation = true;
			// The host throws "Agent is already processing. Specify streamingBehavior ('steer' or
			// 'followUp')" if we inject while the previous turn is still streaming (exactly the race
			// that fires right after a failover switch). The extension-facing option is `deliverAs`
			// (the host maps deliverAs → streamingBehavior internally — see the queued-input resume
			// path below which already uses it). "followUp" QUEUES the continuation to run after the
			// current turn settles instead of being rejected; the host ignores it when not streaming.
			// `sendUserMessage` is async on the host: a rejected promise would otherwise escape this
			// synchronous try/catch as an unhandled rejection AND still report success here.
			const dispatched = pi.sendUserMessage(prompt, {
				deliverAs: "followUp",
			}) as unknown;
			if (
				dispatched &&
				typeof (dispatched as Promise<void>).catch === "function"
			) {
				(dispatched as Promise<void>).catch((error) => {
					expectingInjectedContinuation = false;
					logEvent("continuation_injection_failed", {
						error: String(error).slice(0, 200),
					});
					reportExtensionError("continuation injection", error, ctx);
				});
			}
			autoContinuesThisPrompt++;
			return true;
		} catch (error) {
			expectingInjectedContinuation = false;
			logEvent("continuation_injection_failed", {
				error: String(error).slice(0, 200),
			});
			return false;
		}
	}

	async function resumeWithExistingContext(
		ctx: any,
		// Set by the pending-resume path, which returns to the SAME account and therefore has no
		// `currentPromptSwitch`. Without it the prompt-injection fallback refuses to fire.
		resumeFrom?: { from?: ModelRef; reason?: string },
	): Promise<boolean> {
		if (userAbortedChain || ctx.signal?.aborted) return false;
		const continueAgent = (
			pi as {
				continueAgent?: (options?: {
					stripErrorAssistant?: boolean;
				}) => Promise<void>;
			}
		).continueAgent;
		if (typeof continueAgent !== "function") {
			// Host build predates pi.continueAgent() (seamless in-place resume was added in a later
			// @earendil-works/pi-coding-agent). Do NOT dead-end the failover with a red error that
			// leaves the user reloading by hand: fall back to injecting the continuation prompt so the
			// work resumes by itself on the account we just switched to.
			if (injectContinuationPrompt(ctx, resumeFrom)) return true;
			// Reaching here means the injection fallback ALSO declined — the reason is in the
			// debug log as continuation_injection_blocked/_failed. Do not blame the Pi build:
			// the missing pi.continueAgent is only why we took the fallback path, never why the
			// fallback itself refused.
			ctx.ui.notify(
				`Provider failover [v${VERSION}]: could not auto-resume this turn; send your message to continue on ${
					ctx.model ? ref(ctx.model.provider, ctx.model.id) : "the active account"
				}. Run /multi-account status for the reason.`,
				"warning",
			);
			return false;
		}
		// Bounded wait for the prior turn to go idle — NEVER an unbounded busy-loop. If it does
		// not free up within resumeIdleTimeoutMs we return false; the caller (agent_end or the
		// pending-wake timer) re-arms and tries again, so the session can't wedge here forever.
		if (!ctx.isIdle()) {
			const waitUntil = Date.now() + config.resumeIdleTimeoutMs;
			while (!ctx.isIdle() && !userAbortedChain && !ctx.signal?.aborted) {
				if (Date.now() >= waitUntil) {
					ctx.ui.notify(
						`Provider failover [v${VERSION}]: the previous turn did not go idle within ${formatDelay(config.resumeIdleTimeoutMs)}; auto-retrying the resume in the background.`,
						"warning",
					);
					// Actually schedule the retry instead of just promising it: arm pending
					// auto-resume, which polls until the turn frees up and then continues by
					// itself — the user does not have to re-send the prompt.
					const failed =
						ctx.model?.provider && ctx.model?.id ? ctx.model : undefined;
					if (failed && config.enabled && config.autoContinue)
						setPendingContinuation(ctx, failed, BUSY_RETRY_REASON);
					return false;
				}
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		}
		if (userAbortedChain || ctx.signal?.aborted) return false;
		beginResumeWatch(ctx);
		logEvent("resume_start", {
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown",
			hop: autoContinuesThisPrompt + 1,
		});
		try {
			await continueAgent({ stripErrorAssistant: true });
			autoContinuesThisPrompt++;
			logEvent("resume_ok", {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown",
			});
			return true;
		} catch (error) {
			const text = String(error);
			// A deliberate abort (our watchdog recovery, or the user pressing Esc) is not an error
			// to report — agent_end handles what happens next. Stay silent.
			if (
				watchdogAborting ||
				userAbortedChain ||
				ctx.signal?.aborted ||
				/abort/i.test(text)
			) {
				return false;
			}
			// "Cannot continue from message role: assistant" means the transcript tail is a
			// COMPLETED assistant message (a finished reply OR a turn we aborted for recovery),
			// so continueAgent cannot pick it up.
			if (/cannot continue from message role/i.test(text)) {
				// If a switch/recovery is genuinely in progress, the work is NOT done — inject the
				// continuation prompt as a user message instead. That always starts a turn, so the
				// session keeps moving by itself (this is how auto-recovery after a watchdog abort
				// continues without the user re-typing anything). Bounded by maxAutoContinuesPerPrompt.
				if (injectContinuationPrompt(ctx, resumeFrom)) return true;
				// Nothing to continue (spurious) or injection unavailable — drop stale state quietly.
				currentPromptSwitch = undefined;
				clearPendingContinuation();
				return false;
			}
			noteRecoveryFailure(ctx);
			ctx.ui.notify(
				`Provider failover: could not resume with existing context (${text})`,
				"error",
			);
			return false;
		} finally {
			endResumeWatch();
		}
	}

	async function maybeDispatchContinuation(ctx: any): Promise<boolean> {
		if (
			!config.autoContinue ||
			userAbortedChain ||
			ctx.signal?.aborted ||
			!currentPromptSwitch ||
			autoContinuesThisPrompt >= config.maxAutoContinuesPerPrompt
		)
			return false;
		// Circuit breaker open → advisory mode. The account switch already happened (useful);
		// we just don't attempt the auto-resume that has been failing. The user's next message
		// runs on the fresh account. This is the floor: never worse than switching by hand.
		if (isBreakerOpen()) {
			ctx.ui?.notify?.(
				`Provider failover: switched to ${ctx.model?.provider ?? "a fresh account"} but auto-continue is paused (safe mode after repeated failures). Send your message to continue here, or /multi-account reset to re-enable auto-continue.`,
				"warning",
			);
			return false;
		}
		// Never resume onto an account that is ITSELF cooling down. We may have just switched to a
		// sibling whose 5h limit is also spent (its cooldown only became visible after a usage
		// refresh). Resuming there burns a request and lands us right back here, or wedges
		// compaction on a dead account (the "Working…" hang at high context). Pause instead and
		// let the wake timer resume on the first account that genuinely recovers.
		reconcileCooldownsFromUsage(ctx);
		pruneCooldowns();
		if (!isCurrentModelReady(ctx)) {
			const failed = ctx.model?.provider && ctx.model?.id ? ctx.model : undefined;
			if (failed && config.autoContinue) {
				setPendingContinuation(
					ctx,
					failed,
					currentPromptSwitch?.reason ?? "account is cooling down",
				);
			}
			return false;
		}
		const resumed = await resumeWithExistingContext(ctx);
		if (resumed) continuationDispatchedForAgentTurn = true;
		return resumed;
	}

	function clearPendingContinuation() {
		if (pendingWakeTimer) {
			clearTimeout(pendingWakeTimer);
			pendingWakeTimer = undefined;
		}
		persistedState = {
			...persistedState,
			pendingContinuationPrompt: undefined,
			pendingFrom: undefined,
			pendingSince: undefined,
			pendingReason: undefined,
		};
		persist();
	}

	function pendingWakeProviders(): string[] {
		if (isSameModelResumeReason(persistedState.pendingReason ?? "")) {
			const parsed = persistedState.pendingFrom
				? parseTarget(persistedState.pendingFrom)
				: undefined;
			return parsed?.provider && !isInvalidated(parsed.provider)
				? [parsed.provider]
				: [];
		}
		return [
			...new Set(
				activeFallbacks()
					.map((target) => parseTarget(target)?.provider)
					.filter((p): p is string => !!p),
			),
		].filter((provider) => !isInvalidated(provider));
	}

	function nextPendingWakeDelayMs(): number | undefined {
		const now = Date.now();
		const providers = pendingWakeProviders();
		if (providers.length === 0) return undefined;
		const nextAt = Math.min(...providers.map((p) => providerRecoveryAt(p, now)));
		return Math.max(MIN_PENDING_WAKE_MS, nextAt - now);
	}

	function schedulePendingWake(ctx: any) {
		if (pendingWakeTimer) clearTimeout(pendingWakeTimer);
		pendingWakeTimer = undefined;
		if (
			!hasPendingResume() ||
			userAbortedChain ||
			!config.enabled ||
			!config.autoContinue
		)
			return;
		const delay = nextPendingWakeDelayMs();
		if (delay === undefined) return;
		// Cap the sleep so we re-check availability periodically instead of trusting a single
		// multi-hour estimate. Each poll reconciles cooldowns against fresh usage, so the first
		// account that truly recovers wakes the session.
		pendingWakeTimer = setTimeout(
			() => {
				pendingWakeTimer = undefined;
				runBackground("pending auto-resume", ctx, () => attemptPendingResume(ctx));
			},
			Math.min(delay, config.pendingPollMs),
		);
		pendingWakeTimer.unref?.();
	}

	async function attemptPendingResume(ctx: any) {
		if (
			!hasPendingResume() ||
			userAbortedChain ||
			!config.enabled ||
			!config.autoContinue
		)
			return;
		if (!ctx.isIdle()) {
			schedulePendingWake(ctx);
			return;
		}
		if (autoContinuesThisPrompt >= config.maxAutoContinuesPerPrompt) {
			clearPendingContinuation();
			ctx.ui.notify(
				`Provider failover: pending resume cancelled after ${autoContinuesThisPrompt} auto-continues.`,
				"warning",
			);
			return;
		}

		refreshDiscovery();
		reconcileCooldownsFromUsage(ctx);
		pruneCooldowns();
		const parsedFrom = persistedState.pendingFrom
			? parseTarget(persistedState.pendingFrom)
			: undefined;
		const sourceModel = parsedFrom
			? {
					provider: parsedFrom.provider,
					id: parsedFrom.modelId ?? ctx.model?.id,
				}
			: ctx.model;
		if (!sourceModel?.provider || !sourceModel?.id) {
			clearPendingContinuation();
			return;
		}

		// Transient server errors (overload, 503, websocket) and "still busy" auto-retries are
		// NOT account/model failures: retry the SAME account/model after any brief cooldown —
		// never rotate to a sibling model (which would silently downgrade e.g. gpt-5.5 → gpt-5.4
		// on the same account, whose quota is shared, so the downgrade escapes nothing).
		if (isSameModelResumeReason(persistedState.pendingReason ?? "")) {
			const now = Date.now();
			if (providerRecoveryAt(sourceModel.provider, now) <= now) {
				clearPendingContinuation();
				const same = ref(sourceModel.provider, sourceModel.id);
				if (
					ctx.model?.provider !== sourceModel.provider ||
					ctx.model?.id !== sourceModel.id
				) {
					automaticModelTarget = same;
					if (onlyActiveModels) unhideProvider(sourceModel.provider);
					try {
						await pi.setModel(
							ctx.modelRegistry.find(sourceModel.provider, sourceModel.id) ?? {
								provider: sourceModel.provider,
								id: sourceModel.id,
							},
						);
					} finally {
						if (automaticModelTarget === same) automaticModelTarget = undefined;
					}
				}
				// Same-account resume: no rotation happened, so there is no currentPromptSwitch.
				// Pass the context explicitly or the injection fallback declines and the user has
				// to re-send the prompt by hand.
				await resumeWithExistingContext(ctx, {
					from: same,
					reason: persistedState.pendingReason,
				});
				return;
			}
			schedulePendingWake(ctx);
			return;
		}

		const pendingReason = persistedState.pendingReason ?? "";
		const now = Date.now();
		const sourceRef = ref(sourceModel.provider, sourceModel.id);
		const sourceRecovered =
			!isAuthPendingReason(pendingReason) &&
			providerRecoveryAt(sourceModel.provider, now) <= now &&
			(exhaustedUntilByModel.get(sourceRef) ?? 0) <= now &&
			providerHasUsableAuth(ctx, sourceModel.provider) &&
			!isInvalidated(sourceModel.provider);
		const candidates = findFallbackModels(ctx, sourceModel, {
			availableNowOnly: true,
			includeCurrent: false,
			excludeProviders: isAuthPendingReason(pendingReason)
				? new Set<string>([sourceModel.provider])
				: undefined,
		});
		const otherCandidates = candidates.filter(
			(m: any) => ref(m.provider, m.id) !== sourceRef,
		);
		if (otherCandidates.length === 0) {
			if (sourceRecovered) {
				clearPendingContinuation();
				// The original account came back and there is no alternative: this is also a
				// same-account resume with no switch record.
				await resumeWithExistingContext(ctx, {
					from: sourceRef,
					reason: persistedState.pendingReason,
				});
				return;
			}
			schedulePendingWake(ctx);
			return;
		}

		const reason = persistedState.pendingReason ?? "account cooldown expired";
		const switched = await activateFallback(
			ctx,
			sourceModel,
			otherCandidates,
			reason,
		);
		if (!switched || !currentPromptSwitch) {
			schedulePendingWake(ctx);
			return;
		}
		clearPendingContinuation();
		await maybeDispatchContinuation(ctx);
	}

	function setPendingContinuation(ctx: any, failedModel: any, reason: string) {
		const from = ref(failedModel.provider, failedModel.id);
		const alreadyPending = hasPendingResume();
		persistedState = {
			...persistedState,
			pendingReason: reason,
			pendingFrom: from,
			pendingContinuationPrompt: undefined,
			pendingSince: persistedState.pendingSince ?? Date.now(),
		};
		persist();
		const delay = nextPendingWakeDelayMs();
		if (delay === undefined) {
			clearPendingContinuation();
			if (!alreadyPending) {
				ctx.ui.notify(
					"Provider failover: no recoverable account is available; automatic resume is stopped.",
					"warning",
				);
			}
			return;
		}
		schedulePendingWake(ctx);
		if (!alreadyPending) {
			const busy = isBusyRetryPendingReason(reason);
			const transient = isTransientPendingReason(reason);
			ctx.ui.notify(
				busy
					? `Provider failover [v${VERSION}]: the previous turn is still busy on ${failedModel.provider}/${failedModel.id}. Resuming the SAME model in ~${formatDelay(delay)} (re-checks every ${formatDelay(config.pendingPollMs)}) — it will not be downgraded. Esc, a new message, or /multi-account stop cancels it.`
					: transient
						? `Provider failover: temporary server error on ${failedModel.provider}. Retrying the same account in ~${formatDelay(delay)} (re-checks every ${formatDelay(config.pendingPollMs)}). Esc, a new message, or /multi-account stop cancels it.`
						: `Provider failover: all accounts are cooling down. This session will retry automatically in ~${formatDelay(delay)} (and re-checks every ${formatDelay(config.pendingPollMs)}). Esc during a run, a new user message, /multi-account stop, or leaving the session cancels it.`,
				"warning",
			);
		}
	}

	// ----- cold-start input hold -------------------------------------------

	function clearQueuedInputs() {
		if (queuedInputWakeTimer) {
			clearTimeout(queuedInputWakeTimer);
			queuedInputWakeTimer = undefined;
		}
		queuedUserInputs.length = 0;
	}

	function nextModelAvailabilityDelayMs(ctx: any): number | undefined {
		const candidates = findFallbackModels(ctx, ctx.model, {
			includeCurrent: true,
		});
		if (candidates.length === 0) return undefined;
		const now = Date.now();
		const nextAt = Math.min(
			...candidates.map((model: any) => {
				const modelUntil =
					exhaustedUntilByModel.get(ref(model.provider, model.id)) ?? now;
				return Math.max(providerRecoveryAt(model.provider, now), modelUntil);
			}),
		);
		return Math.max(MIN_PENDING_WAKE_MS, nextAt - now);
	}

	function queuedInputContent(input: { text: string; images?: any[] }) {
		if (!input.images?.length) return input.text;
		return [{ type: "text", text: input.text }, ...input.images];
	}

	function scheduleQueuedInputWake(ctx: any) {
		if (queuedInputWakeTimer) clearTimeout(queuedInputWakeTimer);
		if (queuedUserInputs.length === 0 || userAbortedChain || !config.enabled) {
			queuedInputWakeTimer = undefined;
			return;
		}
		const availabilityDelay = nextModelAvailabilityDelayMs(ctx);
		if (availabilityDelay === undefined) {
			queuedInputWakeTimer = undefined;
			return;
		}
		// Poll auth.json too, so a /login in another Pi process wakes this session quickly
		// instead of waiting for a multi-hour quota cooldown.
		const delay = Math.min(availabilityDelay, AUTH_CHANGE_POLL_MS);
		queuedInputWakeTimer = setTimeout(() => {
			queuedInputWakeTimer = undefined;
			runBackground("queued input resume", ctx, () =>
				attemptQueuedInputResume(ctx),
			);
		}, delay);
		queuedInputWakeTimer.unref?.();
	}

	async function attemptQueuedInputResume(ctx: any) {
		if (queuedUserInputs.length === 0 || userAbortedChain || !config.enabled)
			return;
		if (!ctx.isIdle()) {
			scheduleQueuedInputWake(ctx);
			return;
		}
		reconcileCooldownsFromUsage(ctx);
		const ready = await ensureReadyModel(
			ctx,
			"queued input: account became available",
		);
		if (!ready) {
			scheduleQueuedInputWake(ctx);
			return;
		}
		const inputs = queuedUserInputs.splice(0);
		if (queuedInputWakeTimer) {
			clearTimeout(queuedInputWakeTimer);
			queuedInputWakeTimer = undefined;
		}
		for (let i = 0; i < inputs.length; i++) {
			pi.sendUserMessage(
				queuedInputContent(inputs[i]),
				i === 0 ? undefined : { deliverAs: "followUp" },
			);
		}
		ctx.ui.notify(
			`Provider failover: resumed ${inputs.length} queued message(s) on ${ctx.model.provider}/${ctx.model.id}.`,
			"info",
		);
	}

	function queueUserInput(ctx: any, text: string, images?: any[]) {
		if (queuedUserInputs.length >= MAX_QUEUED_USER_INPUTS) {
			ctx.ui.notify(
				`Provider failover: the automatic wait queue is full (${MAX_QUEUED_USER_INPUTS}); use /multi-account stop before retrying.`,
				"error",
			);
			return;
		}
		queuedUserInputs.push({ text, images });
		const delay = nextModelAvailabilityDelayMs(ctx);
		if (delay === undefined) return;
		scheduleQueuedInputWake(ctx);
		ctx.ui.notify(
			`Provider failover: all usable accounts are cooling down. Your message is held in memory and will be sent automatically in ~${formatDelay(delay)}; /multi-account stop cancels it.`,
			"warning",
		);
	}

	// ----- error classification --------------------------------------------

	function isAuthError(text: string) {
		if (!text.trim()) return false;
		if (patternMatch(text, config.ignoreErrorPatterns)) return false;
		return patternMatch(text, config.authErrorPatterns);
	}

	function isLimitError(text: string) {
		if (!text.trim()) return false;
		if (patternMatch(text, config.ignoreErrorPatterns)) return false;
		return patternMatch(text, config.limitErrorPatterns);
	}

	function isTransientError(text: string) {
		if (!text.trim()) return false;
		if (patternMatch(text, config.ignoreErrorPatterns)) return false;
		return patternMatch(text, config.transientErrorPatterns);
	}

	function isModelError(text: string) {
		if (!text.trim()) return false;
		if (patternMatch(text, config.ignoreErrorPatterns)) return false;
		return patternMatch(text, config.modelErrorPatterns);
	}

	function assistantErrorText(message: any) {
		const parts: string[] = [];
		if (typeof message?.errorMessage === "string")
			parts.push(message.errorMessage);
		for (const diagnostic of Array.isArray(message?.diagnostics)
			? message.diagnostics
			: []) {
			if (typeof diagnostic?.error?.message === "string")
				parts.push(diagnostic.error.message);
			if (diagnostic?.error?.code !== undefined)
				parts.push(String(diagnostic.error.code));
		}
		for (const block of Array.isArray(message?.content) ? message.content : []) {
			if (block?.type === "text" && typeof block.text === "string")
				parts.push(block.text);
		}
		return [...new Set(parts.map((part) => part.trim()).filter(Boolean))].join(
			"\n",
		);
	}

	// ----- command ----------------------------------------------------------

	function clearProviderRuntimeState(provider: string) {
		invalidatedByProvider.delete(provider);
		exhaustedUntilByProvider.delete(provider);
		authFailures.delete(provider);
		usageByProvider.delete(provider);
		usageErrors.delete(provider);
		codexModelCatalogByProvider.delete(provider);
		credentialHashes.delete(provider);
		credentialIdentities.delete(provider);
		registeredSlots.delete(provider);
		for (const key of [...exhaustedUntilByModel.keys()]) {
			if (key.startsWith(`${provider}/`)) exhaustedUntilByModel.delete(key);
		}
	}

	function compactAuthSlots(targetFamily?: ProviderFamily): Array<{ from: string; to: string }> {
		const auth = readAuthFile();
		const families: ProviderFamily[] = targetFamily
			? [targetFamily]
			: [
					"anthropic",
					"openai-codex",
					"kimi-coding",
					"antigravity",
					"cursor",
					"ollama",
					"qwen",
				];
		const allShifted: Array<{ from: string; to: string }> = [];

		let changed = false;
		for (const family of families) {
			const slots = Object.keys(auth)
				.filter(
					(id) =>
						classifyProvider(id, config.qwenProvider) === family &&
						slotIndex(id) > 1,
				)
				.sort((a, b) => slotIndex(a) - slotIndex(b));

			let nextIndex = 2;
			for (const id of slots) {
				const expectedId = slotId(family, nextIndex, config.qwenProvider);
				if (id !== expectedId) {
					auth[expectedId] = auth[id];
					delete auth[id];
					allShifted.push({ from: id, to: expectedId });
					clearProviderRuntimeState(id);
					changed = true;
				}
				nextIndex++;
			}
		}

		if (changed) {
			try {
				writeFileSync(AUTH_PATH, `${JSON.stringify(auth, null, "\t")}\n`, {
					encoding: "utf8",
					mode: 0o600,
				});
			} catch {
				/* ignore write failure */
			}
			if (existsSync(MODELS_CONFIG_PATH)) {
				try {
					const modelsRaw = readFileSync(MODELS_CONFIG_PATH, "utf8");
					const models = JSON.parse(modelsRaw);
					if (models.providers) {
						let modelsChanged = false;
						for (const { from, to } of allShifted) {
							if (models.providers[from]) {
								const entry = { ...models.providers[from] };
								if (typeof entry.baseUrl === "string") {
									entry.baseUrl = entry.baseUrl.replaceAll(from, to);
								}
								models.providers[to] = entry;
								delete models.providers[from];
								modelsChanged = true;
							}
						}
						if (modelsChanged) {
							const tmp = `${MODELS_CONFIG_PATH}.multi-account.tmp`;
							writeFileSync(tmp, `${JSON.stringify(models, null, 2)}\n`, {
								encoding: "utf8",
								mode: 0o600,
							});
							renameSync(tmp, MODELS_CONFIG_PATH);
						}
					}
				} catch {
					/* ignore */
				}
			}
		}

		return allShifted;
	}

	async function removeAuthSlot(ctx: any, id: string): Promise<boolean> {
		const auth = readAuthFile();
		if (!auth[id]) return false;
		const kept = { ...auth };
		delete kept[id];
		try {
			writeFileSync(AUTH_PATH, `${JSON.stringify(kept, null, "\t")}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
		} catch {
			ctx.ui.notify(
				"pi-multi-account: could not update auth.json (file may be locked). Try again.",
				"error",
			);
			return false;
		}
		clearProviderRuntimeState(id);
		const family = classifyProvider(id, config.qwenProvider);
		if (family) {
			compactAuthSlots(family);
		}
		persist();
		const wasCurrent = ctx.model?.provider === id;
		reloadHostAuth(ctx);
		refreshDiscovery(true, ctx);
		if (wasCurrent) {
			await ensureReadyModel(ctx, `removed current account ${id}`);
		}
		return true;
	}

	async function handleCommand(args: string, ctx: any) {
		const [commandRaw, arg1] = args.trim().split(/\s+/);
		const command = (commandRaw || "status").toLowerCase();

		if (command === "log" || command === "logs" || command === "debug") {
			// Show the diagnostic black box so a misbehaviour can be reported precisely.
			if (arg1 === "off") {
				config = { ...config, debugLog: false };
				debugLogEnabled = false;
				ctx.ui.notify(
					'pi-multi-account: debug logging disabled for this session. Set "debugLog": true in the config to re-enable permanently.',
					"info",
				);
				return;
			}
			if (arg1 === "on") {
				config = { ...config, debugLog: true };
				debugLogEnabled = true;
				logEvent("debug_enabled", { version: VERSION });
				ctx.ui.notify(
					`pi-multi-account: debug logging enabled. File: ${DEBUG_LOG_PATH}`,
					"info",
				);
				return;
			}
			const n = Math.min(200, Math.max(1, Number.parseInt(arg1 ?? "", 10) || 40));
			const tail = readDebugLogTail(n);
			ctx.ui.notify(
				tail
					? `pi-multi-account debug log (last ${n} events) — ${DEBUG_LOG_PATH}\n${tail}`
					: `pi-multi-account: no debug log yet at ${DEBUG_LOG_PATH} (it fills as failover events happen; enable with /multi-account log on if needed).`,
				"info",
			);
			return;
		}

		if (command === "models" || command === "model") {
			// Show, per account in the rotation, the model order this extension would use
			// (★ = the one that would be selected). Lets you SEE whether the latest model is
			// actually available and chosen on each account.
			refreshDiscovery(false, ctx);
			const lines = [
				`pi-multi-account models (prefer-latest: ${config.preferLatestModel ? "ON" : "OFF"}) — ★ = selected first:`,
			];
			for (const target of activeFallbacks()) {
				const parsed = parseTarget(target);
				if (!parsed) continue;
				const ordered = resolveTargets(ctx, target, ctx.model).map(
					(m: any, i: number) => (i === 0 ? `★${m.id}` : m.id),
				);
				lines.push(
					`  ${parsed.provider}: ${ordered.join(", ") || "(no models registered — check /login)"}`,
				);
			}
			const overrides = Object.entries(config.preferredModels);
			if (overrides.length > 0) {
				lines.push(
					`Config overrides: ${overrides.map(([fam, list]) => `${fam}=[${list.join(", ")}]`).join("; ")}`,
				);
			} else {
				lines.push(
					`Live Codex discovery: ${config.autoDiscoverModels ? `ON${discoveredCodexModelOrder.length ? ` — ${discoveredCodexModelOrder.join(" → ")}` : " — no cached catalog yet"}` : "OFF"}.`,
				);
			}
			ctx.ui.notify(lines.join("\n"), "info");
			return;
		}

		if (command === "compact" || command === "defrag") {
			const family = parseFamilyArg(arg1);
			const shifted = compactAuthSlots(family);
			if (shifted.length > 0) {
				reloadHostAuth(ctx);
				refreshDiscovery(true, ctx);
				const details = shifted
					.map(({ from, to }) => `${from} → ${to}`)
					.join(", ");
				ctx.ui.notify(
					`pi-multi-account: compacted slots (${details}). Rotation: ${rotation.join(" → ") || "none"}`,
					"info",
				);
			} else {
				ctx.ui.notify(
					"pi-multi-account: all slots are already contiguous (no gaps to compact).",
					"info",
				);
			}
			return;
		}

		if (command === "reload") {
			const previousAutoDiscoverModels = config.autoDiscoverModels;
			config = loadConfig();
			if (config.onlyActive !== onlyActiveModels) {
				onlyActiveModels = config.onlyActive;
				if (onlyActiveModels) applyOnlyActiveFilter(ctx);
				else clearOnlyActiveFilter();
			}
			debugLogEnabled = config.debugLog;
			configuredFallbacks = config.fallbacks.slice();
			if (config.autoDiscoverModels !== previousAutoDiscoverModels) {
				registryCodexModelOrder = [];
				if (!config.autoDiscoverModels) {
					discoveredCodexModelOrder = [];
					discoveredOllamaModelIds = [];
					ollamaCatalogFetchedAt = 0;
				}
			}
			refreshDiscovery(true, ctx);
			startUsageStatusTimer(ctx);
			runBackground("reload account metadata refresh", ctx, async () => {
				await refreshRotationUsage(ctx);
				await syncCodexModelCatalog(ctx, true);
				await syncOllamaModelCatalog(ctx, true);
			});
			ctx.ui.notify(
				"pi-multi-account: config reloaded and accounts re-discovered",
				"info",
			);
			return;
		}
		if (command === "rediscover") {
			const changed = refreshDiscovery(true, ctx);
			runBackground("rediscover slot proxy republish", ctx, () =>
				publishProxiedSlots(ctx),
			);
			runBackground("rediscover account metadata refresh", ctx, async () => {
				await refreshRotationUsage(ctx);
				await syncCodexModelCatalog(ctx, true);
				await syncOllamaModelCatalog(ctx, true);
			});
			ctx.ui.notify(
				`pi-multi-account: rediscovered accounts${changed ? "" : " (no auth.json change)"}. Rotation: ${rotation.join(" → ") || "none"}`,
				"info",
			);
			return;
		}
		if (command === "add") {
			const family = parseFamilyArg(arg1);
			if (!family) {
				ctx.ui.notify(
					"pi-multi-account: usage: /multi-account add <anthropic|codex|kimi|antigravity|cursor|ollama|qwen>",
					"warning",
				);
				return;
			}
			const auth = readAuthFile();
			let n = 2;
			while (
				auth[slotId(family, n, config.qwenProvider)] &&
				n <= config.maxAccountsPerProvider
			)
				n++;
			if (n > config.maxAccountsPerProvider) {
				ctx.ui.notify(
					`pi-multi-account: no free ${family} slot (max ${config.maxAccountsPerProvider}). Remove an unused one from auth.json first.`,
					"warning",
				);
				return;
			}
			const id = slotId(family, n, config.qwenProvider);
			if (family === "cursor" && !isCursorProviderInstalled()) {
				// Asked for by name → this is exactly when the clone instruction is useful.
				await refreshCursorSlots(auth, ctx, true);
				return;
			}
			syncRegisteredSlots(auth, ctx);
			if (
				family === "anthropic" ||
				family === "openai-codex" ||
				family === "kimi-coding" ||
				family === "antigravity" ||
				family === "cursor"
			) {
				const slotLabel = formatSlotDisplayName(id);
				const loginHint =
					family === "cursor"
						? `run /login, authenticate your Cursor subscription in the browser, select ${slotLabel} (${id})`
						: family === "antigravity"
							? `run /login, select ${slotLabel} (${id}), then complete Google sign-in in the browser`
							: `run /login, choose "Use a subscription", select ${slotLabel} (${id})`;
				ctx.ui.notify(
					`pi-multi-account: ${loginHint}, then run /multi-account rediscover`,
					"info",
				);
			} else {
				ctx.ui.notify(
					`pi-multi-account: add an entry "${id}" to ~/.pi/agent/auth.json with {"type":"api_key","key":"<your key>"} and run /multi-account rediscover`,
					"info",
				);
			}
			return;
		}
		if (command === "remove" || command === "rm" || command === "delete") {
			const targetRaw = arg1?.trim();
			if (!targetRaw) {
				ctx.ui.notify(
					"pi-multi-account: usage: /multi-account remove <anthropic|codex|kimi|antigravity|cursor|ollama|qwen|provider-id>",
					"warning",
				);
				return;
			}
			const auth = readAuthFile();
			const id = resolveRemoveTarget(targetRaw, auth, config.qwenProvider);
			if (!id) {
				const family = parseFamilyArg(targetRaw);
				ctx.ui.notify(
					family
						? `pi-multi-account: no ${family} account to remove.`
						: `pi-multi-account: unknown or missing account "${targetRaw}". Rotation: ${rotation.join(", ") || "none"}`,
					"warning",
				);
				return;
			}
			const removed = await removeAuthSlot(ctx, id);
			if (removed) {
				ctx.ui.notify(
					`pi-multi-account: removed ${id}. Rotation: ${rotation.join(" → ") || "none"}`,
					"info",
				);
			}
			return;
		}
		if (command === "revive") {
			const target = arg1?.trim();
			if (!target) {
				ctx.ui.notify(
					"pi-multi-account: usage: /multi-account revive <provider|all>",
					"warning",
				);
				return;
			}
			const targets =
				target === "all" ? [...invalidatedByProvider.keys()] : [target];
			let revived = 0;
			for (const p of targets) {
				if (invalidatedByProvider.delete(p)) revived++;
				exhaustedUntilByProvider.delete(p);
				authFailures.delete(p);
			}
			if (revived > 0) persist();
			refreshDiscovery(true, ctx);
			ctx.ui.notify(
				`pi-multi-account: revived ${revived} account(s)${target === "all" ? "" : ` (${target})`}. They are back in rotation.`,
				"info",
			);
			return;
		}
		if (command === "clear") {
			// Wipe EVERYTHING: fallbacks config, rotation state, cooldowns,
			// invalidations, usage, pending work, AND alias slots from auth.json —
			// so the user can rebuild the fallback list from scratch starting at
			// account-2. Base providers (anthropic, openai-codex, ollama, alibaba)
			// stay in auth.json; only numbered alias slots are removed.
			configuredFallbacks = [];
			config = { ...config, fallbacks: [] };
			try {
				const raw = existsSync(CONFIG_PATH)
					? JSON.parse(readFileSync(CONFIG_PATH, "utf8"))
					: {};
				raw.fallbacks = [];
				writeFileSync(CONFIG_PATH, `${JSON.stringify(raw, null, "\t")}\n`, {
					encoding: "utf8",
					mode: 0o600,
				});
			} catch {
				// non-fatal: in-memory state is still cleared
			}
			// Remove all numbered alias slots from auth.json so /multi-account add
			// starts fresh at account-2. Keep base providers (no -account-N suffix)
			// and keep unrelated providers (openrouter, deepseek, zai, etc.).
			const removedSlots: string[] = [];
			try {
				const auth = readAuthFile();
				const kept: Record<string, AuthEntry> = {};
				for (const [id, entry] of Object.entries(auth)) {
					if (/-account-\d+$/.test(id)) {
						removedSlots.push(id);
					} else {
						kept[id] = entry;
					}
				}
				if (removedSlots.length > 0) {
					writeFileSync(AUTH_PATH, `${JSON.stringify(kept, null, "\t")}\n`, {
						encoding: "utf8",
						mode: 0o600,
					});
				}
			} catch {
				// non-fatal: auth.json may be locked by a concurrent Pi process
			}
			// Forget every alias slot we ever registered with Pi — they no longer
			// have credentials, so re-discovery will not pick them up.
			registeredSlots.clear();
			exhaustedUntilByProvider.clear();
			exhaustedUntilByModel.clear();
			invalidatedByProvider.clear();
			authFailures.clear();
			usageByProvider.clear();
			usageErrors.clear();
			codexModelCatalogByProvider.clear();
			discoveredCodexModelOrder = [];
			responseCooldownHints.clear();
			handledAssistantErrors.clear();
			currentPromptSwitch = undefined;
			autoContinuesThisPrompt = 0;
			userAbortedChain = false;
			clearPendingContinuation();
			clearQueuedInputs();
			persistedState = {
				stateVersion: STATE_VERSION,
				exhaustedUntilByProvider: {},
				exhaustedUntilByModel: {},
				invalidatedByProvider: {},
				usageByProvider: {},
				codexModelCatalogByProvider: {},
				lastSwitches: [],
			};
			saveState(persistedState);
			rotation = [];
			duplicateSlots = [];
			reloadHostAuth(ctx);
			ctx.ui.notify(
				`pi-multi-account: cleared all fallbacks, state and ${removedSlots.length} alias slot(s)${removedSlots.length ? ` (${removedSlots.join(", ")})` : ""}. Run /multi-account add <family> then /login to rebuild.`,
				"info",
			);
			return;
		}
		if (command === "reset") {
			exhaustedUntilByProvider.clear();
			currentPromptSwitch = undefined;
			autoContinuesThisPrompt = 0;
			userAbortedChain = false;
			recoveryFailures = 0;
			breakerOpenUntil = 0;
			watchdogAborting = false;
			expectingInjectedContinuation = false;
			authFailures.clear();
			responseCooldownHints.clear();
			handledAssistantErrors.clear();
			usageByProvider.clear();
			usageErrors.clear();
			clearPendingContinuation();
			clearQueuedInputs();
			exhaustedUntilByModel.clear();
			persistedState = {
				stateVersion: STATE_VERSION,
				exhaustedUntilByProvider: {},
				exhaustedUntilByModel: {},
				invalidatedByProvider: {},
				usageByProvider: {},
				codexModelCatalogByProvider: Object.fromEntries(
					codexModelCatalogByProvider.entries(),
				),
				lastSwitches: [],
			};
			invalidatedByProvider.clear();
			saveState(persistedState);
			refreshDiscovery(true, ctx);
			ctx.ui.notify(
				"pi-multi-account: cooldowns, invalidations and pending resume reset",
				"info",
			);
			return;
		}
		if (command === "limits" || command === "usage" || command === "quota") {
			const provider = ctx.model?.provider;
			if (!provider || !usageFamily(provider)) {
				ctx.ui.notify(
					`pi-multi-account: usage limits are not available for ${provider ?? "the current model"}`,
					"warning",
				);
				return;
			}
			const snapshot = await refreshUsage(ctx, provider, arg1 === "refresh", true);
			const warning = usageErrors.get(provider);
			if (!snapshot) {
				ctx.ui.notify(
					`pi-multi-account: could not load limits for ${provider}${warning ? `: ${warning}` : ""}`,
					"warning",
				);
				return;
			}
			ctx.ui.notify(
				`${formatUsageDetails(displayUsageSnapshot(snapshot))}${warning ? `\nRefresh warning: ${warning}` : ""}`,
				warning ? "warning" : "info",
			);
			return;
		}
		if (command === "switch" || command === "use") {
			const target = arg1?.trim();
			if (!target) {
				ctx.ui.notify(
					`pi-multi-account: usage: /multi-account switch <provider>. Available: ${rotation.join(", ") || "none"}`,
					"warning",
				);
				return;
			}
			const parsed = resolveSwitchTarget(target, ctx);
			if (!parsed) {
				ctx.ui.notify(
					`pi-multi-account: unknown provider "${target}". Rotation: ${rotation.join(", ") || "none"}`,
					"warning",
				);
				return;
			}
			if ("ambiguous" in parsed) {
				ctx.ui.notify(
					`pi-multi-account: "${target}" matches ${parsed.ambiguous.join(", ")} — name one of them.`,
					"warning",
				);
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify(
					"pi-multi-account: no active model to switch from",
					"warning",
				);
				return;
			}
			// Manual switch is an EXPLICIT override, so give the target a clean slate:
			//  - clear any cooldown (the user is overriding a rate-limit wait), AND
			//  - clear a STALE invalidation. An account can stay invalidated long after its real
			//    cause is gone — e.g. it was killed by a since-fixed provider bug (the wrong Qwen
			//    endpoint), or the key was replaced but its hash-based auto-revive never ran because
			//    the auth-file mtime hadn't changed. Refusing the user's own switch in that state was
			//    the "fresh key still says: not logged in" bug. Revive, reload auth, force
			//    re-discovery, and let the account prove itself on the real request instead.
			const wasInvalid = invalidatedByProvider.delete(parsed.provider);
			authFailures.delete(parsed.provider);
			exhaustedUntilByProvider.delete(parsed.provider);
			for (const key of [...exhaustedUntilByModel.keys()]) {
				if (key.startsWith(`${parsed.provider}/`)) {
					exhaustedUntilByModel.delete(key);
				}
			}
			persist();
			refreshDiscovery(true, ctx);
			// Use the RESOLVED slot id, not the raw text: a short name that resolved above would
			// otherwise be handed on verbatim and find nothing.
			const resolvedTarget = parsed.modelId
				? `${parsed.provider}/${parsed.modelId}`
				: parsed.provider;
			const candidates = resolveTargets(
				ctx,
				resolvedTarget,
				ctx.model,
				true,
			).filter((model: any) => providerHasUsableAuth(ctx, model.provider));
			if (candidates.length === 0) {
				const hasAuth = providerHasUsableAuth(ctx, parsed.provider);
				ctx.ui.notify(
					hasAuth
						? `pi-multi-account: "${target}" is logged in but the host exposes no model for it yet. Run /multi-account rediscover, or restart Pi if you just logged in.`
						: `pi-multi-account: no credentials for "${target}" in auth.json — run /login and pick it. Rotation: ${rotation.join(", ") || "none"}`,
					"warning",
				);
				return;
			}
			if (wasInvalid)
				ctx.ui.notify(
					`pi-multi-account: cleared a stale invalidation on "${parsed.provider}" and is retrying it now.`,
					"info",
				);
			currentPromptSwitch = undefined;
			const switched = await activateFallback(
				ctx,
				ctx.model,
				candidates,
				`manual /multi-account switch ${target}`,
				{ armContinuation: false, announceSwitch: false },
			);
			currentPromptSwitch = undefined;
			if (switched) {
				announceManualChoice(ctx);
			} else {
				ctx.ui.notify(
					`pi-multi-account: could not switch to "${target}"`,
					"warning",
				);
			}
			return;
		}
		/**
		 * Resolve what the user typed to a real slot.
		 *
		 * The slot ids are internal (`kimi-coding`, `openai-codex-account-6`) and `switch` demanded
		 * one exactly, so the only command that reaches a chosen account directly answered
		 * `unknown provider "kimi"` to the name a person would actually type — leaving `next` and
		 * its walk through every spent account as the only way there. An exact id always wins; a
		 * short name resolves only when it is unambiguous, because guessing between two Codex slots
		 * would silently spend the wrong account's quota.
		 */
		function resolveSwitchTarget(
			target: string,
			ctx: any,
		):
			| { provider: string; modelId?: string }
			| { ambiguous: string[] }
			| undefined {
			const parsed = parseTarget(target);
			if (!parsed) return undefined;
			const known = new Set([...rotation, ...Object.keys(readAuthFile())]);
			if (known.has(parsed.provider)) return parsed;
			if (providerHasUsableAuth(ctx, parsed.provider)) return parsed;
			const needle = parsed.provider.toLowerCase();
			const matches = [...known].filter(
				(id) =>
					id.toLowerCase().startsWith(needle) || id.toLowerCase().includes(needle),
			);
			if (matches.length === 1) return { ...parsed, provider: matches[0] };
			if (matches.length > 1) return { ambiguous: matches.sort() };
			return parsed;
		}

		if (command === "best" || command === "live") {
			// `next` walks the ring a step at a time and `switch` needs an exact name, so on a
			// machine with a dozen accounts — most of them spent — reaching a working one meant
			// pressing next until something answered, landing on and being bounced off each dead
			// account on the way. This asks the one question a person actually has: put me
			// somewhere that can work right now.
			if (!ctx.model) {
				ctx.ui.notify(
					"pi-multi-account: no active model to switch from",
					"warning",
				);
				return;
			}
			const candidates = findFallbackModels(ctx, ctx.model, {
				availableNowOnly: true,
				includeCurrent: true,
				preferSameIdentity: false,
			});
			if (candidates.length === 0) {
				const wait = nextRecoveryStatus(ctx);
				ctx.ui.notify(
					`pi-multi-account: no account can serve work right now. ${wait}`,
					"warning",
				);
				return;
			}
			if (
				candidates[0].provider === ctx.model.provider &&
				candidates[0].id === ctx.model.id
			) {
				ctx.ui.notify(
					`pi-multi-account: already on the best available account (${ctx.model.provider}/${ctx.model.id})`,
					"info",
				);
				return;
			}
			currentPromptSwitch = undefined;
			const verified = isConfirmedAvailable(candidates[0].provider);
			const switched = await activateFallback(
				ctx,
				ctx.model,
				candidates,
				"manual /multi-account best",
				{ armContinuation: false, announceSwitch: false },
			);
			currentPromptSwitch = undefined;
			if (switched) {
				announceManualChoice(ctx);
				// Saying "best" of an account nobody can measure overstates what was done. When no
				// account confirms availability, this is the least-bad guess, and calling it that
				// is the difference between a considered choice and looking random.
				if (!verified)
					ctx.ui.notify(
						`pi-multi-account: no account confirmed availability — ${ctx.model?.provider} has no quota endpoint to check, so this is an unverified guess. Everything measurable is spent.`,
						"warning",
					);
			} else
				ctx.ui.notify(
					"pi-multi-account: could not switch to the best available account",
					"warning",
				);
			return;
		}
		if (command === "only-active" || command === "focus") {
			const next2 =
				arg1 === "on" ? true : arg1 === "off" ? false : !onlyActiveModels;
			onlyActiveModels = next2;
			config = { ...config, onlyActive: next2 };
			try {
				const raw = existsSync(CONFIG_PATH)
					? JSON.parse(readFileSync(CONFIG_PATH, "utf8"))
					: {};
				raw.onlyActive = next2;
				writeFileSync(CONFIG_PATH, `${JSON.stringify(raw, null, "\t")}\n`, {
					encoding: "utf8",
					mode: 0o600,
				});
			} catch {
				// non-fatal: the in-memory flag still applies for this session
			}
			if (next2) applyOnlyActiveFilter(ctx);
			else clearOnlyActiveFilter();
			ctx.ui.notify(
				next2
					? "pi-multi-account: only-active ON — /model shows only the active account's models; the filter follows every switch"
					: "pi-multi-account: only-active OFF — every provider's models restored",
				"info",
			);
			return;
		}
		if (command === "fast") {
			const fastArgs = args.trim().split(/\s+/).slice(1);
			if (fastArgs[0]?.toLowerCase() === "grok") {
				await handleGrokFast(pi, ctx, fastArgs[1]?.toLowerCase());
				return;
			}
			const action = ((fastArgs[0]?.toLowerCase() === "codex" ? fastArgs[1] : arg1) ?? "status").toLowerCase();
			if (action !== "on" && action !== "off" && action !== "status") {
				ctx.ui.notify("Usage: /multi-account fast [codex|grok] on|off|status", "warning");
				return;
			}
			if (action === "on" || action === "off") {
				try {
					writeCodexFastEnabled(action === "on");
				} catch (error) {
					ctx.ui.notify(
						`pi-multi-account: could not save Codex fast mode: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
					return;
				}
			}
			const enabled = readCodexFastEnabled();
			ctx.ui.notify(
				enabled
					? "pi-multi-account: Codex fast mode ON. Base provider, account slots and RPC subagents send service_tier=priority. No separate fast-mode plugin is needed."
					: "pi-multi-account: Codex fast mode OFF. Base provider, account slots and RPC subagents omit service_tier. Disable any separately loaded fast-mode plugin to avoid conflicting hooks.",
				"info",
			);
			return;
		}
		if (command === "priority" || command === "order") {
			const rest = args.trim().split(/\s+/).slice(1).join(" ").trim();
			const groupsPresent = [
				...new Set(rotation.map((id) => normalizeGroup(id))),
			].filter(Boolean);

			// No argument: report, never change. The ladder is the kind of setting people check
			// far more often than they set.
			if (!rest) {
				const lines = describePriority(config.providerPriority, groupsPresent);
				ctx.ui.notify(
					[
						"pi-multi-account: failover priority — where work goes once EVERY account of the",
						"current provider is spent. Same-provider failover always runs first, and an account",
						"on cooldown is never chosen over a free one; this only orders the rest.",
						"",
						...lines,
						"",
						"Set:   /multi-account priority anthropic openai-codex kimi-coding cursor",
						"Reset: /multi-account priority reset",
					].join("\n"),
					"info",
				);
				return;
			}

			const reset = /^(reset|default|defaults)$/i.test(rest);
			const cleared = /^(none|off|clear)$/i.test(rest);
			// "none" is a real answer, distinct from resetting: it says "I have no preference,
			// decide by liveness alone", which is what an empty ladder means to the comparator.
			const next = reset
				? [...DEFAULT_PROVIDER_PRIORITY]
				: cleared
					? []
					: normalizePriority(rest);
			if (!reset && !cleared && next.length === 0) {
				ctx.ui.notify(
					`pi-multi-account: could not read any provider name in "${rest}". Try: /multi-account priority anthropic openai-codex kimi-coding cursor`,
					"warning",
				);
				return;
			}

			config = { ...config, providerPriority: next };
			try {
				const raw = existsSync(CONFIG_PATH)
					? JSON.parse(readFileSync(CONFIG_PATH, "utf8"))
					: {};
				raw.providerPriority = next;
				writeFileSync(CONFIG_PATH, `${JSON.stringify(raw, null, "\t")}\n`, {
					encoding: "utf8",
					mode: 0o600,
				});
			} catch {
				// non-fatal: the ladder still applies for this session
			}
			logEvent("priority_set", { priority: next, reset, cleared });

			// Naming a provider that is not logged in is not an error — people set the ladder they
			// intend to have, then log in. But it must be said, or a typo looks like it worked.
			const unknown = next.filter((group) => !groupsPresent.includes(group));
			ctx.ui.notify(
				[
					cleared
						? "pi-multi-account: failover priority cleared — order decided by live availability alone."
						: reset
							? "pi-multi-account: failover priority reset to the default ladder."
							: "pi-multi-account: failover priority set.",
					...describePriority(next, groupsPresent),
					...(unknown.length > 0
						? [
								"",
								`Not logged in (kept in the ladder for when you are): ${unknown.join(", ")}`,
							]
						: []),
				].join("\n"),
				"info",
			);
			return;
		}
		if (command === "next") {
			if (ctx.model) {
				currentPromptSwitch = undefined;
				// Manual rotation is a user override, NOT a rate-limit event: cooling the account
				// we're leaving (the old 5-minute cooldown) drained the pool — after one lap every
				// provider was "cooling" and the round-robin collapsed onto whatever was left. Pass
				// 0 so we only record lastLeftProvider (anti-ping-pong) and keep every account
				// selectable, so repeated /multi-account next truly cycles through them all.
				await switchToFallback(ctx, ctx.model, "manual /multi-account next", 0, {
					manual: true,
				});
				currentPromptSwitch = undefined;
				announceManualChoice(ctx);
			}
			return;
		}
		if (command === "stop") {
			userAbortedChain = true;
			currentPromptSwitch = undefined;
			watchdogAborting = false;
			expectingInjectedContinuation = false;
			clearPendingContinuation();
			clearQueuedInputs();
			endResumeWatch();
			ctx.abort();
			ctx.ui.notify(
				"pi-multi-account: automatic failover/resume stopped for the current task",
				"info",
			);
			return;
		}
		if (command === "enable" || command === "disable") {
			config = { ...config, enabled: command === "enable" };
			if (!config.enabled) clearPendingContinuation();
			ctx.ui.notify(
				`pi-multi-account: failover ${config.enabled ? "enabled" : "disabled"} for this Pi process`,
				"info",
			);
			return;
		}

		refreshDiscovery(false, ctx);
		if (command === "status") {
			// Status is an interactive inspection path: render the best cached snapshot immediately
			// instead of making the UI wait for the slowest provider. Refresh stale accounts in the
			// background so the footer and the next status invocation receive the newer values.
			// `/multi-account limits refresh` remains the explicit wait-for-fresh-data path.
			runBackground("status usage refresh", ctx, () =>
				refreshRotationUsage(ctx, false, true),
			);
		}
		const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
		// What the rotation looks like to anything that does NOT load this extension: a memory
		// extension consolidating its notes, an external CLI, any `pi -p --no-extensions` child.
		// A child launched without an explicit model uses the startup default in settings.json;
		// report when that default cannot authenticate rather than pretending it tracks the live
		// rotation account.
		const childView = slotsAsAChildSeesThem(rotation, readAuthFile());
		const childUnusable = childView.filter((verdict) => !verdict.usable);
		const childRouteWarning = defaultRouteWarning(
			readHostDefaultModel()?.provider,
			(slotId) => slotsAsAChildSeesThem([slotId], readAuthFile())[0],
		);
		const currentUsage = ctx.model ? cachedUsage(ctx.model.provider) : undefined;
		const cooldowns = [...exhaustedUntilByProvider.entries()]
			.filter(([p, until]) => until > Date.now() && !isInvalidated(p))
			.map(([p, until]) => `${p}: ${formatUntil(until)}`);
		const invalids = [...invalidatedByProvider.entries()].map(
			([p, r]) => `${p} (${r.reason.slice(0, 40)})`,
		);
		const verboseStatus = ["full", "verbose", "details"].includes(
			(arg1 ?? "").toLowerCase(),
		);
		if (!verboseStatus) {
			const paint = (color: string, text: string) => {
				try {
					return ctx.ui.theme?.fg ? ctx.ui.theme.fg(color, text) : text;
				} catch {
					return text;
				}
			};
			const bold = (text: string) => {
				try {
					return ctx.ui.theme?.bold ? ctx.ui.theme.bold(text) : text;
				} catch {
					return text;
				}
			};
			const field = (name: string, value: string) =>
				`${paint("muted", name.padEnd(6))} ${value}`;
			const providerName = (provider: string) => {
				switch (usageFamily(provider)) {
					case "codex":
						return "Codex";
					case "anthropic":
						return "Claude";
					case "kimi-coding":
						return "Kimi";
					case "antigravity":
						return "Antigravity";
					case "cursor":
						return "Cursor";
					case "ollama":
						return "Ollama";
					case "qwen":
						return "Qwen";
					case "xai":
						return "xAI";
					default:
						return provider.replace(/-account-\d+$/, "");
				}
			};
			const titleCase = (value: string | undefined) =>
				value ? value.charAt(0).toUpperCase() + value.slice(1) : "订阅未知";
			const snapshotFor = (provider: string) =>
				cachedUsage(provider) ?? usageByProvider.get(provider);
			const accountText = (provider: string) => {
				const snapshot = snapshotFor(provider);
				const account = snapshot?.account ?? providerName(provider);
				return `${account}: ${titleCase(snapshot?.plan)}`;
			};
			const limitsText = (snapshot: UsageSnapshot | undefined) => {
				if (!snapshot) {
					return ctx.model && usageFamily(ctx.model.provider) === "qwen"
						? qwenLiveStatus(ctx.model.provider)
						: "尚未加载";
				}
				const display = displayUsageSnapshot(snapshot);
				const parts: string[] = [];
				if (snapshot.planWarning) parts.push(`订阅查询失败${snapshot.plan ? "（保留上次订阅）" : ""}: ${snapshot.planWarning}`);
				if (display.serviceable === true) parts.push("可用");
				else if (display.serviceable === false) parts.push("已用尽");

				if (display.family === "antigravity") {
					// Only surface Gemini quota for Antigravity, keeping it on a single row exactly matching Codex.
					const gemini = display.modelQuotas?.["Gemini"];
					const geminiPrimary = gemini?.primary ?? (display.primary?.windowSeconds === 18000 ? display.primary : undefined);
					const geminiSecondary = gemini?.secondary ?? (display.primary?.windowSeconds === 604800 ? display.primary : undefined);
					if (geminiPrimary) {
						parts.push(`5h 剩余 ${remainingPercent(geminiPrimary)}% · ${formatResetDuration(geminiPrimary.resetAt)} 后重置`);
					}
					if (geminiSecondary) {
						parts.push(`7d 剩余 ${remainingPercent(geminiSecondary)}% · ${formatResetDuration(geminiSecondary.resetAt)} 后重置`);
					}
				} else {
					for (const [position, window] of [
						["primary", display.primary],
						["secondary", display.secondary],
					] as const) {
						if (!window) continue;
						const label = windowLabel(window, display.family, position);
						parts.push(
							`${label} 剩余 ${remainingPercent(window)}% · ${formatResetDuration(window.resetAt)} 后重置`,
						);
					}
				}
				if (
					display.family === "codex" &&
					display.rateLimitResetCredits !== undefined
				)
					parts.push(`可用重置次数 ${display.rateLimitResetCredits}`);
				if (!display.primary && !display.secondary && display.plan)
					parts.push(display.plan);
				return parts.join("  │  ") || "暂无额度数据";
			};
			const recovery = nextRecoveryStatus(ctx);
			const recoveryText =
				recovery === "all rotation accounts available now"
					? "全部账号当前可用"
					: recovery;
			const unmanaged = unmanagedRotationMembers();
			const unconfigured = unconfiguredRotationMembers(ctx);
			const quotaLines = rotation.map((provider) => {
				const snapshot = snapshotFor(provider);
				const isCurrent = provider === ctx.model?.provider;
				const color = snapshot
					? usageColor(displayUsageSnapshot(snapshot))
					: "muted";
				return `  ${paint(color, "●")} ${
					isCurrent
						? paint("accent", bold(accountText(provider)))
						: bold(accountText(provider))
				}${isCurrent ? paint("muted", "  当前") : ""}\n    ${paint(color, limitsText(snapshot))}`;
			});
			const statusLines = [
				paint("accent", bold(`pi-multi-account v${VERSION}`)) +
					paint(
						config.enabled ? "success" : "error",
						config.enabled ? "  ● 已启用" : "  ● 已停用",
					) +
					paint("muted", `  自动发现 ${config.autoDiscover ? "ON" : "OFF"}`),
				field(
					"账号",
					paint("accent", bold(ctx.model ? accountText(ctx.model.provider) : "无")),
				),
				field("模型", ctx.model ? ctx.model.id : "无"),
				...(isCodexFastModel(ctx.model)
					? [
							field(
								"快速",
								paint(
									readCodexFastEnabled() ? "success" : "muted",
									readCodexFastEnabled()
										? "priority · service_tier"
										: "standard",
								),
							),
						]
					: []),
				field(
					"轮换",
					rotation.length
						? rotation.map(accountText).join(paint("muted", "  →  "))
						: "无账号，请先登录",
				),
				paint("muted", "全部额度"),
				...(quotaLines.length ? quotaLines : [paint("muted", "  暂无账号")]),
				field("恢复", paint("success", recoveryText)),
			];
			const compactCooldowns = [...exhaustedUntilByProvider.entries()]
				.filter(
					([provider, until]) => until > Date.now() && !isInvalidated(provider),
				)
				.map(
					([provider, until]) => `${accountText(provider)} (${formatUntil(until)})`,
				);
			if (compactCooldowns.length)
				statusLines.push(
					field("冷却", paint("warning", compactCooldowns.join(", "))),
				);
			if (invalids.length)
				statusLines.push(
					field(
						"重登",
						paint(
							"error",
							[...invalidatedByProvider.keys()].map(accountText).join(", "),
						),
					),
				);
			if (unconfigured.length)
				statusLines.push(
					field(
						"模型",
						paint("warning", `未配置：${unconfigured.map(accountText).join(", ")}`),
					),
				);
			if (duplicateSlots.length)
				statusLines.push(
					field(
						"重复",
						paint("warning", `${duplicateSlots.length} 个，请运行 status full 查看`),
					),
				);
			if (unmanaged.length)
				statusLines.push(
					field(
						"额度",
						paint("muted", `无法追踪：${unmanaged.map(accountText).join(", ")}`),
					),
				);
			if (hasPendingResume())
				statusLines.push(field("续跑", paint("warning", "等待自动恢复")));
			if (queuedUserInputs.length)
				statusLines.push(
					field("队列", paint("warning", `${queuedUserInputs.length} 条消息`)),
				);
			const usableChildren = childView.length - childUnusable.length;
			statusLines.push(
				field(
					"子进程",
					paint(
						childUnusable.length || childRouteWarning ? "warning" : "success",
						`${usableChildren}/${childView.length} 可用${childUnusable.length ? ` · ${childUnusable.map((verdict) => accountText(verdict.slotId)).join(", ")} 暂不可用` : ""}`,
					),
				),
			);
			if (childRouteWarning)
				statusLines.push(
					paint(
						"warning",
						"  ⚠ 已保存的启动默认账号无法供无扩展子进程使用；status full 可查看原因",
					),
				);
			if (lastContractVerdicts.some((verdict) => !verdict.ok))
				statusLines.push(
					paint("warning", "  ⚠ Pi 配置文件检查异常；请运行 status full"),
				);
			statusLines.push(
				field("操作", paint("accent", "best  ·  next  ·  limits")),
				paint("muted", "完整诊断  /status full"),
			);
			ctx.ui.notify(statusLines.join("\n"), "info");
			return;
		}
		ctx.ui.notify(
			[
				`pi-multi-account v${VERSION}: ${config.enabled ? "enabled" : "disabled"}${config.autoDiscover ? " · auto-discover ON" : " · auto-discover OFF"}`,
				`Current: ${current}`,
				`Current limits: ${
					currentUsage
						? formatUsageCompact(displayUsageSnapshot(currentUsage))
						: ctx.model && usageFamily(ctx.model.provider) === "qwen"
							? `${providerUsageLabel(ctx.model.provider)} | ${qwenLiveStatus(ctx.model.provider)}`
							: "not loaded"
				}`,
				`Rotation (${rotation.length}): ${rotation.join(" → ") || "none — log in to an account"}`,
				// Naming them is the point: they used to be dropped from rotation in silence, so
				// nothing inside the tool ever revealed that logged-in accounts were sitting idle.
				`Other providers (no quota tracking): ${unmanagedRotationMembers().join(", ") || (config.includeOtherProviders ? "none" : "disabled by includeOtherProviders")}`,
				`Needs models configured (in rotation but unusable): ${unconfiguredRotationMembers(ctx).join(", ") || "none"}`,
				`Duplicate slots skipped: ${duplicateSlots.length ? duplicateSlots.map(({ duplicate, primary }) => `${duplicate} = ${primary}`).join(", ") : "none"}`,
				`Registered login slots: ${[...registeredSlots].join(", ") || "(base accounts only)"}`,
				`Cooldowns: ${cooldowns.length ? cooldowns.join(", ") : "none"}`,
				`Next recovery: ${nextRecoveryStatus(ctx)}`,
				`Invalidated (need re-login): ${invalids.length ? invalids.join(", ") : "none"}`,
				`Pending auto-resume: ${hasPendingResume() ? `yes (reason: ${persistedState.pendingReason ?? "unknown"})` : "none"}`,
				`Queued user messages: ${queuedUserInputs.length}`,
				`Resume watchdog: ${resumeInFlight ? `watching${toolInFlight ? " · tool running" : ""}` : "idle"} · auto-recover ${config.autoRecoverStuck ? "ON" : "OFF"}`,
				`Auto-continue breaker: ${isBreakerOpen() ? `OPEN — advisory mode until ${formatUntil(breakerOpenUntil)} (manual switching; /multi-account reset to re-enable)` : `closed${recoveryFailures ? ` (${recoveryFailures}/${BREAKER_FAILURE_THRESHOLD} recent failures)` : ""}`}`,
				`Debug log: ${config.debugLog ? `on → ${DEBUG_LOG_PATH} (/multi-account log to view)` : "off"}`,
				`Extension-free children: ${childView.length - childUnusable.length}/${childView.length} rotation slots usable${
					childUnusable.length
						? ` · cannot authenticate: ${childUnusable.map((verdict) => verdict.slotId).join(", ")}`
						: ""
				}${childRouteWarning ? `\n  ⚠️ ${childRouteWarning}` : ""}`,
				`Config: ${CONFIG_PATH}`,
				// Pi publishes three files and versions none of the formats, so a silent upgrade is
				// the failure mode. Stating the last look at them here is what makes it checkable.
				`Pi file contract: ${
					lastContractVerdicts.length === 0
						? "not checked yet"
						: lastContractVerdicts.every((verdict) => verdict.ok)
							? `${lastContractVerdicts.map((verdict) => verdict.file).join(", ")} as expected`
							: lastContractVerdicts
									.filter((verdict) => !verdict.ok)
									.map((verdict) => `${verdict.file}: ${verdict.problems.join("; ")}`)
									.join(" | ")
				}`,
				// The ladder decides a step people only notice when it surprises them — the hop taken
				// once a whole provider is spent. Stating it here is what makes it checkable before it
				// matters, rather than after.
				`Failover priority (after every account of the current provider is spent): ${
					config.providerPriority.length > 0
						? `${config.providerPriority.join(" → ")} → everything else`
						: "none set — decided by live availability alone"
				} · /multi-account priority to change`,
				// Switching accounts is the reason most people open this at all, so it gets its own
				// line with a real account name filled in. Buried mid-way through the pipe-separated
				// list below, `switch` was effectively undiscoverable and `next` pressed repeatedly
				// was the only way anyone found to reach a chosen account.
				`Switch accounts: /multi-account best — jump straight to an account that can work now · /multi-account switch <provider> — e.g. /multi-account switch ${rotation.find((p) => p !== ctx.model?.provider) ?? rotation[0] ?? "<provider>"} · /multi-account next steps through the rotation in order`,
				`Other commands: status | best | fast [on|off|status] | priority [...] | limits [refresh] | models | log [N|on|off] | only-active [on|off] | rediscover | add [anthropic|codex|kimi|antigravity|cursor|ollama|qwen] | remove [anthropic|codex|kimi|antigravity|cursor|ollama|qwen|<provider-id>] | revive <provider|all> | clear | stop | reset | reload | enable | disable`,
			].join("\n"),
			"info",
		);
	}

	// A throw inside a command handler should surface as a friendly message, never crash Pi
	// or leave the user with a raw stack trace.
	const safeHandleCommand = async (args: string, ctx: any) => {
		try {
			return await handleCommand(args, ctx);
		} catch (error) {
			reportExtensionError(
				`/multi-account ${args.trim().split(/\s+/)[0] || "status"}`,
				error,
				ctx,
			);
			return undefined;
		}
	};
	for (const name of ["multi-account", "provider-failover", "failover"]) {
		pi.registerCommand(name, {
			description: "Manage automatic multi-account failover & rotation",
			handler: safeHandleCommand,
		});
	}
	pi.registerCommand("status", {
		description: "Show multi-account status",
		handler: (args: string, ctx: any) =>
			safeHandleCommand(`status${args.trim() ? ` ${args.trim()}` : ""}`, ctx),
	});
	for (const name of ["limits", "quota"]) {
		pi.registerCommand(name, {
			description: "Show multi-account limits & quota",
			handler: (args: string, ctx: any) =>
				safeHandleCommand(`limits${args.trim() ? ` ${args.trim()}` : ""}`, ctx),
		});
	}

	// ----- Antigravity multi-account provider -------------------------------
	// The provider-local streamSimple handler owns the custom Cloud Code Assist
	// transport for the base provider and every numbered alias. No image API,
	// image command, or image-generation tool is registered here.
	const initialAuth = readAuthFile();
	registerAntigravitySlot(
		pi,
		"antigravity",
		formatSlotDisplayName("antigravity", initialAuth["antigravity"], "antigravity"),
	);

	// ----- Anthropic OAuth out of the box -----------------------------------
	// Enable Claude Pro/Max OAuth login on the base `anthropic` provider and shape
	// every Anthropic OAuth request so subscription tokens are accepted — without
	// requiring a separate pi-anthropic-auth install. Idempotent, so it coexists
	// safely if pi-anthropic-auth is also present.
	const initialAnthropicName = formatSlotDisplayName(
		"anthropic",
		initialAuth["anthropic"],
		"anthropic",
	);
	pi.registerProvider("anthropic", {
		name: initialAnthropicName,
		oauth: anthropicOAuthOverride("anthropic", initialAnthropicName),
	} as any);

	const initialCodexName = formatSlotDisplayName(
		"openai-codex",
		initialAuth["openai-codex"],
		"openai-codex",
	);
	pi.registerProvider("openai-codex", {
		name: initialCodexName,
		oauth: codexOAuthOverride("openai-codex", initialCodexName),
	} as any);

	// ----- API-key base providers (Ollama, Alibaba/Qwen) ---------------------
	// Pi registers providers from models.json, but if the apiKey field there is a
	// placeholder (e.g. "ollama") Pi may not expose the provider to modelRegistry,
	// which makes resolveTargets() return [] and the family never failovers. To
	// make the extension self-contained, register the base API-key provider here
	// whenever a real key exists in auth.json. Idempotent: if Pi already registered
	// it natively, registerProvider merges/overrides harmlessly.
	const ensureApiKeyBaseProvider = (
		family: "ollama" | "qwen",
		baseId: string,
	) => {
		const entry = readAuthFile()[baseId];
		const key =
			entry && typeof entry.key === "string" && entry.key.length > 0
				? entry.key
				: undefined;
		if (!key) return; // nothing to register — no real credential
		const baseUrl = family === "ollama" ? OLLAMA_CLOUD_BASE_URL : QWEN_BASE_URL;
		const preferred =
			family === "ollama" ? DEFAULT_OLLAMA_MODELS : DEFAULT_QWEN_MODELS;
		// Built-in tags lead, so the flagship this extension knows stays the representative and
		// nothing is downgraded — but everything the user configured is carried too, instead of
		// being replaced by this list.
		const ids = [...preferred];
		if (family === "ollama") {
			for (const discovered of discoveredOllamaModelIds) {
				if (!ids.includes(discovered)) ids.push(discovered);
			}
		}
		for (const configured of configuredModelIds(baseId)) {
			if (!ids.includes(configured)) ids.push(configured);
		}
		const models = ids.map((m) =>
			family === "ollama" ? ollamaModelDef(m, baseId) : qwenModelDef(m, baseId),
		);
		const displayName = formatSlotDisplayName(baseId, entry, family);
		pi.registerProvider(baseId, {
			name: displayName,
			baseUrl,
			api: "openai-completions" as any,
			apiKey: key,
			models: models as any,
		} as any);
	};
	ensureApiKeyBaseProvider("ollama", OLLAMA_BASE);
	ensureApiKeyBaseProvider("qwen", config.qwenProvider);

	// Runs before every LLM request, on AgentMessage[] — the last point where a turn that
	// pi-ai is about to drop (stopReason error/aborted) is still intact. Rewriting it into a
	// `user` record is what lets the account we failed over TO see where the previous one
	// actually stopped, instead of being told "don't repeat completed work" with no record
	// of that work. See preserveInterruptedTurns() for the full rationale.
	safeOn("context", (event: any) => {
		if (!config.enabled || !config.preserveInterruptedContext) return undefined;
		const messages = event?.messages;
		if (!Array.isArray(messages) || messages.length === 0) return undefined;
		const preserved = preserveInterruptedTurns(messages);
		if (preserved === messages) return undefined;
		const rescued = messages.length - preserved.length;
		logEvent("interrupted_context_preserved", {
			messages: messages.length,
			folded: rescued,
		});
		return { messages: preserved };
	});

	safeOn("before_provider_request", (event: any, ctx?: any) => {
		const shaped = shapeAnthropicOAuthPayload(event.payload);
		const payload = (shaped ?? event.payload) as
			| Record<string, unknown>
			| undefined;
		const provider = ctx?.model?.provider;
		if (payload && typeof provider === "string") {
			if (isCursorProviderId(provider)) {
				payload.pi_session_id = ctx?.sessionManager?.getSessionId?.();
			}
			// Qwen/Alibaba rejects the OpenAI-only `developer` role — normalize it to `system`.
			if (classifyProvider(provider, config.qwenProvider) === "qwen") {
				rewriteDeveloperRoleToSystem(payload);
			}
			shapeCodexFastPayload(payload, ctx?.model);
		}
		return shaped;
	});

	// ----- lifecycle hooks --------------------------------------------------

	refreshDiscovery(true);

	// Runtime capability preflight. The RECURRING class of breakage in this extension is the
	// pi↔extension BOUNDARY drifting: a host method the failover depends on gets renamed or removed
	// (e.g. pi.continueAgent() vanished in @earendil-works/pi-coding-agent 0.80.3), and the failure
	// only surfaces weeks later as a cryptic error the instant a real limit hits. Unit tests can
	// never catch this — they mock `pi` and always implement every method. So we probe the REAL host
	// object at every session start: record which capabilities are present (dated, in the debug log
	// for instant diagnosis) and, ONCE per process, tell the user in plain terms if switching is
	// impossible or resume is degraded — instead of letting them discover it under fire.
	// ----- parent-owned slot proxy ------------------------------------------
	//
	// Everything spawned without this extension loaded reads settings.json to find the active
	// account. A numbered OAuth slot resolves by name for such a child and then fails at auth,
	// because Pi honours an OAuth credential only for a provider definition declaring the flow —
	// so the child silently reroutes to whichever provider Pi finds first. The Cursor slots
	// already solve this by publishing a loopback route the parent serves with a non-secret
	// placeholder; this extends the same pattern to the Anthropic and Codex families. Decisions
	// live in slot-proxy.ts; what is here is the socket and the credential lookup.

	let slotProxyServer: Server | undefined;
	let slotProxyPort: number | undefined;
	let slotProxyStarting: Promise<number | undefined> | undefined;
	let slotProxyContext: any;
	const slotProxyRoutes = new Map<string, ProxyRoute>();
	/** Preferred port, so a route published last session usually still works. */
	const SLOT_PROXY_PORT = 41977;

	/** Numbered OAuth slots are the ones a child cannot otherwise authenticate to. */
	function proxyFamilyOf(slotId: string): ProxyFamily | undefined {
		if (!/-account-\d+$/.test(slotId)) return undefined; // base providers are Pi's own
		const family = classifyProvider(slotId, config.qwenProvider);
		if (family === "anthropic") return "anthropic";
		if (family === "openai-codex") return "codex";
		return undefined;
	}

	/** The credential to send upstream, refreshed first when the stored one has expired. */
	async function credentialForProxy(
		slotId: string,
	): Promise<AuthEntry | undefined> {
		let entry = readAuthFile()[slotId];
		if (!entry) return undefined;
		if (entry.type !== "oauth" || typeof entry.access !== "string") return entry;
		const expiry = jwtExpMs(entry.access);
		// A minute of slack: a token that expires mid-flight fails the child's whole request, and
		// refreshing one turn early costs nothing.
		if (expiry !== undefined && expiry - 60_000 <= Date.now()) {
			try {
				await forceRefreshProvider(slotProxyContext, slotId);
				entry = readAuthFile()[slotId] ?? entry;
			} catch (error) {
				logEvent("slot_proxy_refresh_failed", {
					slot: slotId,
					reason: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return entry;
	}

	async function readRequestBody(req: any): Promise<Buffer> {
		const chunks: Buffer[] = [];
		for await (const chunk of req) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		}
		return Buffer.concat(chunks);
	}

	async function handleProxyRequest(req: any, res: any): Promise<void> {
		// Pi's Codex API tries a WebSocket first and falls back to SSE when it cannot connect
		// (measured: one GET, then POSTs, on a real bare child). Refusing the upgrade here makes
		// that fallback immediate instead of spending an upstream round trip on a request that
		// could never have been a WebSocket.
		if (typeof req.headers?.upgrade === "string") {
			logEvent("slot_proxy_upgrade_refused", { upgrade: req.headers.upgrade });
			res.writeHead(501, { "content-type": "application/json" });
			res.end(
				JSON.stringify({ error: { message: "this route serves HTTP only" } }),
			);
			return;
		}
		const verdict = admitRequest({
			rawUrl: req.url ?? "",
			headers: req.headers ?? {},
			routes: slotProxyRoutes,
		});
		if (!verdict.ok) {
			logEvent("slot_proxy_refused", {
				status: verdict.status,
				reason: verdict.message,
			});
			res.writeHead(verdict.status, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: verdict.message } }));
			return;
		}
		const credential = await credentialForProxy(verdict.route.slotId);
		const shaped = shapeUpstreamRequest({
			route: verdict.route,
			rest: verdict.rest ?? "/",
			headers: req.headers ?? {},
			credential,
		});
		if (!shaped.ok) {
			logEvent("slot_proxy_no_credential", {
				slot: verdict.route.slotId,
				status: shaped.status,
			});
			res.writeHead(shaped.status, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: shaped.message } }));
			return;
		}

		let body: Buffer | undefined =
			req.method === "GET" || req.method === "HEAD"
				? undefined
				: await readRequestBody(req);
		if (
			body &&
			verdict.route.family === "anthropic" &&
			credential?.type === "oauth"
		) {
			// The same shaping the in-process path applies: without it Anthropic rejects a
			// subscription token outright. Done here because the child cannot do it — it has no
			// idea it is talking to a proxy.
			try {
				const parsed = JSON.parse(body.toString("utf8"));
				const reshaped = shapeAnthropicOAuthPayload(parsed);
				if (reshaped && reshaped !== parsed)
					body = Buffer.from(JSON.stringify(reshaped));
			} catch {
				// Not JSON, or not a messages payload — forward exactly as received.
			}
		}

		try {
			const upstream = await fetch(shaped.url, {
				method: req.method ?? "POST",
				headers: shaped.headers,
				body: body && body.length ? new Uint8Array(body) : undefined,
			});
			const outgoing: Record<string, string> = {};
			upstream.headers.forEach((value, name) => {
				// Length and encoding are recomputed for the connection we are answering on.
				if (name === "content-length" || name === "content-encoding") return;
				outgoing[name] = value;
			});
			res.writeHead(upstream.status, outgoing);
			if (upstream.body) {
				await new Promise<void>((resolve) => {
					const stream = Readable.fromWeb(upstream.body as any);
					stream.on("error", () => resolve());
					res.on("close", () => resolve());
					stream.pipe(res);
					res.on("finish", () => resolve());
				});
			} else {
				res.end();
			}
			logEvent("slot_proxy_forwarded", {
				slot: verdict.route.slotId,
				status: upstream.status,
			});
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			logEvent("slot_proxy_upstream_failed", {
				slot: verdict.route.slotId,
				reason,
			});
			if (!res.headersSent) {
				res.writeHead(502, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						error: { message: `upstream request failed: ${reason}` },
					}),
				);
			} else {
				res.end();
			}
		}
	}

	/** Start the loopback listener once, preferring a stable port so published routes survive. */
	function startSlotProxy(): Promise<number | undefined> {
		if (slotProxyPort !== undefined) return Promise.resolve(slotProxyPort);
		if (slotProxyStarting) return slotProxyStarting;
		slotProxyStarting = new Promise<number | undefined>((resolve) => {
			const server = createServer((req, res) => {
				handleProxyRequest(req, res).catch((error) => {
					logEvent("slot_proxy_handler_failed", {
						reason: error instanceof Error ? error.message : String(error),
					});
					try {
						if (!res.headersSent) res.writeHead(500);
						res.end();
					} catch {
						/* the socket is already gone */
					}
				});
			});
			// A WebSocket handshake that got past the request handler is closed at the socket, so
			// nothing is left half-open waiting for an upgrade this proxy will never perform.
			server.on("upgrade", (_req: any, socket: any) => {
				try {
					socket.destroy();
				} catch {
					/* already gone */
				}
			});
			// A dead listener must never take Pi down with it — the same rule the Cursor bridge
			// learned the hard way.
			server.on("error", (error: NodeJS.ErrnoException) => {
				if (
					error.code === "EADDRINUSE" &&
					server.listening === false &&
					!slotProxyPort
				) {
					// Another Pi process already holds the preferred port. Take any free one and
					// republish; both processes hold the same credentials, so either serves.
					server.listen(0, "127.0.0.1");
					return;
				}
				logEvent("slot_proxy_listen_failed", { reason: error.message });
				resolve(undefined);
			});
			server.listen(SLOT_PROXY_PORT, "127.0.0.1", () => {
				const address = server.address();
				slotProxyPort =
					typeof address === "object" && address ? address.port : undefined;
				slotProxyServer = server;
				server.unref(); // never hold Pi open on our account
				logEvent("slot_proxy_listening", { port: slotProxyPort });
				resolve(slotProxyPort);
			});
		}).finally(() => {
			slotProxyStarting = undefined;
		});
		return slotProxyStarting;
	}

	function stopSlotProxy() {
		try {
			slotProxyServer?.close();
		} catch {
			/* closing a server that never opened is not a problem */
		}
		slotProxyServer = undefined;
		slotProxyPort = undefined;
		slotProxyRoutes.clear();
	}

	/**
	 * Publish every numbered OAuth slot against the running proxy, so a child resolves the slot
	 * AND can authenticate to it. Without the second half the first is a trap.
	 */
	async function publishProxiedSlots(ctx: any): Promise<void> {
		if (!config.childProxy) return;
		slotProxyContext = ctx ?? slotProxyContext;
		const auth = readAuthFile();
		const slots = [...registeredSlots].filter(
			(id) => proxyFamilyOf(id) !== undefined && isEntryUsable(auth[id]),
		);
		if (slots.length === 0) return;
		const port = await startSlotProxy();
		if (port === undefined) return;
		for (const id of slots) {
			const family = proxyFamilyOf(id);
			if (!family) continue;
			slotProxyRoutes.set(id, { slotId: id, family });
			const baseUrl = publishedRouteFor(port, id);
			if (family === "anthropic") {
				provisionNativeSlot(id, {
					api: "anthropic-messages",
					baseUrl,
					apiKey: placeholderKeyFor(family),
					models: DEFAULT_ANTHROPIC_MODELS.map((modelId) => ({
						...anthropicModelDef(modelId, id),
						baseUrl,
					})),
				});
			} else {
				const cached = codexModelCatalogByProvider.get(id)?.models as
					| Array<Record<string, unknown>>
					| undefined;
				const models = (
					cached?.length ? cached : DEFAULT_CODEX_MODELS.map(codexModelDef)
				) as Array<Record<string, unknown>>;
				// Published as Codex's own API on purpose: Pi then shapes the body the way that
				// backend requires (`store: false`, the instructions field, its own headers), which
				// a generic `openai-responses` slot would not. The cost is that Pi insists on
				// reading an account id out of the key, which is why that family's placeholder is
				// JWT-shaped.
				provisionNativeSlot(id, {
					api: "openai-codex-responses",
					baseUrl,
					apiKey: placeholderKeyFor(family),
					models,
				});
			}
		}
		logEvent("slot_proxy_published", { port, slots });
	}

	function preflightHostCapabilities(ctx: any) {
		// SAFETY: ExtensionAPI is an object at runtime; this lookup only feature-detects optional
		// host methods and never invokes or otherwise trusts the asserted property value.
		const has = (name: string) =>
			typeof (pi as unknown as Record<string, unknown>)[name] === "function";
		const caps = {
			setModel: has("setModel"), // switch accounts at all
			registerProvider: has("registerProvider"), // register extra account slots
			sendUserMessage: has("sendUserMessage"), // fallback resume (inject prompt)
			continueAgent: has("continueAgent"), // seamless in-place resume
			on: has("on"),
			registerCommand: has("registerCommand"),
		};
		const canSwitch = caps.setModel;
		const canResume = caps.continueAgent || caps.sendUserMessage;
		const seamlessResume = caps.continueAgent;
		logEvent("host_capabilities", {
			version: VERSION,
			...caps,
			canSwitch,
			canResume,
			seamlessResume,
			...(oauthUnavailable ? { oauthUnavailable } : {}),
		});
		// One notice per process — informative, never nagging on every session.
		if (!preflightNotified) {
			preflightNotified = true;
			if (oauthUnavailable) {
				// The extension is alive (api-key accounts keep rotating) but no
				// subscription account can log in or refresh — say so plainly instead of
				// letting the user hit it mid-failover.
				ctx.ui?.notify?.(
					`pi-multi-account v${VERSION}: subscription (OAuth) logins are unavailable — ${oauthUnavailable}`,
					"warning",
				);
			}
			if (!canSwitch) {
				ctx.ui?.notify?.(
					`pi-multi-account v${VERSION}: this Pi build does not expose pi.setModel() — automatic account switching is IMPOSSIBLE on this host, so failover cannot work until it is restored. Check your @earendil-works/pi-coding-agent version.`,
					"error",
				);
			} else if (!canResume) {
				ctx.ui?.notify?.(
					`pi-multi-account v${VERSION}: this Pi build exposes neither pi.continueAgent() nor pi.sendUserMessage() — after a switch the task cannot auto-continue; you will have to re-send your prompt on the new account.`,
					"warning",
				);
			} else if (!seamlessResume) {
				ctx.ui?.notify?.(
					`pi-multi-account v${VERSION}: seamless in-place resume (pi.continueAgent) is not available on this Pi build — failover WILL still switch accounts and auto-continue by re-injecting your task as a fresh turn. This is the expected fallback, not an error.`,
					"info",
				);
			}
		}
		return { canSwitch, canResume, seamlessResume };
	}

	safeOn("session_start", async (_event, ctx) => {
		modelCatalogContext = ctx;
		preflightHostCapabilities(ctx);
		// Looked at BEFORE discovery touches anything, so what is judged is the files as Pi
		// published them rather than the version our own slot provisioning has just rewritten.
		checkPiContract(ctx, "session_start");
		refreshDiscovery(true, ctx);
		slotProxyContext = ctx;
		// Publish the OAuth slots against a route this process serves, so anything spawned
		// without this extension can actually run on the account the rotation chose.
		await publishProxiedSlots(ctx);
		// Not installed → silent skip (refreshCursorSlots warns only on the explicit path).
		if (config.includeCursor) await refreshCursorSlots(readAuthFile(), ctx);
		applyOnlyActiveFilter(ctx);
		pruneCooldowns();
		// Tight session binding: every session starts as a clean slate. Auto-resume only ever
		// runs *inside the live session that hit the limit* (its timer is armed by
		// setPendingContinuation). A new session — or a reopened one after a crash — must NEVER
		// inherit and silently restart a previous session's paused work, so we drop any leftover
		// pending state and reset all in-memory guards here.
		if (hasPendingResume()) clearPendingContinuation();
		autoContinuesThisPrompt = 0;
		userAbortedChain = false;
		watchdogAborting = false;
		expectingInjectedContinuation = false;
		recoveryFailures = 0;
		breakerOpenUntil = 0;
		responseCooldownHints.clear();
		handledAssistantErrors.clear();
		clearQueuedInputs();
		logEvent("session_start", {
			version: VERSION,
			enabled: config.enabled,
			rotation: rotation.length,
		});
		ctx.ui.notify(
			`pi-multi-account v${VERSION} loaded (${config.enabled ? "enabled" : "disabled"}). ${rotation.length} account(s) in rotation. Config: ${CONFIG_PATH}`,
			"info",
		);
		// Refresh every account BEFORE deciding the selected model is unavailable. Otherwise a
		// plan upgrade can revive the current account milliseconds after startup preflight has
		// already switched away from it using the old plan's stale 100% snapshot.
		await refreshRotationUsage(ctx);
		await syncCodexModelCatalog(ctx);
		await syncOllamaModelCatalog(ctx);
		// Pi restores the session model BEFORE extension catalogs finish registering
		// unless the factory returned the Cursor setup promise. Re-apply anyway: a
		// cold catalog, a compaction inner session, or a git-reset leftover can still
		// leave getModel(cursor, grok-4.6) empty.
		if (cursorReady) await cursorReady.catch(() => undefined);
		// Cursor slot catalogs changed too — same stale-hidden-copy repair as the model syncs.
		applyOnlyActiveFilter(ctx);
		emitModelCatalogSnapshot(ctx);
		await restoreRememberedModel(ctx);
		await ensureReadyModel(
			ctx,
			"startup preflight: selected account unavailable",
		);
		startUsageStatusTimer(ctx);
	});

	// CRITICAL: when the current session ends — for ANY reason (quit, reload, or replacement
	// by a new/resumed/forked session) — the extension's background activity must end with it.
	// Kill every timer and drop the pending continuation so nothing survives the session.
	safeOn("session_shutdown", async (_event, ctx) => {
		modelCatalogContext = undefined;
		rememberUserModel(ctx?.model);
		if (pendingWakeTimer) {
			clearTimeout(pendingWakeTimer);
			pendingWakeTimer = undefined;
		}
		clearQueuedInputs();
		clearPendingContinuation();
		clearUsageStatusTimer();
		endResumeWatch();
		// The published routes point at this process; nothing must be left listening after it.
		stopSlotProxy();
		watchdogAborting = false;
		expectingInjectedContinuation = false;
		userAbortedChain = false;
		autoContinuesThisPrompt = 0;
		manualPinnedProvider = undefined;
		failoverPinnedProvider = undefined;
		responseCooldownHints.clear();
		handledAssistantErrors.clear();
		ctx?.ui?.setStatus?.("multi-account-quota", undefined);
	});

	// Pi cancelled compaction (or it failed). If we had queued user input for the cooldown,
	// those messages would sit forever — flush them now so the queue is not the dead end.
	safeOn("compaction_end", (event: any, ctx: any) => {
		if (queuedUserInputs.length === 0) return;
		if (!ctx.isIdle()) return;
		runBackground("post-compaction queued flush", ctx, () =>
			attemptQueuedInputResume(ctx),
		);
	});

	// Forward-progress signals: any of these means the resumed turn is alive, so reset the
	// stuck watchdog. Cheap no-ops when no resume is in flight.
	for (const evt of [
		"turn_start",
		"message_start",
		"message_update",
		"tool_execution_update",
	] as const) {
		safeOn(evt, () => {
			noteResumeProgress();
		});
	}
	// Async re-registrations (Cursor/Codex catalog discovery) restore full model lists
	// behind the filter's back; re-narrow at the start of every turn.
	safeOn("message_start", (_event, ctx) => applyOnlyActiveFilter(ctx));
	// Tool lifecycle also adjusts the in-flight count so a long, silent build/test command is
	// never mistaken for a wedge and aborted mid-run.
	safeOn("tool_execution_start", () => {
		toolInFlight++;
		noteResumeProgress();
	});
	safeOn("tool_execution_end", () => {
		toolInFlight = Math.max(0, toolInFlight - 1);
		noteResumeProgress();
	});

	safeOn("input", async (event, ctx) => {
		if (!config.enabled || (event as any).source === "extension" || !ctx.isIdle())
			return { action: "continue" as const };
		const text =
			typeof (event as any).text === "string" ? (event as any).text : "";
		// Slash commands and shell shortcuts belong to Pi itself. Holding them in the cooldown queue
		// makes /login, /model, /export, and even recovery commands appear completely broken.
		if (/^\s*[/!]/.test(text)) return { action: "continue" as const };
		autoContinuesThisPrompt = 0;
		userAbortedChain = false;
		noteRecoveryProgress(); // a fresh user prompt → clean slate, re-enable auto-continue
		if (hasPendingResume()) clearPendingContinuation();
		// A manual choice is owed ONE message. This is the next one, so a reprieve that already
		// carried a message retires here — before the readiness check consults it.
		retireSpentManualPin();
		retireSpentFailoverPin();

		if (await ensureReadyModel(ctx, "preflight: selected account unavailable")) {
			return { action: "continue" as const };
		}

		const delay = nextModelAvailabilityDelayMs(ctx);
		if (delay !== undefined) {
			queueUserInput(ctx, text, (event as any).images);
			return { action: "handled" as const };
		}

		const providers = [
			...new Set(
				activeFallbacks()
					.map((target) => parseTarget(target)?.provider)
					.filter(Boolean),
			),
		];
		const slotHint =
			providers.length > 0 ? ` Select one of: ${providers.join(", ")}.` : "";
		// Selection came up empty — but WHY it came up empty is the whole message. Reporting
		// "no authenticated account exists" for every empty result told people with several
		// logged-in accounts, quota still showing on them, that they had none. That reads as the
		// extension failing to see accounts it can plainly list in `status`, and it buries the one
		// action that fixes it. Say which accounts exist and what is actually wrong with them.
		// Invalidated accounts are dropped from `rotation` by design, so the rotation list is the
		// one place that cannot name them — read the accounts themselves.
		const auth = readAuthFile();
		const deadAuth = [...invalidatedByProvider.keys()].filter((provider) =>
			isEntryUsable(auth[provider]),
		);
		const unconfigured = unconfiguredRotationMembers(ctx);
		if (deadAuth.length > 0 || unconfigured.length > 0) {
			const parts: string[] = [];
			if (deadAuth.length > 0)
				parts.push(
					`${deadAuth.join(", ")} — authorization expired, so re-login is the only fix: run /login, choose "Use a subscription", then select each of them`,
				);
			if (unconfigured.length > 0)
				parts.push(
					`${unconfigured.join(", ")} — logged in, but Pi knows no model for them, so they cannot be selected`,
				);
			ctx.ui.notify(
				`Provider failover: every account is currently unusable. ${parts.join(". ")}.`,
				"error",
			);
			return { action: "handled" as const };
		}
		ctx.ui.notify(
			`Provider failover: no usable authenticated account exists. Run /login, choose "Use a subscription", then select an account slot.${slotHint}`,
			"error",
		);
		return { action: "handled" as const };
	});

	// Distinguish a genuine new user prompt from our own failover continuation. Only a
	// genuine prompt resets the per-task auto-continue counter and cancels any pending
	// resurrection — this is what stops maxAutoContinuesPerPrompt from resetting every
	// iteration (the bug that let the failover loop run forever).
	safeOn("before_agent_start", async (_event, ctx) => {
		await ensureReadyModel(
			ctx,
			"last-moment preflight: selected account unavailable",
		);
		// Our own injected continuation (recovery fallback) must NOT be mistaken for a genuine
		// new user prompt — otherwise it resets the auto-continue counter every iteration and the
		// recovery loop becomes unbounded. Preserve the chain in that case.
		if (expectingInjectedContinuation) {
			expectingInjectedContinuation = false;
			continuationDispatchedForAgentTurn = true; // this turn IS the continuation
			return;
		}
		// Genuine user input → fresh task: reset the chain and stop any auto-resume.
		autoContinuesThisPrompt = 0;
		userAbortedChain = false;
		continuationDispatchedForAgentTurn = false;
		if (hasPendingResume()) clearPendingContinuation();
	});

	safeOn("agent_start", async (_event, ctx) => {
		noteResumeProgress(); // a resumed turn actually started → it is making progress
		currentPromptSwitch = undefined;
		automaticModelTarget = undefined;
		responseCooldownHints.clear();
		handledAssistantErrors.clear();
		captureDesiredThinking(ctx); // remember the level BEFORE any failover can clamp it
		refreshDiscovery(false, ctx); // also refresh Pi's in-memory AuthStorage
		if (!usageStatusTimer) startUsageStatusTimer(ctx);
		updateUsageStatus(ctx);
	});

	safeOn("model_select", (event, ctx) => {
		const model = (event as any).model;
		if (!model?.provider || !model?.id) return;
		updateUsageStatus(ctx, model.provider);
		runBackground("model_select usage refresh", ctx, () =>
			refreshUsage(ctx, model.provider),
		);
		const selected = ref(model.provider, model.id);
		if (automaticModelTarget === selected) {
			automaticModelTarget = undefined;
			rememberUserModel(model);
			return;
		}
		if ((event as any).source === "restore") return;
		rememberUserModel(model);
		// A manual model change is user control, not a permanent "never fail over" pin.
		// Cancel stale pending work; if the selected model then returns a real limit, normal
		// failover still applies to that completed request.
		currentPromptSwitch = undefined;
		userAbortedChain = false;
		if (hasPendingResume()) clearPendingContinuation();
	});

	safeOn("after_provider_response", (event, ctx) => {
		noteResumeProgress(); // a provider response arrived → the resumed turn is alive
		if (ctx.model && usageFamily(ctx.model.provider) === "codex") {
			const entry = readAuthFile()[ctx.model.provider];
			const snapshot = parseCodexUsageHeaders(
				ctx.model.provider,
				(event as any).headers ?? {},
				Date.now(),
				entry ? credentialHash(entry) : undefined,
			);
			if (snapshot) storeUsage(ctx, snapshot);
		}
		if (!config.enabled) return;
		const status = (event as any).status;
		if (status < 400 && ctx.model) {
			noteAuthSuccess(ctx.model.provider, ctx.model.id);
			noteRecoveryProgress(); // a good response → recovery works → close the breaker
			responseCooldownHints.delete(ctx.model.provider);
			return;
		}
		if ((status === 429 || status === 402 || status === 403) && ctx.model) {
			// Only set cooldown hints for providers this extension manages.
			// Without this guard, a 429 on any provider pollutes cooldown state.
			if (!classifyProvider(ctx.model.provider, config.qwenProvider)) return;
			const cooldownMs = cooldownFromHeaders((event as any).headers ?? {});
			if (cooldownMs !== undefined) {
				responseCooldownHints.set(
					ctx.model.provider,
					Math.max(responseCooldownHints.get(ctx.model.provider) ?? 0, cooldownMs),
				);
			}
		}
	});

	safeOn("message_end", async (event, ctx) => {
		const message = (event as any).message;
		if (message?.role !== "assistant") return;
		if (message.stopReason !== "error") {
			if (message.provider) noteAuthSuccess(message.provider, message.model);
			return;
		}
		if (userAbortedChain || ctx.signal?.aborted) return; // user is cancelling — don't fail over
		const errorText = assistantErrorText(message);
		const provider =
			typeof message.provider === "string"
				? message.provider
				: ctx.model?.provider;
		const modelId =
			typeof message.model === "string" ? message.model : ctx.model?.id;
		if (!provider || !modelId) return;
		// Normally we only react to errors from providers this extension manages. But if the
		// user's ACTIVE model is on an unmanaged provider (e.g. a plain `openai` API key that hit
		// its billing quota — "You exceeded your current quota"), we still rescue the task by
		// failing over to a managed account, which is exactly what the user expects. We only skip
		// errors from unmanaged providers that are NOT the model the user is currently on (those
		// are unrelated background errors we must not hijack).
		const managed = !!classifyProvider(provider, config.qwenProvider);
		const isCurrentModelProvider = provider === ctx.model?.provider;
		if (!managed && !isCurrentModelProvider) return;
		const errorKey = `${provider}/${modelId}:${message.timestamp ?? "unknown"}:${errorText}`;
		if (handledAssistantErrors.has(errorKey)) return;
		handledAssistantErrors.add(errorKey);
		const failedModel = ctx.modelRegistry.find(provider, modelId) ?? {
			provider,
			id: modelId,
		};
		logEvent("assistant_error", {
			provider,
			model: modelId,
			classified: isAuthError(errorText)
				? "auth"
				: isContextOverflowError(errorText)
					? "context_overflow"
					: isLimitError(errorText)
						? "limit"
						: isModelError(errorText)
							? "model"
							: isTransientError(errorText)
								? "transient"
								: "unhandled",
			error: errorText,
		});

		// Unmanaged active provider (e.g. plain `openai` API quota): we cannot manage its
		// cooldown/refresh lifecycle, but we rescue the task by switching to a managed account on
		// any actionable error. scope:"model" + a short cooldown so we never poison a provider we
		// don't own.
		if (!managed) {
			// Opt-out for unmanaged providers that run their own retry logic (usually a companion
			// extension owning retries for that provider). Switching accounts underneath it would
			// fight those retries, so leave the turn alone entirely.
			if (config.neverFailoverProviders.includes(provider)) {
				logEvent("failover_suppressed", {
					provider,
					model: modelId,
					reason: "neverFailoverProviders",
				});
				return;
			}
			// A quota or authorization refusal is about the ACCOUNT, not the model, and it does not
			// clear in a minute: an unmanaged account out of credits refuses everything until it is
			// topped up. Benching only the model for `transientCooldownMs` let the very next switch
			// pick the same account, get the same refusal, and close the loop — which is precisely
			// how a session ended up answering every user message with the same "out of credits"
			// error while live accounts sat unused. Transient blips and model-specific errors keep
			// the light touch, because those genuinely are momentary or model-scoped.
			const accountLevel = isLimitError(errorText) || isAuthError(errorText);
			if (accountLevel || isModelError(errorText) || isTransientError(errorText)) {
				await switchToFallback(
					ctx,
					failedModel,
					`external provider out of quota: ${errorText.slice(0, 100)}`,
					accountLevel ? config.cooldownMs : config.transientCooldownMs,
					{ scope: accountLevel ? "provider" : "model" },
				);
			}
			return;
		}

		if (isAuthError(errorText)) {
			let killed = false;
			let reason = errorText;
			if (
				isRefreshable(provider) &&
				patternMatch(errorText, FORCE_REFRESH_AUTH_ERROR_PATTERNS)
			) {
				const refresh = await forceRefreshProvider(ctx, provider);
				if (refresh.status === "refreshed") {
					noteAuthSuccess(provider, modelId);
					const target = ref(provider, modelId);
					currentPromptSwitch = {
						from: target,
						to: target,
						reason:
							"OAuth access token was revoked early and refreshed automatically",
						at: Date.now(),
					};
					ctx.ui.notify(
						`Provider failover: ${provider} access token was invalidated, refreshed successfully, and will retry on the same account.`,
						"info",
					);
					return;
				}
				if (refresh.status === "terminal") {
					reason = `OAuth refresh failed permanently: ${refresh.error}`;
					markInvalid(provider, reason);
					killed = true;
				} else if (refresh.status === "transient") {
					reason = `OAuth refresh failed temporarily: ${refresh.error}`;
					markExhausted(provider, config.transientCooldownMs);
				} else {
					killed = markAuthFailure(provider, errorText);
				}
			} else {
				killed = markAuthFailure(provider, errorText);
			}
			if (killed) {
				// For a Claude login, "run /login" alone sends people round a loop they have often
				// already been round: log in, work for a few hours, get kicked out, log in again.
				// The reason is not in the error text and cannot be guessed from it — every CLI that
				// signs into Claude Pro/Max uses the SAME client id, and Anthropic keeps one live
				// refresh token per account for that client. So signing the same account into another
				// tool, another machine, or a second slot here revokes this one, quietly, hours later.
				// Naming that is the difference between a fix and a ritual.
				const sharedClientHint =
					classifyProvider(provider, config.qwenProvider) === "anthropic" &&
					/invalid_grant|revoked/i.test(reason)
						? " Its refresh token was revoked server-side. Claude Pro/Max logins from every CLI share one client id and Anthropic keeps a single live refresh token per account, so signing this same account into another tool (Claude Code, another machine, or a second slot here) revokes this one. Use a different Claude account per slot, and keep the account another tool is signed into out of this rotation."
						: "";
				ctx.ui.notify(
					`Provider failover: ${provider} authorization is invalid. Run /login, choose "Use a subscription", then select ${provider}.${sharedClientHint}`,
					"warning",
				);
			}
			// A killed account is already in invalidatedByProvider (no cooldown entry needed —
			// that was the v1.8.x "8696h cooldown" bug). A transient auth failure gets the brief
			// TRANSIENT_AUTH_COOLDOWN_MS so selection skips it for a moment and Pi can refresh.
			const cooldownMs = killed ? 0 : TRANSIENT_AUTH_COOLDOWN_MS;
			await switchToFallback(
				ctx,
				failedModel,
				killed
					? `auth invalid: ${reason.slice(0, 100)}`
					: `transient auth failure: ${reason.slice(0, 100)}`,
				cooldownMs,
			);
			return;
		}
		if (isLimitError(errorText)) {
			const cooldownMs = await resolveLimitCooldownMs(ctx, provider, errorText);
			responseCooldownHints.delete(provider);
			await switchToFallback(
				ctx,
				failedModel,
				`assistant error: ${errorText.slice(0, 120)}`,
				cooldownMs,
			);
			return;
		}
		if (isModelError(errorText)) {
			await switchToFallback(
				ctx,
				failedModel,
				`model unavailable: ${errorText.slice(0, 120)}`,
				config.transientCooldownMs,
				{ scope: "model" },
			);
			return;
		}
		if (isTransientError(errorText)) {
			const reason = `${TRANSIENT_PENDING_PREFIX} ${errorText.slice(0, 120)}`;
			markExhausted(provider, config.transientCooldownMs);
			if (!config.autoContinue) {
				ctx.ui.notify(
					`Provider failover: temporary server error on ${provider}/${modelId}. Retry manually in ~${formatDelay(config.transientCooldownMs)}.`,
					"warning",
				);
				return;
			}
			setPendingContinuation(ctx, failedModel, reason);
		}
	});

	safeOn("agent_end", async (event, ctx) => {
		const stop = lastAssistantStopReason((event as any).messages ?? []);
		// Our own watchdog aborted a wedged resumed turn — this is RECOVERY, not a user cancel.
		// Arm auto-resume so the work continues by itself the moment any account is free again;
		// the user should never have to re-type the prompt to get unstuck.
		if (watchdogAborting) {
			watchdogAborting = false;
			endResumeWatch();
			const failed = ctx.model?.provider && ctx.model?.id ? ctx.model : undefined;
			currentPromptSwitch = undefined;
			continuationDispatchedForAgentTurn = false;
			if (failed && config.enabled && config.autoContinue) {
				setPendingContinuation(
					ctx,
					failed,
					"auto-recovered a stuck resume; waiting for an account to free up",
				);
			}
			return;
		}
		// Respect the user: if they pressed Esc, the last assistant message is "aborted".
		if (stop === "aborted" || ctx.signal?.aborted) {
			userAbortedChain = true;
			clearPendingContinuation();
			currentPromptSwitch = undefined;
			continuationDispatchedForAgentTurn = false;
			endResumeWatch();
			return;
		}
		// The resumed/continued turn has ended — stop watching it for stalls.
		endResumeWatch();
		// CRITICAL (fixes "Cannot continue from message role: assistant"): only resume when the
		// turn actually ended in an ERROR we can continue from. A non-error end means the work
		// already advanced on the (switched) account; there is nothing to resume. The old code
		// kept currentPromptSwitch set across later agent_end cycles and re-dispatched a resume
		// on a SUCCESSFUL assistant tail, which threw that cryptic error into the transcript.
		if (stop !== "error") {
			currentPromptSwitch = undefined;
			continuationDispatchedForAgentTurn = false;
			return;
		}
		if (continuationDispatchedForAgentTurn) {
			continuationDispatchedForAgentTurn = false;
			return;
		}
		if (!config.enabled || !config.autoContinue || userAbortedChain) return;
		await maybeDispatchContinuation(ctx);
	});

	// Pi `await`s the factory. Returning the Cursor setup promise means
	// createAgentSession's getModel(cursor, cursor-grok-4.6) runs AFTER fallback
	// models are registered, so the host restore does not print
	// "Could not restore model" and dump the session onto kimi/anthropic.
	return cursorReady;
}
