/** Published Pi file adapters: shape inspection, child visibility and atomic slot catalogs. */

import { readFileSync, existsSync, writeFileSync, renameSync } from "node:fs";
import { MODELS_CONFIG_PATH, SETTINGS_PATH, AUTH_PATH } from "./agent-paths.ts";
import { type ShapeVerdict, checkAuthShape, checkModelsShape } from "./pi-contract.ts";
import { type ChildUsability, classifyChildUsability } from "./child-usability.ts";
import { isRecord } from "./request-shaping.ts";


/**
 * Model ids the user configured for a provider in Pi's own models.json.
 *
 * This is the user's list, not ours. The API-key base registration below exists only because a
 * placeholder apiKey can stop Pi exposing a provider at all — it was never meant to decide which
 * models that provider has, and replacing a configured six-model provider with one built-in tag
 * is a silent downgrade of the user's own configuration.
 */
export function configuredModelIds(provider: string): string[] {
	try {
		const parsed = JSON.parse(readFileSync(MODELS_CONFIG_PATH, "utf8"));
		const models = parsed?.providers?.[provider]?.models;
		if (Array.isArray(models)) {
			return models
				.map((model: any) => (typeof model === "string" ? model : model?.id))
				.filter(
					(id: unknown): id is string => typeof id === "string" && id.length > 0,
				);
		}
		if (models && typeof models === "object") return Object.keys(models);
		return [];
	} catch {
		return [];
	}
}

export function readHostDefaultModel(): { provider: string; id: string } | undefined {
	try {
		const parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
		const provider = parsed?.defaultProvider;
		const id = parsed?.defaultModel;
		if (
			typeof provider === "string" &&
			provider &&
			typeof id === "string" &&
			id
		) {
			return { provider, id };
		}
	} catch {
		/* settings.json is optional */
	}
	return undefined;
}

/**
 * The three files Pi publishes, read the only way this extension is allowed to read them: parse,
 * never write, and treat absence as normal rather than as a fault.
 *
 * `undefined` means "no such file" — a fresh install has no models.json and no custom providers,
 * and reporting that as drift would be pure noise. A file that exists but will not parse is a
 * different thing entirely and is reported, because a corrupt models.json is exactly how every
 * custom provider a user has disappears at once.
 */
function readPublishedJson(path: string): {
	present: boolean;
	value?: unknown;
	unreadable?: string;
} {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return { present: false };
	}
	try {
		return { present: true, value: JSON.parse(text) };
	} catch (error) {
		return {
			present: true,
			unreadable: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Check the published files against the shapes this extension depends on. */
export function inspectPiContract(): ShapeVerdict[] {
	const verdicts: ShapeVerdict[] = [];
	const checks: Array<[string, string, (raw: unknown) => ShapeVerdict]> = [
		["auth.json", AUTH_PATH, checkAuthShape],
		["models.json", MODELS_CONFIG_PATH, checkModelsShape],
	];
	for (const [file, path, check] of checks) {
		const read = readPublishedJson(path);
		if (!read.present) continue;
		if (read.unreadable) {
			verdicts.push({
				file,
				ok: false,
				problems: [`exists but will not parse (${read.unreadable})`],
			});
			continue;
		}
		verdicts.push(check(read.value));
	}
	return verdicts;
}

/**
 * What a rotation slot looks like to something that does NOT load this extension.
 *
 * Read from disk rather than from our own in-memory registry on purpose: the child sees the files,
 * not our objects, so the files are what has to be judged. A provider that is neither one of our
 * numbered slots nor present in models.json is one Pi defines itself, and Pi then owns its auth
 * flow — which is the only case where an OAuth credential works for a child at all.
 */
export function slotsAsAChildSeesThem(
	slotIds: readonly string[],
	auth: Record<string, { type?: string }>,
): ChildUsability[] {
	const read = readPublishedJson(MODELS_CONFIG_PATH);
	const published =
		read.present &&
		!read.unreadable &&
		isRecord(read.value) &&
		isRecord(read.value.providers)
			? read.value.providers
			: {};
	return slotIds.map((slotId) => {
		const publishedEntry = published[slotId];
		const entry = isRecord(publishedEntry) ? publishedEntry : undefined;
		const credentialType = auth[slotId]?.type;
		return classifyChildUsability({
			slotId,
			credential:
				credentialType === "oauth"
					? "oauth"
					: credentialType === "api_key"
						? "api_key"
						: "none",
			builtin: !/-account-\d+$/.test(slotId) && entry === undefined,
			publishedApiKey:
				typeof entry?.apiKey === "string" ? entry.apiKey : undefined,
			publishedBaseUrl:
				typeof entry?.baseUrl === "string" ? entry.baseUrl : undefined,
		});
	});
}

type NativeModelEntry = {
	id: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	input?: Array<"text" | "image">;
	cost?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow?: number;
	maxTokens?: number;
	compat?: Record<string, unknown>;
};

type NativeProviderEntry = {
	api: string;
	baseUrl: string;
	models: unknown[];
	compat?: Record<string, unknown>;
	/**
	 * Key written into models.json for this slot. Pi refuses to use a provider it has
	 * no credential for — `credentials_not_configured` — so a slot we publish without
	 * one resolves the model and then cannot call it. Only ever a non-secret
	 * placeholder for a LOCAL proxy that supplies the real token itself; a real
	 * credential must never be copied into models.json.
	 */
	apiKey?: string;
};

/**
 * Pi's models.json schema is `models: ModelDefinition[]` — each entry MUST be an
 * object with `id`. A string id (`"k3"`) fails validation, and Pi then discards
 * the *entire* file (every custom provider, not just the bad slot).
 */
function nativeModelEntry(model: unknown): NativeModelEntry | undefined {
	if (typeof model === "string") {
		return model.length > 0 ? { id: model } : undefined;
	}
	if (!model || typeof model !== "object") return undefined;
	const rec = model as Record<string, unknown>;
	const id = typeof rec.id === "string" ? rec.id : "";
	if (!id) return undefined;
	const entry: NativeModelEntry = { id };
	if (typeof rec.name === "string" && rec.name.length > 0) entry.name = rec.name;
	if (typeof rec.api === "string" && rec.api.length > 0) entry.api = rec.api;
	if (typeof rec.baseUrl === "string" && rec.baseUrl.length > 0) {
		entry.baseUrl = rec.baseUrl;
	}
	if (typeof rec.reasoning === "boolean") entry.reasoning = rec.reasoning;
	if (rec.thinkingLevelMap && typeof rec.thinkingLevelMap === "object") {
		entry.thinkingLevelMap =
			rec.thinkingLevelMap as NativeModelEntry["thinkingLevelMap"];
	}
	if (Array.isArray(rec.input)) {
		const input = rec.input.filter(
			(value): value is "text" | "image" => value === "text" || value === "image",
		);
		if (input.length) entry.input = input;
	}
	if (rec.cost && typeof rec.cost === "object") {
		const cost = rec.cost as Record<string, unknown>;
		if (
			typeof cost.input === "number" &&
			typeof cost.output === "number" &&
			typeof cost.cacheRead === "number" &&
			typeof cost.cacheWrite === "number"
		) {
			entry.cost = {
				input: cost.input,
				output: cost.output,
				cacheRead: cost.cacheRead,
				cacheWrite: cost.cacheWrite,
			};
		}
	}
	if (typeof rec.contextWindow === "number")
		entry.contextWindow = rec.contextWindow;
	if (typeof rec.maxTokens === "number") entry.maxTokens = rec.maxTokens;
	if (rec.compat && typeof rec.compat === "object") {
		entry.compat = rec.compat as Record<string, unknown>;
	}
	return entry;
}

function nativeModelEntries(models: unknown[]): NativeModelEntry[] {
	const out: NativeModelEntry[] = [];
	for (const model of models) {
		const entry = nativeModelEntry(model);
		if (entry) out.push(entry);
	}
	return out;
}

/**
 * Provision a rotation slot into Pi's OWN static provider registry (models.json)
 * so any bare `pi -p` child resolves `kimi-coding-account-2/k3` or
 * `cursor/cursor-grok-4.6` WITHOUT this extension loaded. Written ONLY here:
 * at slot login/discovery — never on failover, rotation, or limit events.
 * Failover state lives in provider-failover-state.json, our own file.
 * Merge-only: existing user entries and unrelated keys are preserved verbatim.
 */
export function unprovisionNativeSlot(provider: string): void {
	try {
		if (!existsSync(MODELS_CONFIG_PATH)) return;
		const raw = readFileSync(MODELS_CONFIG_PATH, "utf8");
		const parsed = JSON.parse(raw);
		const providers =
			typeof parsed?.providers === "object" && parsed.providers !== null
				? parsed.providers
				: {};
		if (!providers[provider]) return;
		const nextProviders = { ...providers };
		delete nextProviders[provider];
		const next = { ...parsed, providers: nextProviders };
		const tmp = `${MODELS_CONFIG_PATH}.multi-account.tmp`;
		writeFileSync(
			tmp,
			`${JSON.stringify(next, null, 2)}
`,
			{
				encoding: "utf8",
				mode: 0o600,
			},
		);
		renameSync(tmp, MODELS_CONFIG_PATH);
	} catch {
		/* models.json locked/corrupt */
	}
}

export function provisionNativeSlot(
	provider: string,
	entry: NativeProviderEntry,
): void {
	try {
		const models = nativeModelEntries(entry.models);
		const normalized: Record<string, unknown> = {
			api: entry.api,
			baseUrl: entry.baseUrl,
			models,
		};
		if (entry.apiKey) normalized.apiKey = entry.apiKey;
		if (entry.compat) normalized.compat = entry.compat;
		const raw = existsSync(MODELS_CONFIG_PATH)
			? readFileSync(MODELS_CONFIG_PATH, "utf8")
			: "{}";
		const parsed = JSON.parse(raw);
		const providers =
			typeof parsed?.providers === "object" && parsed.providers !== null
				? parsed.providers
				: {};
		const existing = providers[provider];
		if (
			existing?.baseUrl === normalized.baseUrl &&
			existing?.api === normalized.api &&
			existing?.apiKey === normalized.apiKey &&
			JSON.stringify(existing?.models ?? []) === JSON.stringify(models)
		) {
			return; // already provisioned — do not touch the file
		}
		const next = {
			...parsed,
			providers: { ...providers, [provider]: normalized },
		};
		const tmp = `${MODELS_CONFIG_PATH}.multi-account.tmp`;
		writeFileSync(
			tmp,
			`${JSON.stringify(next, null, 2)}
`,
			{
				encoding: "utf8",
				mode: 0o600,
			},
		);
		renameSync(tmp, MODELS_CONFIG_PATH);
	} catch {
		/* models.json locked/corrupt — the extension registry still works */
	}
}
