/** Failover configuration defaults and normalization. No session/event registration. */

import { type ProviderFamily, DEFAULT_QWEN_PROVIDER } from "./provider-ids.ts";
import { DEFAULT_PROVIDER_PRIORITY, normalizePriority } from "./provider-priority.ts";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { CONFIG_PATH } from "./agent-paths.ts";
import { dirname } from "node:path";

export type ReasoningLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";
// Reasoning levels ordered weakest → strongest. Used to tell a host clamp (a drop forced by a
// weaker fallback model) apart from a deliberate change by the user.
export const REASONING_LEVELS: ReasoningLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];
// "auto" = follow the session's own level (per-agent `--thinking`, `/thinking`) instead of
// forcing a global one. Any explicit level still forces that level on every turn.
type ReasoningLevelSetting = ReasoningLevel | "auto";

type ProviderFailoverConfig = {
	enabled?: boolean;
	autoContinue?: boolean;
	autoDiscover?: boolean;
	autoDiscoverModels?: boolean;
	maxAccountsPerProvider?: number;
	includeQwen?: boolean;
	qwenProvider?: string;
	includeOllama?: boolean;
	/**
	 * Let providers outside the five specially-managed families take part in rotation — any
	 * account with a usable key that Pi already knows how to call. Off is for someone paying per
	 * token who does not want background failover spending a plain API key.
	 */
	includeOtherProviders?: boolean;
	includeCursor?: boolean;
	/**
	 * Serve OAuth rotation slots to extension-free children through a parent-owned loopback
	 * route. Off means such a child cannot use those accounts at all and silently reroutes to
	 * whichever provider Pi finds first.
	 */
	childProxy?: boolean;
	/**
	 * When true, `/model` shows only the currently active rotation account: every other
	 * provider is re-registered with an empty model list (its auth and OAuth config are
	 * preserved by Pi's merge) and restored on switch or when the flag goes off.
	 */
	onlyActive?: boolean;
	/**
	 * Provider ids this extension must never fail away from, even on an actionable error.
	 *
	 * For providers we do not manage (no cooldown/refresh lifecycle of ours) that run their own
	 * retry logic — typically a companion extension that owns retries for that provider. Failing
	 * over would fight it: we would switch accounts while the other extension is mid-retry.
	 * Only meaningful for unmanaged providers; a managed account still cools and rotates normally.
	 */
	neverFailoverProviders?: string[];
	providerOrder?: ProviderFamily[];
	// Where work goes once EVERY account of the current family is spent. An ordered list of
	// provider groups — a managed family, or the base id of anything else you are logged in to
	// (`openrouter`, `zai`, `minimax`…), which `providerOrder` could never name. Same-family
	// failover always runs first and is not affected; an account on a real cooldown is still never
	// chosen over a free one. Only the order among candidates that are all selectable right now
	// changes. Anything unlisted sorts after everything listed. Set with
	// `/multi-account priority ...`.
	providerPriority?: string[];
	cooldownMs?: number;
	transientCooldownMs?: number;
	showUsage?: boolean;
	usageRefreshMs?: number;
	usageStatusRefreshMs?: number;
	pendingPollMs?: number;
	maxAutoContinuesPerPrompt?: number;
	fallbacks?: string[];
	limitErrorPatterns?: string[];
	authErrorPatterns?: string[];
	transientErrorPatterns?: string[];
	modelErrorPatterns?: string[];
	ignoreErrorPatterns?: string[];
	continuationPrompt?: string;
	// Hard ceiling on how long ANY prediction may stop us from simply trying an account again.
	// Providers reset quota windows early and without notice, and they resize the windows
	// themselves — so a reset timestamp, a "try again in N min" sentence and a used-percentage are
	// all forecasts, not facts. The only fact is what the account answers when asked. Default: 10
	// minutes. Set higher to probe less often, never to "trust" a provider's own estimate.
	maxRecheckIntervalMs?: number;
	// Rewrite the interrupted turn into a verbatim `user` handoff record so the account
	// taking over still sees exactly where the previous one stopped. Without this, pi-ai
	// drops the interrupted assistant message entirely before the next request is built,
	// so the continuation lands on an account that cannot see the work it is told not to
	// repeat. Default: true.
	preserveInterruptedContext?: boolean;
	// When a resumed turn wedges (silent past stuckWatchdogMs with no tool running), auto-cancel
	// it and auto-resume when an account frees, instead of only notifying. Default: true.
	autoRecoverStuck?: boolean;
	// Write a structured "black box" decision log to provider-failover-debug.log. Default: true.
	// Contains no credentials — only provider/model ids, decisions, and truncated reasons.
	debugLog?: boolean;
	// Always upgrade to the newest available model on failover instead of carrying a
	// previously-downgraded model forward forever. Default: true.
	preferLatestModel?: boolean;
	// Reasoning effort to preserve across model/account switches. Default: "auto" — the level
	// the session actually runs at (per-agent `--thinking`, `/thinking`, your Pi default) is
	// honoured and only restored after a switch, never overridden. Set an explicit level to
	// FORCE it on every turn regardless of the session. Extreme levels such as xhigh are
	// opt-in only.
	reasoningLevel?: ReasoningLevelSetting;
	// Per-family override of the preferred model order (newest first). Lets you pin the
	// latest model for each provider WITHOUT a code change when a new one ships, e.g.
	// { "openai-codex": ["gpt-5.6", "gpt-5.5"], "anthropic": ["claude-opus-4-9"] }.
	// Keys: anthropic | openai-codex | cursor | qwen | ollama.
	preferredModels?: Record<string, string[]>;
	// Forward-progress watchdog tunables (see constants above). 0/absent ⇒ built-in default.
	resumeIdleTimeoutMs?: number;
	stuckWatchdogMs?: number;
};

type RuntimeConfig = Required<ProviderFailoverConfig>;
const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const DEFAULT_TRANSIENT_COOLDOWN_MS = 60 * 1000;
const DEFAULT_USAGE_REFRESH_MS = 5 * 60 * 1000;
const DEFAULT_USAGE_STATUS_REFRESH_MS = 60 * 1000;
// Default ceiling on any predicted unavailability. Every number a provider gives us about the
// FUTURE — reset timestamps, "try again in N min", used-percentage against a quota size the
// provider can resize at will — is a forecast that goes stale silently the moment the provider
// refreshes a window early. Rather than trying to predict better, we cap how long any forecast
// may prevent us from simply asking the account again. A rejected request costs no tokens, so
// re-asking is close to free; only a successful one proves availability.
const MAX_RECHECK_INTERVAL_MS = 10 * 60 * 1000;
// While a session is paused waiting for ANY account to recover, never sleep longer than this
// between availability checks. A single multi-hour timer would miss an account that recovers
// earlier than its recorded estimate (or a fresh /login in a parallel session); polling lets the
// first account that is ACTUALLY free pick the work back up.
const PENDING_POLL_MS = 60 * 1000;

// --- Forward-progress watchdogs (v1.12.0) ----------------------------------
// A resumed/rotated turn must NEVER be able to hang the session forever. The old
// code awaited pi.continueAgent() and busy-waited on ctx.isIdle() with no upper
// bound, so any stall (a wedged compaction, a provider socket that never returns,
// an account that quietly accepts the request but never streams) showed the user a
// spinning "working" animation with zero progress and no way to tell it was dead.
// These bounds turn whole CLASSES of "it just hangs" — including ones never
// individually enumerated — into a visible, recoverable state.
const RESUME_IDLE_TIMEOUT_MS = 90 * 1000; // max wait for the prior turn to go idle before we stop blocking
const STUCK_WATCHDOG_MS = 180 * 1000; // total silence (no stream/tool/response) on a resumed turn ⇒ "stuck"

const DEFAULT_LIMIT_PATTERNS = [
	"429",
	"rate limit",
	"rate_limit",
	"too many requests",
	"usage limit",
	"usage_limit_reached",
	"usage_not_included",
	"quota",
	"insufficient_quota",
	"out of budget",
	"available balance",
	"billing hard limit",
	"monthly usage limit",
	"freeusagelimiterror",
	"gousagelimiterror",
	// "Payment required" — the account's credits or free allowance no longer cover the request.
	// This is a limit like any other: the account cannot serve work until it is topped up, so it
	// must cool down and rotation must move on. Left unrecognised, a session parked on such an
	// account produced the same refusal for every user message forever, because nothing
	// classified the error and therefore nothing switched away. Matched on prose rather than the
	// bare status code: `402` as a substring also occurs inside token counts ("38402 tokens").
	"payment required",
	"limit_source",
	"remaining balance",
	"upgrade to a paid account",
	"insufficient credits",
	"insufficient_credits",
	"out of credits",
	"credit balance is too low",
	"add credits",
	"third-party apps now draw from your extra usage",
	// gRPC status code for quota exhaustion. Cursor (and other OpenAI-compatible backends
	// fronted by gRPC) surface a per-account quota wall as `resource_exhausted`, not a 429.
	// Without this entry the refusal is unclassified → no failover → every turn dies on the
	// spent account forever. Treated as a limit so the account cools down and rotation moves on.
	"resource_exhausted",
];

// Errors that mean "this account's authorization is dead" → drop from rotation
// until the user re-logs in (not a temporary cooldown).
const DEFAULT_AUTH_ERROR_PATTERNS = [
	"401",
	"unauthorized",
	"authentication_error",
	"authentication token has been invalidated",
	"token has been invalidated",
	"invalid authentication",
	"invalid_token",
	"invalid token",
	"token has expired",
	"token expired",
	"expired token",
	"invalid_grant",
	"invalid api key",
	"incorrect api key",
	"no api key",
	"missing api key",
	"revoked",
	"oauth token",
];

const DEFAULT_TRANSIENT_ERROR_PATTERNS = [
	"408",
	"425",
	"500",
	"502",
	"503",
	"504",
	"529",
	"overloaded",
	"service unavailable",
	"temporarily unavailable",
	"internal server error",
	"bad gateway",
	"gateway timeout",
	"request timeout",
	"timed out",
	"timeout",
	"connection reset",
	"econnreset",
	"econnrefused",
	"enetunreach",
	"fetch failed",
	"network error",
	"socket hang up",
	"stream disconnected",
	"websocket error",
	"server error",
];

const DEFAULT_MODEL_ERROR_PATTERNS = [
	"model_not_found",
	"model not found",
	"unsupported model",
	"unknown model",
	"model is unavailable",
	"model unavailable",
	"does not have access to model",
	"do not have access to model",
];

export const DEFAULT_IGNORE_PATTERNS = [
	"context overflow",
	"context window",
	"context length",
	"maximum context",
	"too many tokens",
	"token limit exceeded",
	"input is too long",
];

const DEFAULT_CONTINUATION_PROMPT = [
	"Provider failover activated: switched to {to} after {from} hit a quota or rate limit.",
	"Continue the interrupted task from where it stopped.",
	"The interrupted turn itself is preserved verbatim in this session as a [handoff:interrupted-turn] record — read it before acting:",
	"it contains the reasoning and output of that turn plus every tool call it issued, marking which ones never returned a result.",
	"Anything shown there was already attempted, so verify the current state instead of redoing it, and do not restart the task from the beginning.",
].join(" ");

export const DEFAULT_PROVIDER_ORDER: ProviderFamily[] = [
	"anthropic",
	"openai-codex",
	"kimi-coding",
	"antigravity",
	"cursor",
	"qwen",
	"ollama",
];

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

function ensureDefaultConfig() {
	if (existsSync(CONFIG_PATH)) return;
	mkdirSync(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
	writeFileSync(CONFIG_PATH, `${JSON.stringify(normalizeConfig({}), null, "\t")}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
}

function positiveOr(value: unknown, fallback: number) {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: fallback;
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

/**
 * The error vocabulary is a dictionary that GROWS with each release, so a user's list is merged
 * with the built-in one rather than replacing it.
 *
 * `/multi-account` writes the full config to disk, defaults included, so nearly every installed
 * config contains a frozen snapshot of the vocabulary that shipped the day it was written. Under
 * replace-semantics that snapshot permanently pinned the classifier: a newly recognised refusal —
 * say a provider that starts answering "payment required" — was understood on a fresh install and
 * invisible on every machine that had ever run the command. That is exactly backwards, because
 * the machines with a config are the ones in use. Anything the user adds still takes effect; they
 * simply cannot silently miss a term added later.
 */
function patternsWithDefaults(value: unknown, defaults: string[]): string[] {
	const merged = [...defaults];
	for (const pattern of stringArray(value)) {
		if (!merged.some((known) => known.toLowerCase() === pattern.toLowerCase()))
			merged.push(pattern);
	}
	return merged;
}

export function normalizeConfig(raw: ProviderFailoverConfig): RuntimeConfig {
	// A saved `providerOrder` states a PREFERENCE about sequence, never a whitelist of which
	// families may exist. `/multi-account` writes the whole config out, so every installed config
	// froze the family list as it stood the day it was written — and a family promoted to managed
	// later then fell through both doors at once: too new for the saved order, no longer eligible
	// as an "other" provider because it is managed now. The account simply disappeared from the
	// ring, with `rediscover` unable to help because discovery was working exactly as written.
	// Families the user never ranked are appended in their default order, after the ones they did.
	const configured =
		Array.isArray(raw.providerOrder) && raw.providerOrder.length > 0
			? raw.providerOrder
			: DEFAULT_PROVIDER_ORDER;
	const order = [
		...configured,
		...DEFAULT_PROVIDER_ORDER.filter((family) => !configured.includes(family)),
	];
	return {
		enabled: raw.enabled ?? true,
		autoContinue: raw.autoContinue ?? true,
		autoDiscover: raw.autoDiscover ?? true,
		autoDiscoverModels: raw.autoDiscoverModels ?? true,
		maxAccountsPerProvider: Math.max(
			1,
			Math.floor(positiveOr(raw.maxAccountsPerProvider, 10)),
		),
		includeQwen: raw.includeQwen ?? true,
		qwenProvider: raw.qwenProvider?.trim() || DEFAULT_QWEN_PROVIDER,
		includeOllama: raw.includeOllama ?? true,
		includeOtherProviders: raw.includeOtherProviders ?? true,
		includeCursor: raw.includeCursor ?? true,
		childProxy: raw.childProxy ?? true,
		onlyActive: raw.onlyActive ?? false,
		neverFailoverProviders: stringArray(raw.neverFailoverProviders),
		providerOrder: order.filter(
			(f): f is ProviderFamily =>
				f === "anthropic" ||
				f === "openai-codex" ||
				f === "kimi-coding" ||
				f === "antigravity" ||
				f === "cursor" ||
				f === "qwen" ||
				f === "ollama",
		),
		// An explicitly empty list means "no stated preference" and is honoured as such; only an
		// absent key falls back to the shipped ladder.
		providerPriority: Array.isArray(raw.providerPriority)
			? normalizePriority(raw.providerPriority)
			: [...DEFAULT_PROVIDER_PRIORITY],
		cooldownMs: positiveOr(raw.cooldownMs, DEFAULT_COOLDOWN_MS),
		transientCooldownMs: positiveOr(
			raw.transientCooldownMs,
			DEFAULT_TRANSIENT_COOLDOWN_MS,
		),
		showUsage: raw.showUsage ?? true,
		usageRefreshMs: positiveOr(raw.usageRefreshMs, DEFAULT_USAGE_REFRESH_MS),
		usageStatusRefreshMs: positiveOr(
			raw.usageStatusRefreshMs,
			DEFAULT_USAGE_STATUS_REFRESH_MS,
		),
		pendingPollMs: positiveOr(raw.pendingPollMs, PENDING_POLL_MS),
		maxAutoContinuesPerPrompt: Math.floor(
			positiveOr(raw.maxAutoContinuesPerPrompt, 8),
		),
		fallbacks: stringArray(raw.fallbacks),
		limitErrorPatterns: patternsWithDefaults(
			raw.limitErrorPatterns,
			DEFAULT_LIMIT_PATTERNS,
		),
		authErrorPatterns: patternsWithDefaults(
			raw.authErrorPatterns,
			DEFAULT_AUTH_ERROR_PATTERNS,
		),
		transientErrorPatterns: patternsWithDefaults(
			raw.transientErrorPatterns,
			DEFAULT_TRANSIENT_ERROR_PATTERNS,
		),
		modelErrorPatterns: patternsWithDefaults(
			raw.modelErrorPatterns,
			DEFAULT_MODEL_ERROR_PATTERNS,
		),
		ignoreErrorPatterns: patternsWithDefaults(
			raw.ignoreErrorPatterns,
			DEFAULT_IGNORE_PATTERNS,
		),
		continuationPrompt:
			raw.continuationPrompt?.trim() || DEFAULT_CONTINUATION_PROMPT,
		maxRecheckIntervalMs: positiveOr(
			raw.maxRecheckIntervalMs,
			MAX_RECHECK_INTERVAL_MS,
		),
		preserveInterruptedContext: raw.preserveInterruptedContext ?? true,
		autoRecoverStuck: raw.autoRecoverStuck ?? true,
		debugLog: raw.debugLog ?? true,
		preferLatestModel: raw.preferLatestModel ?? true,
		// Anything unset/invalid means "auto": follow the session's own level. Forcing a level
		// here would clobber per-agent `--thinking` on every turn (issue #6).
		reasoningLevel:
			raw.reasoningLevel === "off" ||
			raw.reasoningLevel === "minimal" ||
			raw.reasoningLevel === "low" ||
			raw.reasoningLevel === "medium" ||
			raw.reasoningLevel === "high" ||
			raw.reasoningLevel === "xhigh" ||
			raw.reasoningLevel === "max"
				? raw.reasoningLevel
				: "auto",
		preferredModels:
			raw.preferredModels && typeof raw.preferredModels === "object"
				? Object.fromEntries(
						Object.entries(raw.preferredModels)
							.map(([k, v]) => [k, stringArray(v)] as const)
							.filter(([, v]) => v.length > 0),
					)
				: {},
		resumeIdleTimeoutMs: positiveOr(
			raw.resumeIdleTimeoutMs,
			RESUME_IDLE_TIMEOUT_MS,
		),
		stuckWatchdogMs: positiveOr(raw.stuckWatchdogMs, STUCK_WATCHDOG_MS),
	};
}

export function loadConfig(): RuntimeConfig {
	ensureDefaultConfig();
	try {
		return normalizeConfig(
			JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as ProviderFailoverConfig,
		);
	} catch {
		return normalizeConfig({});
	}
}
