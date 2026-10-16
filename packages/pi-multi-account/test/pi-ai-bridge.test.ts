/**
 * Regression tests for the pi-ai OAuth boundary — the one that has now taken the whole
 * extension down twice in the field (issue #3):
 *
 *   1. `npm i` / `pi install` HOIST @earendil-works/pi-ai next to the package instead of
 *      nesting it inside, so probing only `<ext>/node_modules/...` found nothing and the
 *      extension threw at load.
 *   2. pi-ai 0.80 emptied `dist/oauth.js` (types only) and moved the OAuth implementations
 *      behind provider factories, so even a resolvable pi-ai no longer had the old exports.
 *
 * These run the REAL module resolution in a child process against fabricated pi-ai
 * installs, because that boundary is exactly what an in-process mock cannot check.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { typescriptNodeArgs } from "./node-typescript.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Derived from the published file list rather than hand-maintained: a new root module that
// index.ts imports but this fixture does not copy fails these tests with a module-not-found
// that says nothing about the real problem.
const EXTENSION_SOURCES = JSON.parse(
	readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
).files as string[];

const { piAiRootCandidates } = (await import("../index.ts")) as {
	piAiRootCandidates: (
		fromFile: string,
		resolver?: (specifier: string) => string,
	) => string[];
};

/** pi-ai <= 0.79: real runtime helpers on the `dist/oauth.js` entry point. */
const LEGACY_OAUTH_ENTRY = `export function loginAnthropic(callbacks) {
	callbacks.onAuth({ url: "https://claude.ai/oauth/authorize?era=legacy" });
	return Promise.resolve({ type: "oauth", access: "legacy-access", refresh: "legacy-refresh" });
}
export function refreshAnthropicToken(refreshToken, signal) {
	if (!(signal instanceof AbortSignal)) throw new TypeError("legacy Anthropic refresh requires AbortSignal");
	return Promise.resolve({ access: "legacy-refreshed:" + refreshToken, refresh: refreshToken });
}
export const openaiCodexOAuthProvider = {
	usesCallbackServer: true,
	login: () => Promise.resolve({ type: "oauth", access: "codex-access" }),
	refreshToken: (credentials, signal) => {
		if (!(signal instanceof AbortSignal)) throw new TypeError("legacy Codex refresh requires AbortSignal");
		return Promise.resolve({ ...credentials, access: "codex-refreshed" });
	},
	getApiKey: (credentials) => credentials.access,
};
`;

/** pi-ai >= 0.80: `dist/oauth.js` is types-only; OAuth lives behind provider factories. */
const MODERN_OAUTH_ENTRY = "export {};\n";
const MODERN_ANTHROPIC_PROVIDER = `export function anthropicProvider() {
	return {
		id: "anthropic",
		auth: {
			oauth: {
				name: "Anthropic (Claude Pro/Max)",
				async login(interaction) {
					// The new API hands out AuthEvents, not the legacy callbacks.
					interaction.notify({ type: "auth_url", url: "https://claude.ai/oauth/authorize?era=modern" });
					interaction.notify({ type: "info", message: "waiting for browser" });
					return { type: "oauth", access: "modern-access", refresh: "modern-refresh" };
				},
				async refresh(credential, signal) {
					if (!(signal instanceof AbortSignal)) throw new TypeError("modern Anthropic refresh requires AbortSignal");
					return { ...credential, access: "modern-refreshed:" + credential.refresh };
				},
				async toAuth(credential) {
					return { apiKey: credential.access };
				},
			},
		},
	};
}
`;
const MODERN_CODEX_PROVIDER = `export function openaiCodexProvider() {
	return {
		id: "openai-codex",
		auth: {
			oauth: {
				name: "OpenAI (ChatGPT Plus/Pro)",
				async login() {
					return { type: "oauth", access: "codex-access" };
				},
				async refresh(credential, signal) {
					if (!(signal instanceof AbortSignal)) throw new TypeError("modern Codex refresh requires AbortSignal");
					return { ...credential, access: "codex-refreshed" };
				},
				async toAuth(credential) {
					return { apiKey: credential.access };
				},
			},
		},
	};
}
`;

/**
 * Build a HOISTED install: the extension has NO node_modules of its own and pi-ai lives in
 * an ancestor's node_modules — the shape `npm i pi-multi-account` produces, and precisely
 * what the old nested-only probe could not find (pi-ai sits two ancestor levels up).
 *
 * The extension directory is deliberately NOT literally named `node_modules/...`: Node
 * refuses to type-strip .ts under node_modules, while real Pi loads it through jiti. The
 * ancestor distance — which is what the resolution bug was about — is identical either way,
 * and the exact npm path shape is locked by the `piAiRootCandidates` test below.
 */
// Vendored providers require pi-ai's core runtime even when its optional OAuth
// entry points are absent. These stubs export NO OAuth and fail if accidentally
// used for inference: this fixture only exercises module loading and OAuth.
function installCoreRuntime(root: string): string {
	const piAi = join(root, "node_modules", "@earendil-works", "pi-ai");
	mkdirSync(join(piAi, "dist", "providers"), { recursive: true });
	writeFileSync(join(piAi, "package.json"), JSON.stringify({
		name: "@earendil-works/pi-ai", version: "0.0.0-test", type: "module",
		exports: { ".": "./index.js", "./compat": "./compat.js" },
	}));
	writeFileSync(join(piAi, "index.js"), `
const unexpected = () => { throw new Error("unexpected inference in OAuth fixture"); };
export const lazyStream = unexpected;
export const calculateCost = unexpected;
export const createAssistantMessageEventStream = unexpected;
`);
	writeFileSync(join(piAi, "compat.js"), `
export function streamSimpleOpenAIResponses() { throw new Error("unexpected inference in OAuth fixture"); }
`);
	return piAi;
}

function buildHoistedInstall(era: "legacy" | "modern"): string {
	const root = mkdtempSync(join(tmpdir(), `pmacct-bridge-${era}-`));
	const piAi = installCoreRuntime(root);
	if (era === "legacy") {
		writeFileSync(join(piAi, "dist", "oauth.js"), LEGACY_OAUTH_ENTRY);
	} else {
		writeFileSync(join(piAi, "dist", "oauth.js"), MODERN_OAUTH_ENTRY);
		writeFileSync(join(piAi, "dist", "providers", "anthropic.js"), MODERN_ANTHROPIC_PROVIDER);
		writeFileSync(join(piAi, "dist", "providers", "openai-codex.js"), MODERN_CODEX_PROVIDER);
	}

	const ext = join(root, "pkg", "pi-multi-account");
	mkdirSync(ext, { recursive: true });
	for (const file of EXTENSION_SOURCES) {
		cpSync(join(REPO_ROOT, file), join(ext, file), { recursive: true });
	}
	writeFileSync(
		join(ext, "package.json"),
		JSON.stringify({ name: "pi-multi-account", version: "0.0.0-test", type: "module" }),
	);
	return root;
}

const DRIVER = `import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pmacct-bridge-agent-"));
process.env.PI_CURSOR_PROVIDER_ROOT = join(process.env.PI_CODING_AGENT_DIR, "no-cursor");

const mod = await import(process.argv[2]);
const providers = [];
mod.default({
	events: { on: () => {} },
	registerProvider: (name, cfg) => providers.push({ name, cfg }),
	registerCommand: () => {},
	on: () => {},
	setModel: async () => true,
	sendUserMessage: () => {},
	continueAgent: async () => {},
	appendEntry: () => {},
	getThinkingLevel: () => "high",
	setThinkingLevel: () => {},
});

const anthropic = providers.find((p) => p.name === "anthropic");
const codex = providers.find((p) => p.name === "openai-codex");
const result = {
	loaded: true,
	// Reading this property is what used to crash the extension at load time.
	usesCallbackServer: codex?.cfg?.oauth?.usesCallbackServer,
	authUrl: undefined,
	refreshed: undefined,
	codexRefreshed: undefined,
	loginError: undefined,
};
// Login/refresh may legitimately fail when there is no usable pi-ai OAuth — the contract is that
// they fail HERE, loudly, rather than taking the extension down at load time.
const login = anthropic?.cfg?.oauth?.login;
if (typeof login === "function") {
	try {
		await login({
			onAuth: (info) => { result.authUrl = info.url; },
			onDeviceCode: () => {},
			onProgress: () => {},
			onPrompt: async () => "",
			onSelect: async () => "",
		});
	} catch (error) {
		result.loginError = String(error?.message ?? error);
	}
}
const refresh = anthropic?.cfg?.oauth?.refreshToken;
if (typeof refresh === "function") {
	try {
		const out = await refresh({ type: "oauth", access: "old", refresh: "the-refresh-token" });
		result.refreshed = out?.access;
	} catch {
		// Same contract as login.
	}
}
const codexRefresh = codex?.cfg?.oauth?.refreshToken;
if (typeof codexRefresh === "function") {
	try {
		const out = await codexRefresh({ type: "oauth", access: "old", refresh: "codex-refresh" });
		result.codexRefreshed = out?.access;
	} catch {
		// Same contract as login.
	}
}
console.log("__RESULT__" + JSON.stringify(result));
`;

function loadExtensionIn(root: string): Record<string, any> {
	const driver = join(root, "driver.mjs");
	writeFileSync(driver, DRIVER);
	const stdout = execFileSync(
		process.execPath,
		[...typescriptNodeArgs, driver, join(root, "pkg", "pi-multi-account", "index.ts")],
		{ cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	);
	const line = stdout.split("\n").find((l) => l.startsWith("__RESULT__"));
	assert.ok(line, `driver produced no result. stdout:\n${stdout}`);
	return JSON.parse(line.slice("__RESULT__".length));
}

test("pi-ai is discovered when hoisted next to the package, not nested inside it", () => {
	// The exact layout `npm i pi-multi-account` produces.
	const extensionFile =
		"/home/u/.pi/agent/npm/node_modules/pi-multi-account/index.ts";
	const candidates = piAiRootCandidates(extensionFile);
	assert.ok(
		candidates.includes(
			"/home/u/.pi/agent/npm/node_modules/@earendil-works/pi-ai",
		),
		`hoisted location must be probed, got:\n${candidates.join("\n")}`,
	);
	// The nested (git-checkout) location must keep working, and win first.
	assert.equal(
		candidates[0],
		"/home/u/.pi/agent/npm/node_modules/pi-multi-account/node_modules/@earendil-works/pi-ai",
	);
});

test("hoisted install with a pre-0.80 pi-ai: extension loads and OAuth works", () => {
	const root = buildHoistedInstall("legacy");
	try {
		const result = loadExtensionIn(root);
		assert.equal(result.loaded, true);
		assert.equal(result.usesCallbackServer, true);
		assert.equal(result.authUrl, "https://claude.ai/oauth/authorize?era=legacy");
		// This era exchanges the bare refresh token, not the whole credential.
		assert.equal(result.refreshed, "legacy-refreshed:the-refresh-token");
		assert.equal(result.codexRefreshed, "codex-refreshed");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("hoisted install with pi-ai >= 0.80 (types-only dist/oauth.js): extension loads and OAuth is adapted", () => {
	const root = buildHoistedInstall("modern");
	try {
		const result = loadExtensionIn(root);
		assert.equal(result.loaded, true);
		// Used to throw: `undefined is not an object (evaluating
		// '_oauth.openaiCodexOAuthProvider.usesCallbackServer')`.
		assert.equal(result.usesCallbackServer, true);
		// Proves the legacy-callbacks -> AuthInteraction adapter really bridges the flow,
		// rather than the extension silently degrading to "OAuth unavailable".
		assert.equal(result.authUrl, "https://claude.ai/oauth/authorize?era=modern");
		assert.equal(result.refreshed, "modern-refreshed:the-refresh-token");
		assert.equal(result.codexRefreshed, "codex-refreshed");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("pi-ai core without OAuth entries: the extension still loads instead of dying at startup", () => {
	const root = mkdtempSync(join(tmpdir(), "pmacct-bridge-none-"));
	try {
		installCoreRuntime(root);
		const ext = join(root, "pkg", "pi-multi-account");
		mkdirSync(ext, { recursive: true });
		for (const file of EXTENSION_SOURCES) {
			cpSync(join(REPO_ROOT, file), join(ext, file), { recursive: true });
		}
		writeFileSync(
			join(ext, "package.json"),
			JSON.stringify({ name: "pi-multi-account", version: "0.0.0-test", type: "module" }),
		);
		const result = loadExtensionIn(root);
		// API-key accounts must keep rotating; only subscription login is unavailable.
		assert.equal(result.loaded, true);
		assert.equal(result.usesCallbackServer, true);
		assert.equal(result.authUrl, undefined);
		// And when the user does try to log in, the failure is explicit and actionable —
		// not a cryptic property-of-undefined crash before the session even starts.
		assert.match(result.loginError ?? "", /OAuth\) login is unavailable/);
		assert.match(result.loginError ?? "", /pi-ai/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
