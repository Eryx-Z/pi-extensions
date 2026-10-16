/** Account labels shared by parent discovery and provider-only RPC startup. */

import {
	type ProviderFamily,
	classifyProvider,
	DEFAULT_QWEN_PROVIDER,
	slotIndex,
} from "./provider-ids.ts";
import { type AuthEntry, decodeJwtPayload } from "./auth-state.ts";

export function formatAccountIdentifier(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return "";
	const at = trimmed.indexOf("@");
	return at > 0 ? trimmed.slice(0, at) : trimmed;
}

export function maskAccount(raw: string): string {
	return formatAccountIdentifier(raw);
}

export function familyDisplayLabel(family: ProviderFamily): string {
	switch (family) {
		case "openai-codex":
			return "ChatGPT";
		case "antigravity":
			return "Antigravity";
		case "anthropic":
			return "Claude";
		case "kimi-coding":
			return "Kimi";
		case "cursor":
			return "Cursor";
		case "ollama":
			return "Ollama";
		case "qwen":
			return "Qwen";
		default:
			return family;
	}
}

export function slotAccountDetails(
	id: string,
	entry: AuthEntry | undefined,
	family: ProviderFamily,
	usagePlan?: string,
): { account?: string; plan?: string } {
	if (!entry) return {};
	let rawAccount: string | undefined;
	let rawPlan: string | undefined = usagePlan;

	if (family === "antigravity") {
		if (typeof entry.email === "string" && entry.email.trim()) {
			rawAccount = entry.email.trim();
		}
	} else if (family === "openai-codex") {
		if (typeof entry.access === "string" && entry.access) {
			const payload = decodeJwtPayload(entry.access);
			rawAccount =
				payload?.email ||
				payload?.["https://api.openai.com/profile"]?.email ||
				(typeof payload?.sub === "string" && !payload.sub.startsWith("subject:")
					? payload.sub
					: undefined);
			const jwtPlan = payload?.["https://api.openai.com/auth"]?.chatgpt_plan_type;
			if (typeof jwtPlan === "string" && jwtPlan.trim()) {
				rawPlan = jwtPlan.trim().toLowerCase();
			}
		}
		if (!rawAccount && typeof entry.accountId === "string") {
			rawAccount = entry.accountId;
		}
	} else if (family === "cursor") {
		if (typeof entry.access === "string" && entry.access) {
			const payload = decodeJwtPayload(entry.access);
			rawAccount = payload?.email || payload?.sub;
		}
	} else {
		if (typeof entry.email === "string" && entry.email.trim()) {
			rawAccount = entry.email.trim();
		} else if (typeof entry.accountId === "string") {
			rawAccount = entry.accountId;
		}
	}

	if (rawPlan && rawPlan.toLowerCase() === family.toLowerCase()) {
		rawPlan = undefined;
	}

	return { account: rawAccount, plan: rawPlan };
}

export function formatSlotDisplayName(
	id: string,
	entry?: AuthEntry,
	family?: ProviderFamily,
	usagePlan?: string,
): string {
	const resolvedFamily =
		family ?? classifyProvider(id, DEFAULT_QWEN_PROVIDER) ?? "openai-codex";
	const index = slotIndex(id);
	const label = familyDisplayLabel(resolvedFamily);
	const baseName = `${label}-${index}`;

	const { account, plan } = slotAccountDetails(
		id,
		entry,
		resolvedFamily,
		usagePlan,
	);
	const tags: string[] = [];
	if (account) tags.push(formatAccountIdentifier(account));
	if (plan) tags.push(plan);

	if (tags.length > 0) {
		return `${baseName} (${tags.join(", ")})`;
	}
	return baseName;
}
