/** Provider/slot naming and classification. No provider implementation is loaded here. */

import { type AuthEntry } from "./auth-state.ts";

export const CURSOR_BASE = "cursor";

export function isCursorProviderId(id: string): boolean {
	return id === CURSOR_BASE || /^cursor-account-\d+$/.test(id);
}

export type ModelRef = `${string}/${string}`;
export type ProviderFamily =
	| "anthropic"
	| "openai-codex"
	| "kimi-coding"
	| "antigravity"
	| "qwen"
	| "ollama"
	| "cursor";

export const ANTHROPIC_BASE = "anthropic";
export const CODEX_BASE = "openai-codex";
export const OLLAMA_BASE = "ollama";
export const DEFAULT_QWEN_PROVIDER = "alibaba";

// ---------------------------------------------------------------------------
// Provider id helpers
// ---------------------------------------------------------------------------

const FAMILY_KEYWORDS = new Set([
	"anthropic",
	"claude",
	"codex",
	"openai",
	"antigravity",
	"agy",
	"cursor",
	"ollama",
	"qwen",
	"alibaba",
]);

export function parseFamilyArg(raw: string | undefined): ProviderFamily | undefined {
	const familyRaw = (raw || "").toLowerCase();
	if (familyRaw === "codex" || familyRaw === "openai") return "openai-codex";
	if (familyRaw === "anthropic" || familyRaw === "claude") return "anthropic";
	if (familyRaw === "ollama") return "ollama";
	if (familyRaw === "qwen" || familyRaw === "alibaba") return "qwen";
	if (familyRaw === "cursor") return "cursor";
	if (familyRaw === "kimi" || familyRaw === "kimi-coding") return "kimi-coding";
	if (familyRaw === "antigravity" || familyRaw === "agy") return "antigravity";
	return undefined;
}

function isFamilyKeyword(raw: string): boolean {
	return FAMILY_KEYWORDS.has(raw.trim().toLowerCase());
}

export function resolveRemoveTarget(
	arg: string,
	auth: Record<string, AuthEntry>,
	qwenProvider: string,
): string | undefined {
	const trimmed = arg.trim();
	if (!trimmed) return undefined;

	if (/-account-\d+$/.test(trimmed) || isCursorProviderId(trimmed)) {
		return auth[trimmed] && classifyProvider(trimmed, qwenProvider)
			? trimmed
			: undefined;
	}

	const parsed = parseTarget(trimmed);
	const exactId = parsed?.provider ?? trimmed;
	if (!isFamilyKeyword(trimmed)) {
		return auth[exactId] && classifyProvider(exactId, qwenProvider)
			? exactId
			: undefined;
	}

	const family = parseFamilyArg(trimmed);
	if (!family) return undefined;

	const aliases = Object.keys(auth)
		.filter(
			(id) => classifyProvider(id, qwenProvider) === family && slotIndex(id) >= 2,
		)
		.sort((a, b) => slotIndex(b) - slotIndex(a));
	if (aliases.length > 0) return aliases[0];

	const baseId = slotId(family, 1, qwenProvider);
	return auth[baseId] ? baseId : undefined;
}

export function classifyProvider(
	id: string,
	qwenProvider: string,
): ProviderFamily | undefined {
	if (id === ANTHROPIC_BASE || /^anthropic-account-\d+$/.test(id))
		return "anthropic";
	if (id === CODEX_BASE || /^openai-codex-account-\d+$/.test(id))
		return "openai-codex";
	if (
		id === qwenProvider ||
		new RegExp(`^${escapeRegex(qwenProvider)}-account-\\d+$`).test(id) ||
		/^qwen/i.test(id)
	)
		return "qwen";
	if (
		id === OLLAMA_BASE ||
		/^ollama-account-\d+$/.test(id) ||
		/^ollama/i.test(id)
	)
		return "ollama";
	if (isCursorProviderId(id)) return "cursor";
	if (id === "kimi-coding" || /^kimi-coding-account-\d+$/.test(id))
		return "kimi-coding";
	if (id === "antigravity" || /^antigravity-account-\d+$/.test(id))
		return "antigravity";
	return undefined;
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function slotIndex(id: string): number {
	const m = id.match(/-account-(\d+)$/);
	return m ? Number(m[1]) : 1; // base provider counts as slot 1
}

export function slotId(
	family: ProviderFamily,
	index: number,
	qwenProvider: string = DEFAULT_QWEN_PROVIDER,
): string {
	const base =
		family === "anthropic"
			? ANTHROPIC_BASE
			: family === "openai-codex"
				? CODEX_BASE
				: family === "kimi-coding"
					? "kimi-coding"
					: family === "antigravity"
						? "antigravity"
						: family === "qwen"
							? qwenProvider
							: family === "cursor"
								? CURSOR_BASE
								: OLLAMA_BASE;
	return index <= 1 ? base : `${base}-account-${index}`;
}

export function ref(provider: string, modelId: string): ModelRef {
	return `${provider}/${modelId}` as ModelRef;
}

export function parseTarget(
	target: unknown,
): { provider: string; modelId?: string } | undefined {
	if (typeof target !== "string") return undefined;
	const trimmed = target.trim();
	if (!trimmed) return undefined;
	const slash = trimmed.indexOf("/");
	if (slash === -1) return { provider: trimmed };
	const provider = trimmed.slice(0, slash).trim();
	const modelId = trimmed.slice(slash + 1).trim();
	if (!provider || !modelId) return undefined;
	return { provider, modelId };
}

/** Effort suffixes some catalogs bake into the model id. Thinking is a session setting. */
const MODEL_IDENTITY_EFFORTS = new Set([
	"none",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"minimal",
]);

/**
 * Compare models the way a person does: `cursor-grok-4.6-high` is the same model as
 * `cursor-grok-4.6` / `grok-4.6` at a different thinking effort, not a different model.
 */
export function modelIdentityKey(modelId: string): string {
	let id = modelId.trim().toLowerCase();
	if (id.endsWith("-fast")) id = id.slice(0, -5);
	if (id.endsWith("-thinking")) id = id.slice(0, -9);
	const dash = id.lastIndexOf("-");
	if (dash >= 0 && MODEL_IDENTITY_EFFORTS.has(id.slice(dash + 1))) {
		id = id.slice(0, dash);
	}
	if (id.startsWith("cursor-")) id = id.slice("cursor-".length);
	return id;
}

export function sameModelIdentity(
	a: string | undefined,
	b: string | undefined,
): boolean {
	if (!a || !b) return false;
	return a === b || modelIdentityKey(a) === modelIdentityKey(b);
}

/** Family when we know one; otherwise the un-numbered provider id (`zai` from `zai-account-2`). */
export function accountGroup(id: string, qwenProvider: string): string {
	return classifyProvider(id, qwenProvider) ?? id.replace(/-account-\d+$/, "");
}
