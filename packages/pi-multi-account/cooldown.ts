/** Cooldown estimates from provider headers, error text and cached usage. No session state. */

import type { UsageSnapshot, UsageWindow } from "./usage.ts";


function retryAfterToMs(value: string | undefined) {
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
	const dateMs = Date.parse(value);
	if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
	return undefined;
}

function secondsToMs(value: string | undefined) {
	if (!value) return undefined;
	const seconds = Number(value);
	return Number.isFinite(seconds) && seconds >= 0
		? Math.ceil(seconds * 1000)
		: undefined;
}

function unixSecondsToCooldownMs(value: string | undefined) {
	if (!value) return undefined;
	const seconds = Number(value);
	return Number.isFinite(seconds) && seconds > 0
		? Math.max(0, seconds * 1000 - Date.now())
		: undefined;
}

function firstDefinedMs(values: Array<number | undefined>) {
	return values.find(
		(value): value is number =>
			value !== undefined && Number.isFinite(value) && value >= 0,
	);
}

function percentValue(value: string | undefined) {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? numeric : undefined;
}

export function cooldownFromHeaders(headers: Record<string, string>) {
	const normalized = new Map(
		Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
	);
	const get = (name: string) => normalized.get(name.toLowerCase());
	const primaryUsed = percentValue(get("x-codex-primary-used-percent"));
	const secondaryUsed = percentValue(get("x-codex-secondary-used-percent"));
	const retryAfter = retryAfterToMs(get("retry-after"));
	const primaryReset = firstDefinedMs([
		secondsToMs(get("x-codex-primary-reset-after-seconds")),
		unixSecondsToCooldownMs(get("x-codex-primary-reset-at")),
	]);
	const secondaryReset = firstDefinedMs([
		secondsToMs(get("x-codex-secondary-reset-after-seconds")),
		unixSecondsToCooldownMs(get("x-codex-secondary-reset-at")),
	]);
	if ((secondaryUsed ?? 0) >= 100)
		return secondaryReset ?? retryAfter ?? primaryReset;
	if ((primaryUsed ?? 0) >= 100)
		return primaryReset ?? retryAfter ?? secondaryReset;
	return retryAfter ?? primaryReset ?? secondaryReset;
}

const RETRY_PHRASE =
	/\btry again in\s*~?\s*(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|[smhd])\b/i;
const RETRY_UNIT_MS: Record<string, number> = {
	s: 1_000,
	sec: 1_000,
	secs: 1_000,
	second: 1_000,
	seconds: 1_000,
	m: 60_000,
	min: 60_000,
	mins: 60_000,
	minute: 60_000,
	minutes: 60_000,
	h: 3_600_000,
	hr: 3_600_000,
	hrs: 3_600_000,
	hour: 3_600_000,
	hours: 3_600_000,
	d: 86_400_000,
	day: 86_400_000,
	days: 86_400_000,
};

/**
 * Some providers state the recovery horizon in prose rather than in a header or JSON field —
 * Codex free-plan refusals read "You have hit your ChatGPT usage limit (free plan). Try again in
 * ~41615 min." Ignoring it threw away the single most direct statement the provider makes about
 * when the account comes back, leaving only a quota percentage that does not see that limit.
 * Still only a forecast, so callers cap it like any other.
 */
function retryPhraseMs(errorText: string): number | undefined {
	const match = errorText.match(RETRY_PHRASE);
	if (!match) return undefined;
	const value = Number(match[1]);
	const unit = RETRY_UNIT_MS[match[2].toLowerCase()];
	if (!Number.isFinite(value) || value <= 0 || !unit) return undefined;
	return Math.round(value * unit);
}

export function cooldownFromErrorText(errorText: string) {
	const bodyReset = firstDefinedMs([
		secondsToMs(errorText.match(/"resets_in_seconds"\s*:\s*(\d+)/i)?.[1]),
		unixSecondsToCooldownMs(errorText.match(/"resets_at"\s*:\s*(\d+)/i)?.[1]),
	]);
	if (bodyReset !== undefined) return bodyReset;
	const primaryUsed = percentValue(
		errorText.match(/"X-Codex-Primary-Used-Percent"\s*:\s*"?(\d+)/i)?.[1],
	);
	const secondaryUsed = percentValue(
		errorText.match(/"X-Codex-Secondary-Used-Percent"\s*:\s*"?(\d+)/i)?.[1],
	);
	const primaryReset = firstDefinedMs([
		secondsToMs(
			errorText.match(/"X-Codex-Primary-Reset-After-Seconds"\s*:\s*"?(\d+)/i)?.[1],
		),
		unixSecondsToCooldownMs(
			errorText.match(/"X-Codex-Primary-Reset-At"\s*:\s*"?(\d+)/i)?.[1],
		),
	]);
	const secondaryReset = firstDefinedMs([
		secondsToMs(
			errorText.match(
				/"X-Codex-Secondary-Reset-After-Seconds"\s*:\s*"?(\d+)/i,
			)?.[1],
		),
		unixSecondsToCooldownMs(
			errorText.match(/"X-Codex-Secondary-Reset-At"\s*:\s*"?(\d+)/i)?.[1],
		),
	]);
	// Structured fields always win; the prose horizon is the last resort, used only when the
	// provider gave us nothing machine-readable.
	const stated = retryPhraseMs(errorText);
	if ((secondaryUsed ?? 0) >= 100)
		return secondaryReset ?? primaryReset ?? stated;
	if ((primaryUsed ?? 0) >= 100) return primaryReset ?? secondaryReset ?? stated;
	return primaryReset ?? secondaryReset ?? stated;
}

/**
 * How long (ms) until the account behind this usage snapshot is actually usable again?
 *  - `0`         → no window is maxed out: the account is available right now.
 *  - `> 0`       → soonest reset among the maxed-out (>=100%) windows still in the future.
 *  - `undefined` → the snapshot carries no window data; the caller keeps its own estimate.
 *
 * This is the ground truth used to RECONCILE recorded cooldowns during a wait, so a session
 * resumes the moment an account truly recovers — not when a stale estimate happens to expire.
 */
export function cooldownMsFromUsage(
	snapshot: UsageSnapshot,
	now = Date.now(),
): number | undefined {
	// Codex/Claude short windows can still have headroom while a longer rolling window is maxed.
	// Treat the account as available when the primary window is not exhausted.
	if (snapshot.primary && snapshot.primary.usedPercent < 100) return 0;

	const windows = [snapshot.primary, snapshot.secondary].filter(
		(w): w is UsageWindow => !!w,
	);
	if (windows.length === 0) return undefined;
	const blocking = windows.filter(
		(w) => w.usedPercent >= 100 && w.resetAt > now,
	);
	if (blocking.length === 0) return 0;
	return Math.min(...blocking.map((w) => w.resetAt)) - now;
}
