/**
 * The rules a parent-owned loopback route has to hold.
 *
 * A port on 127.0.0.1 is reachable by every process on the machine, and what sits behind this one
 * is the user's subscription. So the interesting tests here are refusals, not forwards.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	PROXY_PLACEHOLDER_JWT,
	PROXY_PLACEHOLDER_KEY,
	UPSTREAM_BASE,
	admitRequest,
	parseProxyPath,
	isPublishedPlaceholder,
	placeholderKeyFor,
	presentedCredential,
	SLOT_PROXY_HEALTH_PATH,
	isHealthySlotProxyProbe,
	probeHealthySlotProxy,
	publishedRouteFor,
	shapeUpstreamRequest,
	shapeProxyCodexBody,
	buildPlaceholderJwt,
	type ProxyRoute,
} from "../slot-proxy.ts";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROUTES = new Map<string, ProxyRoute>([
	["anthropic-account-2", { slotId: "anthropic-account-2", family: "anthropic" }],
	["openai-codex-account-4", { slotId: "openai-codex-account-4", family: "codex" }],
]);
const withKey = (key = PROXY_PLACEHOLDER_KEY) => ({ authorization: `Bearer ${key}` });

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

test("a slot route splits into the slot and the path to forward", () => {
	assert.deepEqual(parseProxyPath("/anthropic-account-2/v1/messages"), {
		slotId: "anthropic-account-2",
		rest: "/v1/messages",
	});
	assert.deepEqual(parseProxyPath("/openai-codex-account-4/codex/responses?stream=1"), {
		slotId: "openai-codex-account-4",
		rest: "/codex/responses?stream=1",
	});
	// A bare slot with no path is legitimate; it forwards to the upstream root.
	assert.deepEqual(parseProxyPath("/zai"), { slotId: "zai", rest: "/" });
});

test("anything that is not a slot route is refused rather than guessed at", () => {
	for (const url of ["", "v1/messages", "//v1", "/../etc/passwd", "/%2e%2e/x"]) {
		assert.equal(parseProxyPath(url), undefined, JSON.stringify(url));
	}
});

test("a path trying to climb out of its slot is refused, not normalised", () => {
	// Normalising is where traversal bugs live; there is no caller that needs `..`.
	for (const url of [
		"/anthropic-account-2/../openai-codex-account-4/v1",
		"/anthropic-account-2/v1/%2E%2E/admin",
	]) {
		assert.equal(parseProxyPath(url), undefined, url);
	}
});

// ---------------------------------------------------------------------------
// Admission — the two gates
// ---------------------------------------------------------------------------

test("a published slot presenting the placeholder is admitted when no secret file exists", () => {
	const verdict = admitRequest({
		rawUrl: "/anthropic-account-2/v1/messages",
		headers: withKey(),
		routes: ROUTES,
		secretPath: "/nonexistent/slot-proxy-key",
	});
	assert.equal(verdict.ok, true);
	if (!verdict.ok) return;
	assert.equal(verdict.route.family, "anthropic");
	assert.equal(verdict.rest, "/v1/messages");
});

test("a slot we never published is not served", () => {
	// Otherwise the port is a way to reach any upstream on the user's tokens.
	const verdict = admitRequest({
		rawUrl: "/some-other-provider/v1/messages",
		headers: withKey(),
		routes: ROUTES,
	});
	assert.equal(verdict.ok, false);
	if (verdict.ok) return;
	assert.equal(verdict.status, 404);
});

test("a caller that does not present the placeholder is refused", () => {
	// Every process on this machine can find a loopback port. Without this gate, any of them
	// could spend the user's subscription.
	for (const headers of [{}, withKey("something-else"), { "x-api-key": "sk-real-looking" }]) {
		const verdict = admitRequest({
			rawUrl: "/anthropic-account-2/v1/messages",
			headers,
			routes: ROUTES,
		});
		assert.equal(verdict.ok, false, JSON.stringify(headers));
		if (verdict.ok) return;
		assert.equal(verdict.status, 401);
	}
});

test("a refusal never echoes what the caller presented", () => {
	// It may be a real credential belonging to whoever called, and refusals get logged.
	const verdict = admitRequest({
		rawUrl: "/anthropic-account-2/v1/messages",
		headers: { "x-api-key": "sk-caller-secret" },
		routes: ROUTES,
	});
	assert.equal(verdict.ok, false);
	if (verdict.ok) return;
	assert.equal(JSON.stringify(verdict).includes("sk-caller-secret"), false);
});

test("the placeholder is read from either header a Pi provider might use", () => {
	assert.equal(presentedCredential({ authorization: "Bearer abc" }), "abc");
	assert.equal(presentedCredential({ "x-api-key": "abc" }), "abc");
	assert.equal(presentedCredential({ authorization: ["Bearer abc"] }), "abc");
	assert.equal(presentedCredential({}), undefined);
});

// ---------------------------------------------------------------------------
// The outgoing request
// ---------------------------------------------------------------------------

const anthropicRoute: ProxyRoute = { slotId: "anthropic-account-2", family: "anthropic" };
const codexRoute: ProxyRoute = { slotId: "openai-codex-account-4", family: "codex" };

test("the placeholder never reaches the upstream; the real token does", () => {
	const shaped = shapeUpstreamRequest({
		route: anthropicRoute,
		rest: "/v1/messages",
		headers: { authorization: `Bearer ${PROXY_PLACEHOLDER_KEY}`, "content-type": "application/json" },
		credential: { type: "oauth", access: "real-anthropic-token" },
	});
	assert.equal(shaped.ok, true);
	if (!shaped.ok) return;
	assert.equal(shaped.url, `${UPSTREAM_BASE.anthropic}/v1/messages`);
	assert.equal(shaped.headers.authorization, "Bearer real-anthropic-token");
	assert.equal(JSON.stringify(shaped.headers).includes(PROXY_PLACEHOLDER_KEY), false);
	assert.equal(shaped.headers["content-type"], "application/json");
});

test("Anthropic gets the header without which a subscription token is rejected", () => {
	const shaped = shapeUpstreamRequest({
		route: anthropicRoute,
		rest: "/v1/messages",
		headers: {},
		credential: { type: "oauth", access: "t" },
	});
	assert.equal(shaped.ok, true);
	if (!shaped.ok) return;
	assert.equal(shaped.headers["anthropic-beta"], "oauth-2025-04-20");
});

test("a beta flag the caller already asked for is kept, and ours is added once", () => {
	const shaped = shapeUpstreamRequest({
		route: anthropicRoute,
		rest: "/v1/messages",
		headers: { "anthropic-beta": "fine-grained-tool-streaming-2025-05-14, oauth-2025-04-20" },
		credential: { type: "oauth", access: "t" },
	});
	assert.equal(shaped.ok, true);
	if (!shaped.ok) return;
	assert.equal(
		shaped.headers["anthropic-beta"],
		"fine-grained-tool-streaming-2025-05-14,oauth-2025-04-20",
	);
});

test("Codex is routed by account, which it refuses to serve without", () => {
	const shaped = shapeUpstreamRequest({
		route: codexRoute,
		rest: "/codex/responses",
		headers: {},
		credential: { type: "oauth", access: "t", accountId: "acct-9" },
	});
	assert.equal(shaped.ok, true);
	if (!shaped.ok) return;
	assert.equal(shaped.url, `${UPSTREAM_BASE.codex}/codex/responses`);
	assert.equal(shaped.headers["chatgpt-account-id"], "acct-9");
	assert.equal(shaped.headers.originator, "pi");
});

test("an API-key slot uses the header its family actually reads", () => {
	const anthropic = shapeUpstreamRequest({
		route: anthropicRoute,
		rest: "/v1/messages",
		headers: {},
		credential: { type: "api_key", key: "sk-real" },
	});
	assert.equal(anthropic.ok, true);
	if (!anthropic.ok) return;
	assert.equal(anthropic.headers["x-api-key"], "sk-real");
	assert.equal(anthropic.headers.authorization, undefined);
});

test("hop-by-hop and recomputed headers are not copied through", () => {
	const shaped = shapeUpstreamRequest({
		route: anthropicRoute,
		rest: "/v1/messages",
		headers: {
			host: "127.0.0.1:41977",
			"content-length": "9999",
			connection: "keep-alive",
			"transfer-encoding": "chunked",
			"accept-encoding": "gzip",
			"user-agent": "pi",
		},
		credential: { type: "oauth", access: "t" },
	});
	assert.equal(shaped.ok, true);
	if (!shaped.ok) return;
	for (const dropped of ["host", "content-length", "connection", "transfer-encoding", "accept-encoding"]) {
		assert.equal(shaped.headers[dropped], undefined, dropped);
	}
	// A header the caller legitimately set still travels.
	assert.equal(shaped.headers["user-agent"], "pi");
});

test("a slot with no usable credential is refused, and the message says what to do", () => {
	for (const credential of [undefined, {}, { type: "oauth" }, { type: "api_key" }]) {
		const shaped = shapeUpstreamRequest({
			route: anthropicRoute,
			rest: "/v1/messages",
			headers: {},
			credential,
		});
		assert.equal(shaped.ok, false, JSON.stringify(credential));
		if (shaped.ok) return;
		assert.equal(shaped.status, 401);
		assert.match(shaped.message, /\/login/);
	}
});

test("no failure path ever puts the real token in its message", () => {
	const shaped = shapeUpstreamRequest({
		route: { slotId: "x", family: "nonsense" as any },
		rest: "/v1",
		headers: {},
		credential: { type: "oauth", access: "REAL-TOKEN" },
	});
	assert.equal(shaped.ok, false);
	if (shaped.ok) return;
	assert.equal(shaped.message.includes("REAL-TOKEN"), false);
});

test("the published route points at this machine and carries the slot", () => {
	const url = publishedRouteFor(41977, "anthropic-account-2");
	assert.equal(url, "http://127.0.0.1:41977/anthropic-account-2");
	assert.equal(new URL(url).hostname, "127.0.0.1");
});

// ---------------------------------------------------------------------------
// The Codex placeholder has to survive being parsed as a token
// ---------------------------------------------------------------------------

test("Pi reads an account id out of the Codex key, so that placeholder is token-shaped", () => {
	// Measured against a real `pi -p --no-extensions` child: a plain placeholder fails before any
	// request with "Failed to extract accountId from token". Pi splits on ".", base64-decodes the
	// middle segment and reads chatgpt_account_id — no signature is checked.
	const parts = PROXY_PLACEHOLDER_JWT.split(".");
	assert.equal(parts.length, 3);
	const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
	assert.equal(payload["https://api.openai.com/auth"].chatgpt_account_id, PROXY_PLACEHOLDER_KEY);
	// Nothing real is in it: no signature, no algorithm, and the user's own account id stays out.
	assert.equal(parts[2], "");
	assert.equal(JSON.parse(Buffer.from(parts[0], "base64").toString("utf8")).alg, "none");
});

test("each family is published with the placeholder its own API will accept", () => {
	const missingSecret = "/nonexistent/slot-proxy-key";
	assert.equal(placeholderKeyFor("codex", missingSecret), PROXY_PLACEHOLDER_JWT);
	assert.equal(placeholderKeyFor("anthropic", missingSecret), PROXY_PLACEHOLDER_KEY);
});

test("both placeholders are admitted; nothing else is", () => {
	const missingSecret = "/nonexistent/slot-proxy-key";
	assert.equal(isPublishedPlaceholder(PROXY_PLACEHOLDER_KEY, missingSecret), true);
	assert.equal(isPublishedPlaceholder(PROXY_PLACEHOLDER_JWT, missingSecret), true);
	for (const other of [undefined, "", "sk-real", `${PROXY_PLACEHOLDER_JWT}x`]) {
		assert.equal(isPublishedPlaceholder(other, missingSecret), false, String(other));
	}
});

test("slot-proxy-key derives per-user alg:none JWT and strictly rejects public legacy constants", () => {
	const dir = mkdtempSync(join(tmpdir(), "slot-proxy-secret-"));
	try {
		const secretPath = join(dir, "slot-proxy-key");
		writeFileSync(secretPath, "my-local-machine-secret-99\n", { mode: 0o600 });
		const codexJwt = placeholderKeyFor("codex", secretPath);
		const anthropicKey = placeholderKeyFor("anthropic", secretPath);
		assert.notEqual(codexJwt, PROXY_PLACEHOLDER_JWT);
		assert.notEqual(anthropicKey, PROXY_PLACEHOLDER_KEY);
		assert.equal(codexJwt.includes("my-local-machine-secret-99"), false);
		assert.equal(codexJwt, buildPlaceholderJwt(anthropicKey));
		const header = JSON.parse(Buffer.from(codexJwt.split(".")[0]!, "base64").toString("utf8"));
		assert.equal(header.alg, "none");

		// Derived per-user tokens are admitted.
		for (const token of [codexJwt, anthropicKey]) {
			const verdict = admitRequest({
				rawUrl: "/openai-codex-account-4/codex/responses",
				headers: { authorization: `Bearer ${token}` },
				routes: ROUTES,
				secretPath,
			});
			assert.equal(verdict.ok, true);
		}
		// Public legacy constants and forged tokens are strictly rejected when slot-proxy-key exists.
		for (const rejectedToken of [
			PROXY_PLACEHOLDER_JWT,
			PROXY_PLACEHOLDER_KEY,
			buildPlaceholderJwt("forged-other-user"),
		]) {
			const rejected = admitRequest({
				rawUrl: "/openai-codex-account-4/codex/responses",
				headers: { authorization: `Bearer ${rejectedToken}` },
				routes: ROUTES,
				secretPath,
			});
			assert.equal(rejected.ok, false);
			if (!rejected.ok) assert.equal(rejected.status, 401);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("shapeProxyCodexBody injects or removes service_tier priority per codex-fast-mode", () => {
	const raw = Buffer.from(JSON.stringify({ model: "gpt-6-astra", input: "hello" }));
	const withFast = JSON.parse(shapeProxyCodexBody(raw, true).toString("utf8"));
	assert.equal(withFast.service_tier, "priority");
	const withoutFast = JSON.parse(
		shapeProxyCodexBody(Buffer.from(JSON.stringify(withFast)), false).toString("utf8"),
	);
	assert.equal("service_tier" in withoutFast, false);
});

test("a Codex slot presenting the JWT placeholder is admitted when no secret file exists", () => {
	const verdict = admitRequest({
		rawUrl: "/openai-codex-account-4/codex/responses",
		headers: { authorization: `Bearer ${PROXY_PLACEHOLDER_JWT}` },
		routes: ROUTES,
		secretPath: "/nonexistent/slot-proxy-key",
	});
	assert.equal(verdict.ok, true);
});

test("the account id Pi filled in from the placeholder is replaced, never merely defaulted", () => {
	// Pi sets chatgpt-account-id from whatever it read out of the key. Left alone, the request
	// would reach Codex naming an account that does not exist.
	const shaped = shapeUpstreamRequest({
		route: codexRoute,
		rest: "/codex/responses",
		headers: { "chatgpt-account-id": PROXY_PLACEHOLDER_KEY },
		credential: { type: "oauth", access: "t", accountId: "acct-9" },
	});
	assert.equal(shaped.ok, true);
	if (!shaped.ok) return;
	assert.equal(shaped.headers["chatgpt-account-id"], "acct-9");
});

test("a Codex credential with no account id sends none, rather than the placeholder", () => {
	const shaped = shapeUpstreamRequest({
		route: codexRoute,
		rest: "/codex/responses",
		headers: { "chatgpt-account-id": PROXY_PLACEHOLDER_KEY },
		credential: { type: "oauth", access: "t" },
	});
	assert.equal(shaped.ok, true);
	if (!shaped.ok) return;
	assert.equal(shaped.headers["chatgpt-account-id"], undefined);
});

test("healthy loopback slot-proxy probe requires explicit 200 health JSON and rejects all 404 responses", async () => {
	assert.equal(isHealthySlotProxyProbe(200, JSON.stringify({ ok: true, service: "pi-multi-account-slot-proxy" })), true);
	assert.equal(isHealthySlotProxyProbe(404, JSON.stringify({ error: { message: "not a slot route" } })), false);
	assert.equal(isHealthySlotProxyProbe(404, "Not Found"), false);
	assert.equal(isHealthySlotProxyProbe(200, JSON.stringify({ ok: true, service: "something-else" })), false);

	const server = createServer((req, res) => {
		if (req.url === SLOT_PROXY_HEALTH_PATH) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true, service: "pi-multi-account-slot-proxy" }));
			return;
		}
		res.writeHead(500);
		res.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	try {
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		assert.equal(await probeHealthySlotProxy(port), true);
	} finally {
		server.close();
	}
});
