import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ModelRuntime, type ExtensionAPI, type ProviderConfig } from '@earendil-works/pi-coding-agent';
const { AuthStorage } = await import(new URL('./core/auth-storage.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href);
import { registerGrokProvider } from '../grok/register.ts';
import child from '../grok-cli-provider.ts';
import { resolveGrokRoute } from '../grok/provider/route.ts';
import { ACCOUNT_VAULT_MARKER, mutateAccountVault } from '../grok/provider/accountVault.ts';
import { handleGrokFast } from '../grok/fast.ts';

function capture(childMode = false) {
  let config!: ProviderConfig;
  const hooks: Record<string, Function> = {};
  const api = {
    registerProvider(id: string, value: ProviderConfig) { assert.equal(id, 'grok-cli'); config = value; },
    on(name: string, handler: Function) { hooks[name] = handler; },
  } as unknown as ExtensionAPI;
  if (childMode) child(api); else registerGrokProvider(api);
  return { config, hooks };
}

test('parent and child register Grok independently, without UI/tools/model mutations', async t => {
  const before = process.env.PI_RPC_SUBAGENT_CHILD;
  try {
    delete process.env.PI_RPC_SUBAGENT_CHILD;
    assert.throws(() => child({} as ExtensionAPI), /requires an RPC subagent/);
    const parent = capture();
    process.env.PI_RPC_SUBAGENT_CHILD = '1';
    const rpc = capture(true);
    assert.deepEqual(rpc.config.models, parent.config.models);
    assert.ok(rpc.config.models?.some(m => m.id === 'grok-4.7-build-fast'));
    assert.deepEqual(Object.keys(rpc.hooks).sort(), ['before_provider_headers', 'before_provider_request']);
    await assert.rejects(rpc.config.oauth!.login({} as never), /parent session/);
    assert.equal(typeof parent.config.oauth!.login, 'function');
    const marker = { access: ACCOUNT_VAULT_MARKER, refresh: ACCOUNT_VAULT_MARKER, expires: 1 };
    assert.equal((await rpc.config.oauth!.refreshToken(marker, new AbortController().signal)).access, ACCOUNT_VAULT_MARKER);
  } finally {
    if (before === undefined) delete process.env.PI_RPC_SUBAGENT_CHILD; else process.env.PI_RPC_SUBAGENT_CHILD = before;
  }
});

test('standalone request uses fast model, Grok headers, sanitizer, bearer token and no Codex tier', async t => {
  const root = mkdtempSync(join(tmpdir(), 'grok-standalone-'));
  const env = process.env.GROK_CLI_OAUTH_TOKEN;
  delete process.env.GROK_CLI_OAUTH_TOKEN;
  t.mock.method(globalThis, 'fetch', async () => new Response('1.0.46'));
  try {
    const { config, hooks } = capture();
    const runtime = await ModelRuntime.create({
      credentials: AuthStorage.inMemory({ 'grok-cli': { type: 'oauth', access: 'synthetic-access', refresh: 'synthetic-refresh', expires: Date.now() + 3600000 } }),
      modelsPath: join(root, 'models.json'), allowModelNetwork: false,
    });
    runtime.registerProvider('grok-cli', config);
    await runtime.refresh({ allowNetwork: false });
    const model = runtime.getModel('grok-cli', 'grok-4.7-build-fast')!;
    assert.ok(model);
    assert.equal((await runtime.getAuth(model))?.auth.apiKey, 'synthetic-access');
    let requests = 0;
    const result = await runtime.streamSimple(model, { messages: [{ role: 'user', content: 'hello', timestamp: 1 }] }, {
      sessionId: 'standalone-test', transport: 'sse',
      onPayload(payload) {
        return hooks.before_provider_request({ payload }, { model, cwd: root, sessionManager: { getSessionId: () => 'standalone-test' } });
      },
      fetch: async (_url, init) => {
        requests++;
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('authorization'), 'Bearer synthetic-access');
        assert.equal(headers.get('x-grok-model-override'), 'grok-4.7-build-fast');
        assert.equal(headers.get('x-grok-client-version'), '1.0.46');
        assert.equal(headers.get('x-grok-conv-id'), 'standalone-test');
        const payload = JSON.parse(String(init?.body));
        assert.equal(payload.model, 'grok-4.7-build-fast');
        assert.equal(payload.prompt_cache_key, 'standalone-test');
        assert.equal(payload.service_tier, undefined);
        return new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'synthetic-response', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 0 } } }) + '\n\n', { headers: { 'content-type': 'text/event-stream' } });
      },
    }).result();
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    assert.equal(requests, 1);
  } finally {
    if (env === undefined) delete process.env.GROK_CLI_OAUTH_TOKEN; else process.env.GROK_CLI_OAUTH_TOKEN = env;
    rmSync(root, { recursive: true, force: true });
  }
});

test('direct credentials and existing active vault account both work; missing auth fails closed', async () => {
  const home = mkdtempSync(join(tmpdir(), 'grok-vault-'));
  const oldHome = process.env.HOME;
  const env = process.env.GROK_CLI_OAUTH_TOKEN;
  process.env.HOME = home;
  delete process.env.GROK_CLI_OAUTH_TOKEN;
  try {
    await assert.rejects(resolveGrokRoute(), /login required/);
    assert.equal((await resolveGrokRoute('direct-token')).token, 'direct-token');
    await mutateAccountVault(vault => {
      vault.accounts[0].credential = { access: 'vault-token', refresh: 'vault-refresh', expires: Date.now() + 60000 };
      vault.activeAccountId = vault.accounts[0].id;
    });
    assert.equal((await resolveGrokRoute(ACCOUNT_VAULT_MARKER)).token, 'vault-token');
    process.env.GROK_CLI_OAUTH_TOKEN = 'environment-token';
    assert.equal((await resolveGrokRoute(ACCOUNT_VAULT_MARKER)).token, 'environment-token');
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (env === undefined) delete process.env.GROK_CLI_OAUTH_TOKEN; else process.env.GROK_CLI_OAUTH_TOKEN = env;
    rmSync(home, { recursive: true, force: true });
  }
});

test('Grok fast command switches only the matching family and reports actual state', async () => {
  const notifications: string[] = [];
  const selected: string[] = [];
  const pi = { setModel: async (model: { id: string }) => { selected.push(model.id); return true; } } as unknown as ExtensionAPI;
  const ctx = { model: { provider: 'grok-cli', id: 'grok-4.7' }, modelRegistry: { find: (_p: string, id: string) => ({ id }) }, ui: { notify: (message: string) => notifications.push(message) } };
  await handleGrokFast(pi, ctx as never, 'on');
  await handleGrokFast(pi, ctx as never, 'off');
  assert.deepEqual(selected, ['grok-4.7-build-fast', 'grok-4.7']);
  ctx.model.provider = 'openai-codex';
  await handleGrokFast(pi, ctx as never, 'on');
  assert.equal(selected.length, 2);
  await handleGrokFast(pi, ctx as never, 'status');
  assert.match(notifications.at(-1)!, /not the active provider/);
});

test('bundled OAuth supports device login, refresh, cancellation and rejects foreign token endpoints', async t => {
  const { config } = capture();
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (path.includes('openid-configuration')) return Response.json({
      authorization_endpoint: 'https://auth.x.ai/authorize', token_endpoint: 'https://auth.x.ai/token',
      device_authorization_endpoint: 'https://auth.x.ai/device',
    });
    if (path.endsWith('/device')) return Response.json({ device_code: 'synthetic-device', user_code: 'TEST', verification_uri: 'https://auth.x.ai/verify', interval: 1, expires_in: 60 });
    assert.equal(path, 'https://auth.x.ai/token');
    assert.ok(String(init?.body).includes('grant_type='));
    return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });
  });
  const callbacks = { onAuth() {}, onPrompt: async () => '', onSelect: async () => 'device', onDeviceCode() {}, signal: controller.signal };
  const credentials = await config.oauth!.login(callbacks);
  assert.equal(credentials.access, 'new-access');
  assert.equal((await config.oauth!.refreshToken(credentials, controller.signal)).refresh, 'new-refresh');
  await assert.rejects(config.oauth!.refreshToken({ ...credentials, tokenEndpoint: 'https://foreign.example/token' }, controller.signal), /non-xAI/);
  controller.abort();
  await assert.rejects(config.oauth!.login(callbacks));
});

test('Grok runtime imports stay inside package or Pi/Node, never another plugin', () => {
  const root = new URL('../grok/', import.meta.url);
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter(p => p.endsWith('.ts'));
  for (const file of files) {
    const text = readFileSync(new URL(file, root), 'utf8');
    for (const match of text.matchAll(/(?:from\s*|import\s*\()['"]([^'"]+)['"]/g)) {
      assert.ok(match[1].startsWith('.') || match[1].startsWith('node:') || match[1].startsWith('@earendil-works/pi-'), `${file}: ${match[1]}`);
    }
    assert.doesNotMatch(text, /npm\/node_modules|createJiti|\/home\/spike/);
  }
});
