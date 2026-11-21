/** Versioned failover state persistence. Migration and best-effort writes stay here. */

import { type ModelRef, classifyProvider, DEFAULT_QWEN_PROVIDER } from "./provider-ids.ts";
import { type UsageSnapshot } from "./usage.ts";
import { type CodexCatalogSnapshot } from "./model-catalog.ts";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { AGENT_DIR, AUTH_PATH, CONFIG_PATH, MODELS_CONFIG_PATH, STATE_PATH } from "./agent-paths.ts";
import { withFileLockSync } from "./file-lock.ts";
import { dirname, join } from "node:path";

export type SwitchRecord = {
	from: ModelRef;
	to: ModelRef;
	reason: string;
	at: number;
};

export type InvalidationRecord = { tokenHash: string; at: number; reason: string };

export type ProviderFailoverState = {
	stateVersion?: number;
	exhaustedUntilByProvider?: Record<string, number>;
	exhaustedUntilByModel?: Record<string, number>;
	invalidatedByProvider?: Record<string, InvalidationRecord>;
	// Providers whose usage-% reading has been PROVEN not to reflect the real limit, because the
	// account refused while the meter still claimed headroom. Persisted so a restart cannot go
	// back to believing a meter already caught lying — that amnesia re-opened the retry loop once
	// per session.
	usageUntrustedUntilByProvider?: Record<string, number>;
	usageByProvider?: Record<string, UsageSnapshot>;
	codexModelCatalogByProvider?: Record<string, CodexCatalogSnapshot>;
	pendingContinuationPrompt?: string;
	pendingFrom?: ModelRef;
	pendingSince?: number;
	pendingReason?: string;
	lastSwitches?: SwitchRecord[];
	/** Last model the user was actually on (failover destination included). Restored after catalogs load. */
	lastUserModel?: { provider: string; id: string };
	/** Thinking level the session ran at (high/max/…). Pi clamps it to the fallback model's caps at restore time, so persist and re-assert after the model is back. */
	lastUserThinkingLevel?: string;
	/** Last chosen model id per family, so /next into that family does not land on the baked-in fallback. */
	lastModelByFamily?: Record<string, string>;
};
export const STATE_VERSION = 5;
const MAX_MIGRATED_COOLDOWN_MS = 8 * 24 * 60 * 60 * 1000;
const KNOWN_FAMILIES = new Set([
	"anthropic",
	"openai-codex",
	"kimi-coding",
	"cursor",
	"qwen",
	"ollama",
]);
const INLINE_EMAIL_PII = /([A-Za-z0-9._%+-]+|\S\*{3})@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SECRET_TOKENISH =
	/(sk-[\w-]{8,}|ey[A-Za-z0-9._-]{12,}|Bearer\s+\S+|[A-Za-z0-9_-]{40,})/g;

/** Mask email PII (e.g. "alice@example.com" -> "a***@example.com") before persisting to state. */
export function maskEmailAccount(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed.includes("@")) return trimmed;
	const at = trimmed.lastIndexOf("@");
	const local = trimmed.slice(0, at);
	const domain = trimmed.slice(at + 1);
	if (!local || !domain) return trimmed;
	if (local.includes("***")) return `${local}@${domain}`;
	return `${local[0]}***@${domain}`;
}

/** Redact inline email PII and bearer/API/JWT tokens from diagnostic or persisted error text. */
export function redactSensitiveText(text: string): string {
	return text
		.replace(INLINE_EMAIL_PII, (match) => maskEmailAccount(match))
		.replace(SECRET_TOKENISH, "«redacted»");
}

function tryReadJsonObject(path: string): Record<string, unknown> | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function readActiveStateProviders(): Set<string> | undefined {
	const auth = tryReadJsonObject(AUTH_PATH);
	const cfg = tryReadJsonObject(CONFIG_PATH);
	if (!auth && !cfg) return undefined;
	const active = new Set<string>();
	if (auth) {
		for (const [id, entry] of Object.entries(auth)) {
			if (entry && typeof entry === "object" && !Array.isArray(entry)) {
				active.add(id);
			}
		}
	}
	if (cfg) {
		if (Array.isArray(cfg.fallbacks)) {
			for (const item of cfg.fallbacks) {
				if (typeof item !== "string") continue;
				const provider = item.trim().split("/")[0]?.trim();
				if (provider) active.add(provider);
			}
		}
		if (Array.isArray(cfg.neverFailoverProviders)) {
			for (const item of cfg.neverFailoverProviders) {
				if (typeof item === "string" && item.trim()) active.add(item.trim());
			}
		}
		if (cfg.includeQwen === true) {
			const qwen = typeof cfg.qwenProvider === "string" && cfg.qwenProvider.trim() ? cfg.qwenProvider.trim() : "alibaba";
			active.add(qwen);
		}
		if (cfg.includeOllama === true) {
			active.add("ollama");
		}
	}
	const modelsJson = tryReadJsonObject(MODELS_CONFIG_PATH);
	if (modelsJson?.providers && typeof modelsJson.providers === "object" && !Array.isArray(modelsJson.providers)) {
		for (const id of Object.keys(modelsJson.providers as Record<string, unknown>)) {
			if (!/-account-\d+$/.test(id)) active.add(id);
		}
	}
	const grokVault = tryReadJsonObject(join(AGENT_DIR, "grok-accounts.json"));
	if (Array.isArray(grokVault?.accounts) && grokVault.accounts.length > 0) {
		active.add("grok-cli");
	}
	return active;
}

function filterProviderMap<T>(
	record: Record<string, T> | undefined,
	isAllowed: (provider: string) => boolean,
	mapValue?: (value: T) => T,
): Record<string, T> | undefined {
	if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
	const out: Record<string, T> = {};
	for (const [provider, value] of Object.entries(record)) {
		if (!isAllowed(provider)) continue;
		out[provider] = mapValue ? mapValue(value) : value;
	}
	return out;
}

function readDisabledFamilies(): Set<string> {
	const cfg = tryReadJsonObject(CONFIG_PATH);
	const disabled = new Set<string>();
	if (!cfg) return disabled;
	if (cfg.includeCursor === false) disabled.add("cursor");
	if (cfg.includeQwen === false) disabled.add("qwen");
	if (cfg.includeOllama === false) disabled.add("ollama");
	return disabled;
}

export function sanitizeState(raw: ProviderFailoverState): ProviderFailoverState {
	const activeProviders = readActiveStateProviders();
	const disabledFamilies = readDisabledFamilies();
	const cfg = tryReadJsonObject(CONFIG_PATH);
	const qwenProvider =
		typeof cfg?.qwenProvider === "string" && cfg.qwenProvider.trim()
			? cfg.qwenProvider.trim()
			: DEFAULT_QWEN_PROVIDER;
	const isAllowedProvider = (provider: string): boolean => {
		if (!provider) return false;
		const family = classifyProvider(provider, qwenProvider);
		if (family && disabledFamilies.has(family)) return false;
		if (activeProviders) return activeProviders.has(provider);
		return !/-account-\d+$/.test(provider);
	};
	const clean: ProviderFailoverState = { stateVersion: STATE_VERSION };
	const exhaustedByProvider = filterProviderMap(raw.exhaustedUntilByProvider, isAllowedProvider);
	if (exhaustedByProvider !== undefined) clean.exhaustedUntilByProvider = exhaustedByProvider;
	if (raw.exhaustedUntilByModel && typeof raw.exhaustedUntilByModel === "object" && !Array.isArray(raw.exhaustedUntilByModel)) {
		const out: Record<string, number> = {};
		for (const [modelRef, until] of Object.entries(raw.exhaustedUntilByModel)) {
			const provider = modelRef.split("/")[0] ?? "";
			if (isAllowedProvider(provider)) out[modelRef] = until;
		}
		clean.exhaustedUntilByModel = out;
	}
	const invalidated = filterProviderMap(raw.invalidatedByProvider, isAllowedProvider, (record) => {
		if (!record || typeof record !== "object") return record;
		if (typeof record.reason === "string") {
			const reason = redactSensitiveText(record.reason);
			if (reason !== record.reason) return { ...record, reason };
		}
		return record;
	});
	if (invalidated !== undefined) clean.invalidatedByProvider = invalidated;
	const untrusted = filterProviderMap(raw.usageUntrustedUntilByProvider, isAllowedProvider);
	if (untrusted !== undefined) clean.usageUntrustedUntilByProvider = untrusted;
	const usage = filterProviderMap(raw.usageByProvider, isAllowedProvider, (snapshot) => {
		if (!snapshot || typeof snapshot !== "object") return snapshot;
		if (typeof snapshot.account === "string" && snapshot.account.trim()) {
			const masked = maskEmailAccount(snapshot.account);
			if (masked !== snapshot.account) return { ...snapshot, account: masked };
		}
		return snapshot;
	});
	if (usage !== undefined) clean.usageByProvider = usage;
	const catalogs = filterProviderMap(raw.codexModelCatalogByProvider, isAllowedProvider);
	if (catalogs !== undefined) clean.codexModelCatalogByProvider = catalogs;
	if (typeof raw.pendingContinuationPrompt === "string") clean.pendingContinuationPrompt = raw.pendingContinuationPrompt;
	if (typeof raw.pendingFrom === "string") clean.pendingFrom = raw.pendingFrom;
	if (typeof raw.pendingSince === "number") clean.pendingSince = raw.pendingSince;
	if (typeof raw.pendingReason === "string") clean.pendingReason = redactSensitiveText(raw.pendingReason);
	if (Array.isArray(raw.lastSwitches)) {
		clean.lastSwitches = raw.lastSwitches.map((sw) => {
			if (!sw || typeof sw !== "object" || typeof sw.reason !== "string") return sw;
			const reason = redactSensitiveText(sw.reason);
			return reason !== sw.reason ? { ...sw, reason } : sw;
		});
	}
	if (
		raw.lastUserModel &&
		typeof raw.lastUserModel === "object" &&
		typeof raw.lastUserModel.provider === "string" &&
		typeof raw.lastUserModel.id === "string" &&
		isAllowedProvider(raw.lastUserModel.provider)
	) {
		clean.lastUserModel = { provider: raw.lastUserModel.provider, id: raw.lastUserModel.id };
	}
	if (typeof raw.lastUserThinkingLevel === "string") clean.lastUserThinkingLevel = raw.lastUserThinkingLevel;
	if (raw.lastModelByFamily && typeof raw.lastModelByFamily === "object" && !Array.isArray(raw.lastModelByFamily)) {
		const filteredFamilies: Record<string, string> = {};
		for (const [family, modelId] of Object.entries(raw.lastModelByFamily)) {
			if (typeof modelId !== "string" || !modelId) continue;
			if (!KNOWN_FAMILIES.has(family) || disabledFamilies.has(family)) continue;
			filteredFamilies[family] = modelId;
		}
		if (Object.keys(filteredFamilies).length > 0) {
			clean.lastModelByFamily = filteredFamilies;
		}
	}
	return clean;
}

export function loadState(): ProviderFailoverState {
	try {
		if (!existsSync(STATE_PATH)) return { stateVersion: STATE_VERSION };
		const state = JSON.parse(
			readFileSync(STATE_PATH, "utf8"),
		) as ProviderFailoverState & Record<string, unknown>;
		if (state.stateVersion !== STATE_VERSION) {
			if (state.stateVersion === 4) {
				const migrated = sanitizeState({
					...state,
					stateVersion: STATE_VERSION,
					exhaustedUntilByModel: {},
				});
				saveState(migrated);
				return migrated;
			}
			// v3 could turn one physical 401 into three failures (response/message/agent hooks)
			// and then persist a one-year invalidation. Keep only plausible quota cooldowns;
			// discard invalidations and pending work produced by that broken state machine.
			const now = Date.now();
			const plausibleCooldowns = Object.fromEntries(
				Object.entries(state.exhaustedUntilByProvider ?? {}).filter(
					([, until]) =>
						Number.isFinite(until) &&
						until > now &&
						until <= now + MAX_MIGRATED_COOLDOWN_MS,
				),
			);
			const migrated = sanitizeState({
				stateVersion: STATE_VERSION,
				exhaustedUntilByProvider: plausibleCooldowns,
				exhaustedUntilByModel: {},
				invalidatedByProvider: {},
				lastSwitches: state.lastSwitches ?? [],
				// A version bump must not forget which model the user was actually on.
				lastUserModel: state.lastUserModel,
				lastUserThinkingLevel: state.lastUserThinkingLevel,
				lastModelByFamily: state.lastModelByFamily,
			});
			saveState(migrated);
			return migrated;
		}
		const sanitized = sanitizeState(state);
		if (JSON.stringify(sanitized) !== JSON.stringify(state)) {
			saveState(sanitized);
		}
		return sanitized;
	} catch {
		return { stateVersion: STATE_VERSION };
	}
}

export function saveState(state: ProviderFailoverState) {
	// Best-effort: a locked/read-only/full disk must never crash the host. Losing a
	// state write only costs a cooldown estimate that is re-derived on the next error.
	try {
		const sanitized = sanitizeState(state);
		const serialized = `${JSON.stringify(sanitized, null, "\t")}\n`;
		withFileLockSync(STATE_PATH, () => {
			mkdirSync(dirname(STATE_PATH), { recursive: true, mode: 0o700 });
			// Atomic: a crash mid-write (the EPIPE exit already cost us lastUserModel once)
			// must leave the PREVIOUS complete file, not a truncated JSON the next process
			// discards wholesale.
			const tmp = `${STATE_PATH}.${process.pid}.${randomUUID()}.tmp`;
			try {
				writeFileSync(tmp, serialized, { encoding: "utf8", mode: 0o600 });
				renameSync(tmp, STATE_PATH);
			} finally {
				try {
					rmSync(tmp, { force: true });
				} catch {
					/* ignore cleanup errors on unwritable directories */
				}
			}
		});
	} catch {
		/* persistence is non-critical; in-memory state remains correct */
	}
}
