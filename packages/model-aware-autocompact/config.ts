import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_CONTEXT_GUARD_SETTINGS,
	type ContextGuardSettings,
} from "./context-guard.ts";

export interface Config {
	percent: number;
	models: Record<string, number>;
	/** Only tool-output summaries; absent follows the current conversation model. */
	compressModel?: string;
	contextGuard: ContextGuardSettings;
}

export const DEFAULT_PERCENT = 80;

export function isValidPercent(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value > 0 &&
		value < 100
	);
}

function positiveOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: fallback;
}

/** Same normalization as the former provider-failover contextGuard setting. */
export function normalizeContextGuard(value: unknown): ContextGuardSettings {
	const defaults = DEFAULT_CONTEXT_GUARD_SETTINGS;
	if (value === false) return { ...defaults, enabled: false };
	if (value === true || value === undefined || value === null)
		return { ...defaults };
	if (typeof value !== "object") return { ...defaults };
	const raw = value as Partial<ContextGuardSettings>;
	const share = (candidate: unknown, fallback: number) =>
		typeof candidate === "number" &&
		Number.isFinite(candidate) &&
		candidate > 0 &&
		candidate <= 1
			? candidate
			: fallback;
	const settings: ContextGuardSettings = {
		enabled: raw.enabled ?? true,
		softPercent: share(raw.softPercent, defaults.softPercent),
		targetPercent: share(raw.targetPercent, defaults.targetPercent),
		keepVerbatimTokens: positiveOr(
			raw.keepVerbatimTokens,
			defaults.keepVerbatimTokens,
		),
		minElideTokens: positiveOr(raw.minElideTokens, defaults.minElideTokens),
		maxWindowTokens:
			typeof raw.maxWindowTokens === "number" &&
			Number.isFinite(raw.maxWindowTokens) &&
			raw.maxWindowTokens >= 0
				? raw.maxWindowTokens
				: defaults.maxWindowTokens,
	};
	if (settings.targetPercent >= settings.softPercent) {
		settings.targetPercent = Math.max(0.1, settings.softPercent - 0.15);
	}
	return settings;
}

function readObject(path: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/** Adopt a real legacy setting once, before its former owner can drop it on save. */
export function shouldAdoptLegacyGuard(agentDir: string): boolean {
	const current = readObject(join(agentDir, "model-aware-autocompact.json"));
	if (Object.hasOwn(current, "contextGuard")) return false;
	const legacy = readObject(
		join(agentDir, "provider-failover.json"),
	).contextGuard;
	return (
		typeof legacy === "boolean" ||
		(legacy !== null && typeof legacy === "object" && !Array.isArray(legacy))
	);
}

export function loadConfig(agentDir: string): Config {
	const value = readObject(join(agentDir, "model-aware-autocompact.json"));
	// Only this legacy property is consulted. In particular, its enabled/percent settings
	// must never govern this extension, and an explicit new false/null wins over legacy.
	const guard = Object.hasOwn(value, "contextGuard")
		? value.contextGuard
		: readObject(join(agentDir, "provider-failover.json")).contextGuard;
	return normalizeConfig(value, guard);
}

/** Reread immediately before adoption: preserve unknown fields and intervening edits.
 * Only a missing file or valid JSON object is eligible; never repair/overwrite bad input.
 */
export function adoptLegacyContextGuard(agentDir: string, inherited: ContextGuardSettings): Config {
	const path = join(agentDir, "model-aware-autocompact.json");
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		value = {};
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("model-aware-autocompact.json must contain a JSON object; legacy adoption skipped");
	}
	const current = value as Record<string, unknown>;
	if (!Object.hasOwn(current, "contextGuard")) {
		current.contextGuard = inherited;
		writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`, "utf8");
	}
	return normalizeConfig(current, current.contextGuard);
}

function normalizeConfig(value: Record<string, unknown>, guard: unknown): Config {
	const models: Record<string, number> = {};
	if (
		value.models &&
		typeof value.models === "object" &&
		!Array.isArray(value.models)
	) {
		for (const [key, percent] of Object.entries(value.models)) {
			if (isValidPercent(percent)) models[key] = percent;
		}
	}
	return {
		percent: isValidPercent(value.percent) ? value.percent : DEFAULT_PERCENT,
		models,
		// Keep explicit invalid settings distinct from absence: never silently send
		// output to the current provider when a different compressor was requested.
		...(Object.hasOwn(value, "compressModel") ? {
			compressModel: typeof value.compressModel === "string" ? value.compressModel.trim() : "",
		} : {}),
		contextGuard: normalizeContextGuard(guard),
	};
}

export function saveConfig(agentDir: string, config: Config): void {
	writeFileSync(
		join(agentDir, "model-aware-autocompact.json"),
		`${JSON.stringify(config, null, 2)}\n`,
		"utf8",
	);
}
