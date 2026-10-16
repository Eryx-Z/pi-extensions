/** Credential persistence, identity and refresh-race recovery shared by provider slots. */

import {
	readFileSync,
	writeFileSync,
	renameSync,
	accessSync,
	constants as fsConstants,
	statSync,
} from "node:fs";
import { AUTH_PATH } from "./agent-paths.ts";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// auth.json reading, account identity & token validity
// ---------------------------------------------------------------------------

export type AuthEntry = {
	type?: string;
	access?: string;
	refresh?: string;
	expires?: number;
	key?: string;
	accountId?: string;
	/** Cloud Code Assist project selected during Antigravity OAuth. */
	projectId?: string;
	/** Stable Google identity used to deduplicate Antigravity login slots. */
	email?: string;
};

export function readAuthFile(): Record<string, AuthEntry> {
	try {
		return JSON.parse(readFileSync(AUTH_PATH, "utf8")) as Record<
			string,
			AuthEntry
		>;
	} catch {
		return {};
	}
}

/** Atomic replace of auth.json, so a crash mid-write can never truncate credentials. */
function writeAuthFile(data: Record<string, AuthEntry>): void {
	const tmp = `${AUTH_PATH}.multi-account.tmp`;
	writeFileSync(tmp, `${JSON.stringify(data, null, "\t")}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	renameSync(tmp, AUTH_PATH);
}

function authFileIsWritable(): boolean {
	try {
		accessSync(AUTH_PATH, fsConstants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Can a refreshed credential be written back AT ALL?
 *
 * This must be answered BEFORE the network refresh, never after. Anthropic rotates the
 * refresh token on every refresh call and revokes the old one immediately, so a refresh
 * we cannot persist does not "fail" — it DESTROYS the account's credential and throws the
 * replacement away. That is exactly what happened on pi 0.84.x, whose `AuthStorage` dropped
 * the `set()` method this extension used to persist with: the post-refresh guard tripped
 * every time, and the user lost their Claude login roughly once a day.
 */
export function canPersistRefreshedCredentials(
	authStorage: any,
	authWritable: () => boolean = authFileIsWritable,
): boolean {
	return (
		typeof authStorage?.modify === "function" ||
		typeof authStorage?.set === "function" ||
		authWritable()
	);
}

/**
 * Write a refreshed OAuth credential back, through whichever path this host actually offers.
 *
 * `modify` is the locked, supported API in current pi and is tried first. `set` covers older
 * hosts (and the test harness). The direct auth.json write is the last resort that exists
 * only so a token we already rotated is never dropped on the floor — losing it means a
 * forced re-login, which is the failure this whole function exists to prevent.
 */
export async function persistRefreshedCredentials(
	authStorage: any,
	provider: string,
	credential: AuthEntry,
	io?: {
		read?: () => Record<string, AuthEntry>;
		write?: (data: Record<string, AuthEntry>) => void;
	},
): Promise<boolean> {
	if (typeof authStorage?.modify === "function") {
		try {
			await authStorage.modify(provider, () => credential);
			return true;
		} catch {
			// Locked or read-only storage — fall through to the remaining paths.
		}
	}
	if (typeof authStorage?.set === "function") {
		try {
			authStorage.set(provider, credential);
			return true;
		} catch {
			// Same.
		}
	}
	try {
		const read = io?.read ?? readAuthFile;
		const write = io?.write ?? writeAuthFile;
		write({ ...read(), [provider]: credential });
		return true;
	} catch {
		return false;
	}
}

export function authMtimeMs(): number {
	try {
		return statSync(AUTH_PATH).mtimeMs;
	} catch {
		return 0;
	}
}

export function decodeJwtPayload(token: string): any | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	try {
		let payload = parts[1].replaceAll("-", "+").replaceAll("_", "/");
		payload += "=".repeat((4 - (payload.length % 4)) % 4);
		return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
	} catch {
		return undefined;
	}
}

export function jwtExpMs(token: string): number | undefined {
	const exp = decodeJwtPayload(token)?.exp;
	return typeof exp === "number" && Number.isFinite(exp)
		? exp * 1000
		: undefined;
}

function getCursorSubFromAccessToken(token: string): string | undefined {
	const sub = decodeJwtPayload(token)?.sub;
	return typeof sub === "string" && sub.length > 0 ? sub : undefined;
}

function getCodexIdentityFromAccessToken(
	token: string,
): { accountId: string; userId?: string } | undefined {
	const payload = decodeJwtPayload(token);
	const auth = payload?.["https://api.openai.com/auth"];
	const accountId = auth?.chatgpt_account_id;
	if (typeof accountId !== "string" || accountId.length === 0) return undefined;
	const userId = [auth?.chatgpt_user_id, auth?.user_id, payload?.sub].find(
		(value) => typeof value === "string" && value.length > 0,
	);
	return {
		accountId,
		...(typeof userId === "string" ? { userId } : {}),
	};
}

function codexAccountIdentity(token: string): string | undefined {
	const identity = getCodexIdentityFromAccessToken(token);
	if (!identity) return undefined;
	return identity.userId
		? `codex-member:${hash12(identity.accountId)}:${hash12(identity.userId)}`
		: `acct:${hash12(identity.accountId)}`;
}

function hash12(input: string) {
	return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

/** A stable fingerprint of the current credential, used to detect re-login. */
export function credentialHash(entry: AuthEntry): string | undefined {
	const secret = entry.access ?? entry.key;
	return secret ? hash12(secret) : undefined;
}

/**
 * Identity of the REAL underlying account, used to detect the same account logged into multiple
 * slots. Deterministic where the data allows it:
 *   - Codex/ChatGPT JWT workspace + user ids → distinguishes members of one Team workspace.
 *   - else `accountId` stored in auth.json (Codex/ChatGPT workspace fallback).
 *   - else a hash of the API key (same key = same account).
 *   - else a hash of the opaque access token. Opaque OAuth tokens (Anthropic) change on every login,
 *     so this only catches the literal same-token case. Two separate logins of the same Anthropic
 *     account are not deterministically identifiable from auth.json alone.
 */
export function accountIdentity(entry: AuthEntry): string | undefined {
	if (
		typeof entry.projectId === "string" &&
		entry.projectId &&
		typeof entry.email === "string" &&
		entry.email.trim()
	)
		return `antigravity:${hash12(entry.email.trim().toLowerCase())}`;
	if (entry.access) {
		const codexIdentity = codexAccountIdentity(entry.access);
		if (codexIdentity) return codexIdentity;
	}
	if (typeof entry.accountId === "string" && entry.accountId.length > 0)
		return `acct:${hash12(entry.accountId)}`;
	if (entry.access) {
		const cursorSub = getCursorSubFromAccessToken(entry.access);
		if (cursorSub) return `cursor:${hash12(cursorSub)}`;
		return `tok:${hash12(entry.access)}`;
	}
	if (entry.key) return `key:${hash12(entry.key)}`;
	return undefined;
}

/**
 * A fingerprint that SURVIVES routine OAuth access-token refreshes and changes only when the
 * slot is genuinely re-logged into a DIFFERENT real account. Used to decide whether a recorded
 * cooldown still applies after auth.json changes. Unlike {@link accountIdentity}, it never falls
 * back to the volatile access token: when auth.json carries no stable signal (opaque OAuth tokens,
 * e.g. Anthropic) it returns undefined, so we keep the cooldown. A server-side rate limit is not
 * lifted by rotating a token anyway, so erring toward "keep the cooldown" is correct.
 */
export function stableAccountFingerprint(entry: AuthEntry): string | undefined {
	if (
		typeof entry.projectId === "string" &&
		entry.projectId &&
		typeof entry.email === "string" &&
		entry.email.trim()
	)
		return `antigravity:${hash12(entry.email.trim().toLowerCase())}`;
	if (entry.access) {
		const codexIdentity = codexAccountIdentity(entry.access);
		if (codexIdentity) return codexIdentity;
	}
	if (typeof entry.accountId === "string" && entry.accountId.length > 0)
		return `acct:${hash12(entry.accountId)}`;
	if (entry.key) return `key:${hash12(entry.key)}`;
	return undefined;
}

export function rejectDuplicateLogin<T extends AuthEntry>(
	providerId: string,
	credentials: T,
): T {
	const identity = accountIdentity(credentials);
	if (!identity) return credentials;
	const duplicate = Object.entries(readAuthFile()).find(
		([existingId, entry]) =>
			existingId !== providerId && accountIdentity(entry) === identity,
	);
	if (duplicate) {
		throw new Error(
			`This real account is already logged in as "${duplicate[0]}". Use that slot, or log it out before replacing it.`,
		);
	}
	return credentials;
}

/** True when the credential is present and not provably dead. */
export function isEntryUsable(entry: AuthEntry | undefined): boolean {
	if (!entry) return false;
	if (entry.type === "api_key" || entry.key)
		return typeof entry.key === "string" && entry.key.length > 0;
	if (typeof entry.access !== "string" || entry.access.length === 0)
		return false;
	// Expired access token with no refresh token → unrecoverable.
	const storedExpiry =
		typeof entry.expires === "number" && Number.isFinite(entry.expires)
			? entry.expires < 10_000_000_000
				? entry.expires * 1000
				: entry.expires
			: undefined;
	const expMs = jwtExpMs(entry.access) ?? storedExpiry;
	if (
		expMs !== undefined &&
		expMs <= Date.now() &&
		!(typeof entry.refresh === "string" && entry.refresh.length > 0)
	) {
		return false;
	}
	return true;
}

/**
 * Merge a freshly refreshed OAuth credential back onto the stored one. Spreading `...refreshed` is
 * the whole point: it carries the NEW access token (and expiry) onto the credential Pi uses next.
 * Dropping it — keeping only the old access — makes every post-refresh call reuse an expired token
 * and 401 forever, which is how an alias slot got its tokens silently discarded and was then wrongly
 * killed by the consecutive-401 guard. `refresh` is preserved when the provider mints no new refresh
 * token. Exported for unit testing so the two refresh paths can never silently diverge again.
 */
export function mergeRefreshedCredentials(credentials: any, refreshed: any) {
	return {
		...credentials,
		...refreshed,
		refresh:
			typeof refreshed?.refresh === "string" && refreshed.refresh.trim().length > 0
				? refreshed.refresh
				: credentials.refresh,
	};
}

/**
 * Refresh an OAuth credential, and survive losing a race for it.
 *
 * Anthropic rotates the refresh token on every use and kills the old one the moment the new one
 * is issued. So any second holder of that credential — another Pi window, a background usage
 * probe that read the file a second earlier, a `/login` in a neighbouring session — presents a
 * token that was valid when it was read and is already dead when it arrives. The server answers
 * `invalid_grant`, which reads identically to a genuinely revoked account, and the slot was
 * dropped from the rotation with a demand to re-login that fixed nothing: the working token had
 * been on disk the whole time, written by whoever won the race.
 *
 * So on `invalid_grant` — and only on `invalid_grant` — we re-read what is stored now and try
 * once more. If disk holds the same token that just failed there is nothing new to send, and the
 * account really is revoked: fail immediately so rotation moves on. Any other error (a timeout, a
 * 5xx) is not a statement about the token and is never retried, since burning the disk token on a
 * network blip would turn an outage into a lost account.
 *
 * Exported for tests: this is the one piece of logic that decides whether an account survives.
 */
export async function refreshWithDiskRetry(opts: {
	credentials: any;
	refresh: (credentials: any) => Promise<any>;
	storedRefresh: () => string | undefined;
}): Promise<any> {
	try {
		return await opts.refresh(opts.credentials);
	} catch (error) {
		if (!/invalid_grant/i.test(String((error as any)?.message ?? error)))
			throw error;
		const stored = opts.storedRefresh();
		if (!stored || stored === opts.credentials?.refresh) throw error;
		return await opts.refresh({ ...opts.credentials, refresh: stored });
	}
}

/** The refresh token currently stored on disk for a slot — whoever wrote it last wins. */
export function storedRefreshToken(providerId: string): string | undefined {
	const stored = readAuthFile()[providerId] as any;
	return typeof stored?.refresh === "string" && stored.refresh.trim()
		? stored.refresh
		: undefined;
}

/** Single source of truth for Anthropic OAuth refresh — used by BOTH the base provider and aliases. */
export function oauthRefreshSignal(signal?: AbortSignal): AbortSignal {
	return signal instanceof AbortSignal ? signal : AbortSignal.timeout(30_000);
}
