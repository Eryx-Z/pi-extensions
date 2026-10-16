/** Lazy pi-ai OAuth/catalog compatibility. No extension registration or failover hooks. */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// pi-ai OAuth bridge (version-agnostic)
// ---------------------------------------------------------------------------
//
// This is the single most fragile boundary in the extension, and it has now broken
// twice in the field:
//
//   * pi-coding-agent's extension loader aliases `@earendil-works/pi-ai/oauth` to an
//     empty stub in its own node_modules, so a plain static import yields undefined —
//     the `undefined is not an object (evaluating
//     '_oauth.openaiCodexOAuthProvider.usesCallbackServer')` crash at startup.
//   * pi-ai 0.80 REMOVED the runtime OAuth surface: `dist/oauth.js` is now literally
//     `export {}` (types only), `getModel` moved to `dist/compat.js`, and the OAuth
//     implementations live behind provider factories
//     (`anthropicProvider().auth.oauth`) with a new `login(interaction)` /
//     `refresh(credential)` shape.
//
// So we resolve pi-ai on disk ourselves and normalize BOTH eras behind one internal
// surface. Everything here is best-effort: a pi-ai we cannot adapt degrades to
// "subscription logins unavailable" and the extension still loads, so API-key
// accounts keep rotating instead of the whole extension dying at load time.
//
// The 0.80+ adaptation follows the approach contributed by @lfoscari in PR #4.

/** Normalized OAuth surface — identical for every supported pi-ai version. */
type PiAiOauthBridge = {
	/** pi-ai release line this was adapted from, for the debug log. */
	era: "legacy-oauth-entry" | "provider-factories";
	anthropic: {
		login: (callbacks: any) => Promise<any>;
		refresh: (credentials: any, signal: AbortSignal) => Promise<any>;
	};
	codex: {
		usesCallbackServer: boolean;
		login: (callbacks: any) => Promise<any>;
		refresh: (credentials: any, signal: AbortSignal) => Promise<any>;
		getApiKey: (credentials: any) => string;
	};
	/**
	 * Optional: Kimi exists only in pi-ai's provider-factories era, never in the
	 * legacy oauth.js entry. Absence must not disqualify an otherwise usable bridge.
	 */
	kimi?: {
		login: (callbacks: any) => Promise<any>;
		refresh: (credentials: any, signal: AbortSignal) => Promise<any>;
		getApiKey: (credentials: any) => string;
	};
};

let piAiOauthBridge: PiAiOauthBridge | undefined;
let piAiOauthLoadError: string | undefined;
let piAiPackageRoot: string | undefined | null; // null = searched, not found

/**
 * Locate the `@earendil-works/pi-ai` package directory, nearest-first.
 *
 * A git checkout keeps pi-ai in the extension's OWN node_modules, but `npm i` /
 * `pi install` HOIST it next to the package instead
 * (`~/.pi/agent/npm/node_modules/pi-multi-account` +
 * `~/.pi/agent/npm/node_modules/@earendil-works/pi-ai`), and pnpm hides it behind a
 * symlinked store. Probing only the nested path made the extension fail to load on
 * every hoisted install, so walk ancestors the way Node's own resolver does and fall
 * back to require.resolve().
 */
export function piAiRootCandidates(
	fromFile: string,
	resolver?: (specifier: string) => string,
): string[] {
	const candidates: string[] = [];
	let dir = dirname(fromFile);
	for (let depth = 0; depth < 16; depth++) {
		candidates.push(join(dir, "node_modules", "@earendil-works", "pi-ai"));
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	if (resolver) {
		try {
			// Resolves through "exports"/symlinks even when no ancestor path matched.
			candidates.push(dirname(resolver("@earendil-works/pi-ai/package.json")));
		} catch {
			// Not resolvable from here — the ancestor paths above may still hit.
		}
	}
	return [...new Set(candidates)];
}

function findPiAiRoot(): string | undefined {
	if (piAiPackageRoot !== undefined) return piAiPackageRoot ?? undefined;
	const here = fileURLToPath(import.meta.url);
	const localRequire = createRequire(import.meta.url);
	for (const candidate of piAiRootCandidates(here, (specifier) =>
		localRequire.resolve(specifier),
	)) {
		if (existsSync(join(candidate, "package.json"))) {
			piAiPackageRoot = candidate;
			return candidate;
		}
	}
	piAiPackageRoot = null;
	return undefined;
}

/**
 * Bridge Pi's legacy extension OAuth callbacks (`onAuth`/`onDeviceCode`/`onPrompt`/
 * `onSelect`) to pi-ai 0.80+'s `AuthInteraction` (`notify(event)`/`prompt(prompt)`).
 * Pi still hands us the legacy callbacks, so without this the browser login throws
 * `interaction.notify is not a function`.
 */
function toAuthInteraction(callbacks: any) {
	return {
		signal: callbacks?.signal,
		notify(event: any) {
			if (!event || typeof event !== "object") {
				callbacks?.onProgress?.(String(event ?? ""));
				return;
			}
			if (event.type === "auth_url") {
				callbacks?.onAuth?.({ url: event.url, instructions: event.instructions });
				return;
			}
			if (event.type === "device_code") {
				callbacks?.onDeviceCode?.({
					userCode: event.userCode,
					verificationUri: event.verificationUri,
					intervalSeconds: event.intervalSeconds,
					expiresInSeconds: event.expiresInSeconds,
				});
				return;
			}
			// "info" and "progress" both carry a human-readable message.
			callbacks?.onProgress?.(
				typeof event.message === "string" ? event.message : JSON.stringify(event),
			);
		},
		prompt(prompt: any) {
			if (prompt?.type === "select") return callbacks.onSelect(prompt);
			if (prompt?.type === "manual_code" && callbacks?.onManualCodeInput) {
				return callbacks.onManualCodeInput();
			}
			return callbacks.onPrompt({
				message: prompt?.message ?? "",
				placeholder: prompt?.placeholder,
				allowEmpty: prompt?.allowEmpty,
			});
		},
	};
}

/** pi-ai <= 0.79: runtime OAuth helpers exported straight from `dist/oauth.js`. */
function adaptLegacyOauthEntry(mod: any): PiAiOauthBridge | undefined {
	const codex = mod?.openaiCodexOAuthProvider;
	if (
		typeof mod?.loginAnthropic !== "function" ||
		typeof mod?.refreshAnthropicToken !== "function" ||
		typeof codex?.login !== "function" ||
		typeof codex?.refreshToken !== "function"
	) {
		return undefined;
	}
	return {
		era: "legacy-oauth-entry",
		anthropic: {
			login: (callbacks) => mod.loginAnthropic(callbacks),
			// This era exchanges the bare refresh token, not the whole credential.
			refresh: (credentials, signal) =>
				mod.refreshAnthropicToken(credentials.refresh, signal),
		},
		codex: {
			usesCallbackServer: codex.usesCallbackServer ?? true,
			login: (callbacks) => codex.login(callbacks),
			refresh: (credentials, signal) => codex.refreshToken(credentials, signal),
			getApiKey: (credentials) =>
				typeof codex.getApiKey === "function"
					? codex.getApiKey(credentials)
					: credentials.access,
		},
	};
}

/** pi-ai >= 0.80: OAuth lives behind provider factories, with an AuthInteraction API. */
function adaptProviderFactories(
	anthropicMod: any,
	codexMod: any,
	kimiMod?: any,
): PiAiOauthBridge | undefined {
	const anthropicOauth = anthropicMod?.anthropicProvider?.()?.auth?.oauth;
	const codexOauth = codexMod?.openaiCodexProvider?.()?.auth?.oauth;
	const kimiOauth = kimiMod?.kimiCodingProvider?.()?.auth?.oauth;
	if (
		typeof anthropicOauth?.login !== "function" ||
		typeof anthropicOauth?.refresh !== "function" ||
		typeof codexOauth?.login !== "function" ||
		typeof codexOauth?.refresh !== "function"
	) {
		return undefined;
	}
	return {
		era: "provider-factories",
		anthropic: {
			login: (callbacks) => anthropicOauth.login(toAuthInteraction(callbacks)),
			refresh: (credentials, signal) =>
				anthropicOauth.refresh(credentials, signal),
		},
		codex: {
			// The flag is gone from the new shape; both eras of pi-ai's Codex flow use a
			// local callback server, and Pi only reads this to decide how to present login.
			usesCallbackServer: true,
			login: (callbacks) => codexOauth.login(toAuthInteraction(callbacks)),
			refresh: (credentials, signal) => codexOauth.refresh(credentials, signal),
			// Identical to what pi-ai <= 0.79's getApiKey did (verified in its source).
			getApiKey: (credentials) => credentials.access,
		},
		kimi:
			typeof kimiOauth?.login === "function" &&
			typeof kimiOauth?.refresh === "function"
				? {
						login: (callbacks) => kimiOauth.login(toAuthInteraction(callbacks)),
						refresh: (credentials, signal) => kimiOauth.refresh(credentials, signal),
						getApiKey: (credentials) => credentials.access,
					}
				: undefined,
	};
}

/**
 * Best-effort load + normalization of pi-ai's OAuth surface. NEVER throws.
 *
 * Uses a synchronous require() (Node >= 22 supports require() of ESM without
 * top-level await, and pi-ai qualifies) because providers are registered
 * synchronously — `usesCallbackServer` is read while Pi merely LISTS providers.
 */
export function tryLoadPiAiOauth(): PiAiOauthBridge | undefined {
	if (piAiOauthBridge) return piAiOauthBridge;
	const root = findPiAiRoot();
	if (!root) {
		piAiOauthLoadError = `@earendil-works/pi-ai was not found near ${fileURLToPath(import.meta.url)}. Install @earendil-works/pi-ai alongside pi-multi-account.`;
		return undefined;
	}
	const localRequire = createRequire(import.meta.url);
	const load = (relative: string): any => {
		const file = join(root, "dist", relative);
		if (!existsSync(file)) return undefined;
		try {
			return localRequire(file);
		} catch (error) {
			tried.push(
				`${relative}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return undefined;
		}
	};
	const tried: string[] = [];

	const legacy = adaptLegacyOauthEntry(load("oauth.js"));
	if (legacy) {
		piAiOauthBridge = legacy;
		piAiOauthLoadError = undefined;
		return legacy;
	}
	tried.push("dist/oauth.js exports no runtime OAuth helpers (pi-ai >= 0.80)");

	const modern = adaptProviderFactories(
		load(join("providers", "anthropic.js")),
		load(join("providers", "openai-codex.js")),
		load(join("providers", "kimi-coding.js")),
	);
	if (modern) {
		piAiOauthBridge = modern;
		piAiOauthLoadError = undefined;
		return modern;
	}
	tried.push("dist/providers/{anthropic,openai-codex}.js exposed no auth.oauth");

	piAiOauthLoadError = `the @earendil-works/pi-ai at ${root} exposes no OAuth surface this extension can use. ${tried.join("; ")}`;
	return undefined;
}

/** Load reason, or undefined when OAuth is available. */
export function piAiOauthUnavailableReason(): string | undefined {
	tryLoadPiAiOauth();
	return piAiOauthBridge ? undefined : piAiOauthLoadError;
}

export function requirePiAiOauth(): PiAiOauthBridge {
	const bridge = tryLoadPiAiOauth();
	if (!bridge) {
		throw new Error(
			`pi-multi-account: subscription (OAuth) login is unavailable — ${piAiOauthLoadError}`,
		);
	}
	return bridge;
}

/**
 * pi-ai's static model catalog lookup. It lived on the package root until 0.79 and
 * moved to `dist/compat.js` in 0.80, so resolve it lazily from whichever is present
 * — and treat "absent" as "no canonical metadata", never as a load failure.
 */
let piAiGetModelFn: ((provider: string, id: string) => any) | null | undefined;

export function piAiGetModel(provider: string, id: string): any {
	if (piAiGetModelFn === undefined) {
		piAiGetModelFn = null;
		const root = findPiAiRoot();
		if (root) {
			const localRequire = createRequire(import.meta.url);
			for (const relative of ["compat.js", "index.js"]) {
				const file = join(root, "dist", relative);
				if (!existsSync(file)) continue;
				try {
					const candidate = localRequire(file)?.getModel;
					if (typeof candidate === "function") {
						piAiGetModelFn = candidate;
						break;
					}
				} catch {
					// Try the next entry point.
				}
			}
		}
	}
	try {
		return piAiGetModelFn?.(provider, id);
	} catch {
		return undefined;
	}
}
