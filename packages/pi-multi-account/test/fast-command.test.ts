import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleFastCommand, registerFastCommand } from '../fast-command.ts';
import { readCodexFastEnabled, writeCodexFastEnabled } from '../codex-fast.ts';
import { readXaiFastEnabled, writeXaiFastEnabled } from '../xai-fast.ts';

function ctxFor(model: { provider: string; id?: string; api?: string }, ui: Record<string, unknown> = {}) {
  const messages: string[] = [];
  return {
    messages,
    ctx: {
      hasUI: true,
      model,
      ui: {
        notify: (s: string) => messages.push(s),
        select: async () => undefined,
        confirm: async () => true,
        ...ui,
      },
    },
  };
}

test('/fast asks before changing and explicit commands still work', async () => {
  const old = process.env.PI_CODING_AGENT_DIR;
  const root = mkdtempSync(join(tmpdir(), 'fast-command-'));
  process.env.PI_CODING_AGENT_DIR = root;
  writeCodexFastEnabled(true);
  try {
    const idle = ctxFor({ provider: 'openai-codex-account-4', api: 'openai-codex-responses' });
    await handleFastCommand({} as never, '', idle.ctx as never);
    assert.equal(readCodexFastEnabled(), true);
    assert.match(idle.messages.at(-1)!, /未更改/);

    const enable = ctxFor({ provider: 'openai-codex', api: 'openai-codex-responses' }, { select: async () => '开启' });
    writeCodexFastEnabled(false);
    await handleFastCommand({} as never, '', enable.ctx as never);
    assert.equal(readCodexFastEnabled(), true);

    const headless = ctxFor({ provider: 'openai-codex', api: 'openai-codex-responses' });
    headless.ctx.hasUI = false;
    await handleFastCommand({} as never, '', headless.ctx as never);
    assert.equal(readCodexFastEnabled(), true);
    assert.match(headless.messages.at(-1)!, /ON/);
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
    rmSync(root, { recursive: true, force: true });
  }
});

test('/fast confirms costly Grok switch and leaves other models unchanged', async () => {
  const picked: string[] = [];
  const grok = ctxFor({ provider: 'grok-cli', id: 'grok-4.7' }, { select: async () => '开启', confirm: async () => false });
  (grok.ctx as { modelRegistry?: unknown }).modelRegistry = { find: (_p: string, id: string) => ({ id }) };
  const pi = { setModel: async (m: { id: string }) => { picked.push(m.id); return true; } };
  await handleFastCommand(pi as never, '', grok.ctx as never);
  assert.deepEqual(picked, []);
  grok.ctx.ui.confirm = async () => true;
  await handleFastCommand(pi as never, 'on', grok.ctx as never);
  assert.deepEqual(picked, ['grok-4.7-build-fast']);

  const other = ctxFor({ provider: 'anthropic', id: 'claude' });
  await handleFastCommand({} as never, 'off', other.ctx as never);
  assert.match(other.messages.at(-1)!, /支持的模型/);
  registerFastCommand({ registerCommand(name: string) { assert.equal(name, 'fast'); } } as never);
});

test('/fast toggles xAI priority without changing the model id', async () => {
  const old = process.env.PI_CODING_AGENT_DIR;
  const root = mkdtempSync(join(tmpdir(), 'fast-xai-'));
  process.env.PI_CODING_AGENT_DIR = root;
  writeXaiFastEnabled(false);
  try {
    const declined = ctxFor({ provider: 'xai', id: 'grok-4.7', api: 'openai-responses' }, { confirm: async () => false });
    await handleFastCommand({} as never, 'on', declined.ctx as never);
    assert.equal(readXaiFastEnabled(), false);
    assert.match(declined.messages.at(-1)!, /未更改/);

    const enabled = ctxFor({ provider: 'xai', id: 'grok-4.7', api: 'openai-responses' }, { confirm: async () => true });
    await handleFastCommand({} as never, 'on', enabled.ctx as never);
    assert.equal(readXaiFastEnabled(), true);
    assert.match(enabled.messages.at(-1)!, /xAI fast 已开启/);

    const slot = ctxFor({ provider: 'xai-account-2', id: 'grok-4.7', api: 'openai-responses' });
    await handleFastCommand({} as never, 'off', slot.ctx as never);
    assert.equal(readXaiFastEnabled(), false);
    assert.equal(readCodexFastEnabled(), true);
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
    rmSync(root, { recursive: true, force: true });
  }
});
