import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Wire value used by Codex priority processing. */
export const CODEX_FAST_SERVICE_TIER = "priority";
/** Shared with @gowthamgts/pi-codex-fast-mode so /fast and this plugin agree. */
export const CODEX_FAST_PREFERENCE_NAME = "codex-fast-mode.json";

const CODEX_FAST_PROVIDER = /^openai-codex(?:-account-\d+)?$/;

export interface CodexFastModel {
	provider?: unknown;
	api?: unknown;
}

/** Base Codex and numbered rotation slots. Other providers are left untouched. */
export function isCodexFastModel(model: CodexFastModel | null | undefined): boolean {
	if (!model || typeof model.provider !== "string" || !CODEX_FAST_PROVIDER.test(model.provider)) return false;
	// A slot can only be registered with the Codex responses API. An explicit
	// other API is a custom route and must not receive this field.
	return model.api === undefined || model.api === "openai-codex-responses";
}

export function codexFastPreferencePath(
	agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
): string {
	return join(agentDir, CODEX_FAST_PREFERENCE_NAME);
}

/** Missing or unreadable preference means on, matching pi-codex-fast-mode. */
export function readCodexFastEnabled(path = codexFastPreferencePath()): boolean {
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
	return true;
}

export function writeCodexFastEnabled(enabled: boolean, path = codexFastPreferencePath()): void {
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
export function applyCodexFastMode(payload: unknown, enabled: boolean): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
	const record = payload as Record<string, unknown>;
	if (enabled) record.service_tier = CODEX_FAST_SERVICE_TIER;
	else delete record.service_tier;
	return payload;
}

export function shapeCodexFastPayload(
	payload: unknown,
	model: CodexFastModel | null | undefined,
	enabled = readCodexFastEnabled(),
): unknown {
	if (!isCodexFastModel(model)) return payload;
	return applyCodexFastMode(payload, enabled);
}
