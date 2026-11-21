import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { typescriptNodeArgs } from "./node-typescript.ts";
import multiAccount from "../index.ts";
import { placeholderKeyFor } from "../slot-proxy.ts";
import subagentProvider from "../subagent-provider.ts";

// Capture only discovery registration, without running the parent's session machinery.
test("discovery advertises Codex and xAI provider-only entrypoint", () => {
  let handler: (request: any) => void;
  const stop = new Error("stop after discovery registration");
  assert.throws(() => multiAccount({ events: { on(event: string, fn: typeof handler) {
    assert.equal(event, "rpc-subagents:provider-source:v1");
    handler = fn;
    throw stop;
  } } } as any), (error) => error === stop);
  for (const provider of ["openai-codex", "openai-codex-account-2", "xai", "xai-account-2"]) {
    const paths: string[] = [];
    handler!({ provider, register: (path: string) => paths.push(path) });
    assert.deepEqual(paths, [new URL("../subagent-provider.ts", import.meta.url).pathname]);
  }
  {
    const paths: string[] = [];
    handler!({ provider: "grok-cli", register: (path: string) => paths.push(path) });
    assert.deepEqual(paths, [new URL("../grok-cli-provider.ts", import.meta.url).pathname]);
  }
  for (const provider of ["openai", "openai-codex-account-x", "openai-codex-account-2-extra", "anthropic"]) {
    handler!({ provider, register: () => assert.fail("unsupported provider advertised") });
  }
});

const host = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const storage = pathToFileURL(join(dirname(host), "core/auth-storage.js")).href;
const entrypoint = new URL("../subagent-provider.ts", import.meta.url).href;

for (const protocol of ["loadout", "role-run"] as const) {
for (const { provider, overlay, route, ownedKey, direct } of [
  { provider: "openai-codex", overlay: true },
  { provider: "openai-codex-account-2", overlay: true },
  { provider: "openai-codex", overlay: false },
  { provider: "openai-codex-account-2", overlay: false },
  { provider: "openai-codex-account-2", overlay: true, route: "http://127.0.0.1:9999/openai-codex-account-2", ownedKey: true, direct: true },
  { provider: "openai-codex-account-2", overlay: true, route: "http://127.0.0.1:9999/openai-codex-account-3", ownedKey: true },
  { provider: "openai-codex-account-2", overlay: true, route: "http://127.0.0.1:9999/openai-codex-account-2", ownedKey: false },
  { provider: "openai-codex-account-2", overlay: true, route: "http://proxy.example/openai-codex-account-2", ownedKey: true },
  { provider: "openai-codex-account-2", overlay: true, route: "http://127.0.0.1:9999/openai-codex-account-2/extra", ownedKey: true },
]) {
  test(`fresh ${protocol} child registers only ${provider} (${route ?? (overlay ? "proxy overlay" : "default catalog")}; owned key ${!!ownedKey})`, () => {
    const root = mkdtempSync(join(tmpdir(), "pmacct-child-"));
    const configuredUrl = route ?? "http://127.0.0.1:9999/backend-api";
    const expectedUrl = !overlay || direct ? "https://chatgpt.com/backend-api" : configuredUrl;
    const modelId = direct ? "gpt-live-child-test" : "gpt-5.4";
    try {
      const model = `${provider}/${modelId}`;
      const inputPath = join(root, "input.json");
      writeFileSync(inputPath, JSON.stringify(protocol === "role-run" ? { plan: { model } } : { model }));
      const protocolEnvKey = protocol === "role-run" ? "PI_RPC_SUBAGENT_ROLE_RUN" : "PI_RPC_SUBAGENT_LOADOUT";
      const driver = `
import assert from 'node:assert/strict';
import { ModelRuntime } from ${JSON.stringify(pathToFileURL(host).href)};
import { AuthStorage } from ${JSON.stringify(storage)};
import child from ${JSON.stringify(entrypoint)};
process.env.PI_RPC_SUBAGENT_CHILD = "1";
process.env[${JSON.stringify(protocolEnvKey)}] = ${JSON.stringify(inputPath)};
const provider = ${JSON.stringify(provider)};
const baseUrl = ${JSON.stringify(expectedUrl)};
const modelId = ${JSON.stringify(modelId)};
const registrations = [];
// The API intentionally has no tools, events, session/model or UI methods.
child({ registerProvider: (id, config) => registrations.push({ id, config }) });
assert.deepEqual(registrations.map(p => p.id), [provider]);
const config = registrations[0].config;
assert.equal(typeof config.oauth.refreshToken, 'function');
assert.equal(typeof config.oauth.getApiKey, 'function');
  const token = account => 'test.' + Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: account }
  })).toString('base64url') + '.signature';
  const access = token('selected-account');
  const credentials = AuthStorage.inMemory({
    [provider]: { type: 'oauth', access, refresh: 'synthetic', expires: Date.now() + 3600000 },
    'openai-codex-account-3': { type: 'oauth', access: token('wrong-account'), expires: Date.now() + 3600000 },
  });
  const runtime = await ModelRuntime.create({ credentials, modelsPath: process.env.TEST_MODELS, allowModelNetwork: false });
  runtime.registerProvider(provider, config);
  await runtime.refresh({ allowNetwork: false });
  const model = runtime.getModel(provider, modelId);
  assert.ok(model);
  assert.equal(model.provider, provider);
  if (${!!direct}) assert.equal(model.contextWindow, 123456);
  assert.equal(model.baseUrl, baseUrl);
  const resolution = await runtime.getAuth(model);
  assert.equal(resolution?.auth.apiKey, access);
  assert.equal(runtime.isUsingOAuth(provider), true);
  let requests = 0;
  const result = await runtime.streamSimple(model, { messages: [{ role: 'user', content: 'test', timestamp: 1 }] }, {
    transport: 'sse',
    fetch: async (url, init) => {
      requests++;
      assert.equal(String(url), baseUrl + '/codex/responses');
      const headers = new Headers(init.headers);
      assert.equal(headers.get('authorization'), 'Bearer ' + access);
      assert.equal(headers.get('chatgpt-account-id'), 'selected-account');
      return new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 0 } } }) + '\\n\\n', { headers: { 'content-type': 'text/event-stream' } });
    },
  }).result();
  assert.equal(requests, 1);
  assert.equal(result.stopReason, 'stop', result.errorMessage);
  assert.equal(result.provider, provider);
console.log('child preflight OK');
`;
      writeFileSync(join(root, "driver.mjs"), driver);
      writeFileSync(join(root, "models.json"), JSON.stringify({ providers: overlay ? { [provider]: {
        baseUrl: configuredUrl, api: "openai-codex-responses", apiKey: ownedKey ? placeholderKeyFor("codex") : "placeholder",
        models: [{ id: modelId, ...(direct ? { baseUrl: configuredUrl, contextWindow: 123456, maxTokens: 1000, reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } : {}) }],
      } } : {} }));
      const env = { ...process.env };
      delete env.PI_RPC_SUBAGENT_LOADOUT;
      delete env.PI_RPC_SUBAGENT_ROLE_RUN;
      env[protocol === "role-run" ? "PI_RPC_SUBAGENT_ROLE_RUN" : "PI_RPC_SUBAGENT_LOADOUT"] = inputPath;
      const output = execFileSync(process.execPath, [...typescriptNodeArgs, join(root, "driver.mjs")], {
        encoding: "utf8", env: { ...env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: root,
          PI_RPC_SUBAGENT_CHILD: "1", TEST_MODELS: join(root, "models.json") },
      });
      assert.match(output, /child preflight OK/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
}

test("child startup validates identity, input and provider for both protocols", () => {
  const root = mkdtempSync(join(tmpdir(), "pmacct-child-input-"));
  const keys = ["PI_RPC_SUBAGENT_CHILD", "PI_RPC_SUBAGENT_LOADOUT", "PI_RPC_SUBAGENT_ROLE_RUN"] as const;
  const previous = keys.map(key => process.env[key]);
  const registrations: string[] = [];
  const pi = { registerProvider: (id: string) => { registrations.push(id); } } as unknown as Parameters<typeof subagentProvider>[0];
  try {
    for (const key of keys) delete process.env[key];
    for (const protocol of ["loadout", "role-run"] as const) {
      const key = protocol === "role-run" ? "PI_RPC_SUBAGENT_ROLE_RUN" : "PI_RPC_SUBAGENT_LOADOUT";
      const path = join(root, `${protocol}.json`);
      const writeModel = (model: unknown) => writeFileSync(path, JSON.stringify(protocol === "role-run" ? { plan: { model } } : { model }));
      process.env[key] = path;
      writeModel("openai-codex/gpt-5.4");
      for (const marker of [undefined, "0"]) {
        if (marker === undefined) delete process.env.PI_RPC_SUBAGENT_CHILD;
        else process.env.PI_RPC_SUBAGENT_CHILD = marker;
        assert.throws(() => subagentProvider(pi), /requires an RPC subagent/);
      }
      process.env.PI_RPC_SUBAGENT_CHILD = "1";
      for (const model of [undefined, 42, "anthropic/claude", "openai-codex-account-x/gpt-5.4"]) {
        writeModel(model);
        assert.throws(() => subagentProvider(pi), /Unsupported child provider/);
      }
      writeFileSync(path, "{");
      assert.throws(() => subagentProvider(pi), SyntaxError);
      delete process.env[key];
      assert.throws(() => subagentProvider(pi), /requires an RPC subagent/);
    }
    assert.deepEqual(registrations, []);

    const rolePath = join(root, "role-run.json");
    writeFileSync(rolePath, JSON.stringify({ model: "anthropic/claude", plan: { model: "openai-codex-account-2/gpt-5.4" } }));
    process.env.PI_RPC_SUBAGENT_ROLE_RUN = rolePath;
    process.env.PI_RPC_SUBAGENT_LOADOUT = join(root, "missing-legacy.json");
    subagentProvider(pi);
    assert.deepEqual(registrations, ["openai-codex-account-2"]);
    writeFileSync(rolePath, JSON.stringify({ model: "openai-codex/gpt-5.4" }));
    assert.throws(() => subagentProvider(pi), /Unsupported child provider/);
    assert.deepEqual(registrations, ["openai-codex-account-2"]);
  } finally {
    keys.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    });
    rmSync(root, { recursive: true, force: true });
  }
});
