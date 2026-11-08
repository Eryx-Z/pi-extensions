import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** xAI Priority Processing. Same wire value as Codex fast mode, separate preference. */
export const XAI_FAST_SERVICE_TIER = "priority";
export const XAI_FAST_PREFERENCE_NAME = "xai-fast-mode.json";

const XAI_FAST_PROVIDER = /^xai(?:-account-\d+)?$/;
const XAI_FAST_APIS = new Set(["openai-responses", "openai-completions"]);

export interface XaiFastModel {
	provider?: unknown;
	api?: unknown;
	id?: unknown;
}

/** Built-in xAI subscription and numbered slots. Other APIs are left untouched. */
export function isXaiFastModel(model: XaiFastModel | null | undefined): boolean {
	if (!model || typeof model.provider !== "string" || !XAI_FAST_PROVIDER.test(model.provider)) return false;
	return model.api === undefined || (typeof model.api === "string" && XAI_FAST_APIS.has(model.api));
}

export function xaiFastPreferencePath(
	agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
): string {
	return join(agentDir, XAI_FAST_PREFERENCE_NAME);
}

/** Missing or unreadable preference means off, so priority billing is opt-in. */
export function readXaiFastEnabled(path = xaiFastPreferencePath()): boolean {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (
			parsed &&
			typeof parsed === "object" &&
			!Array.isArray(parsed) &&
			typeof (parsed as { enabled?: unknown }).enabled === "boolean"
		) {
			return (parsed as { enabled: boolean }).enabled;
		}
	} catch {
		// ENOENT and corrupt files both fall through to the default.
	}
	return false;
}

export function writeXaiFastEnabled(enabled: boolean, path = xaiFastPreferencePath()): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify({ enabled })}\n`, { mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

/** Mutates a JSON request body. Non-objects are returned unchanged. */
export function applyXaiFastMode(payload: unknown, enabled: boolean): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
	const record = payload as Record<string, unknown>;
	if (enabled) record.service_tier = XAI_FAST_SERVICE_TIER;
	else delete record.service_tier;
	return payload;
}

export function shapeXaiFastPayload(
	payload: unknown,
	model: XaiFastModel | null | undefined,
	enabled = readXaiFastEnabled(),
): unknown {
	if (!isXaiFastModel(model)) return payload;
	return applyXaiFastMode(payload, enabled);
}
