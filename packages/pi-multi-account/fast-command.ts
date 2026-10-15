import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { isCodexFastModel, readCodexFastEnabled, writeCodexFastEnabled } from './codex-fast.ts';
import { handleGrokFast } from './grok/fast.ts';

type FastAction = 'on' | 'off' | 'status';

function currentFast(ctx: ExtensionCommandContext): { kind: 'codex' | 'grok' | 'unsupported'; on: boolean; detail: string } {
  if (isCodexFastModel(ctx.model)) {
    const on = readCodexFastEnabled();
    return { kind: 'codex', on, detail: `ChatGPT/Codex priority ${on ? 'ON' : 'OFF'}` };
  }
  if (ctx.model?.provider === 'grok-cli' && ['grok-4.7', 'grok-4.7-build-fast'].includes(ctx.model.id)) {
    const on = ctx.model.id === 'grok-4.7-build-fast';
    return { kind: 'grok', on, detail: `Grok 4.7 ${on ? 'fast' : 'standard'} (${ctx.model.id})` };
  }
  return { kind: 'unsupported', on: false, detail: '' };
}

async function askAction(ctx: ExtensionCommandContext, state: { on: boolean; detail: string }): Promise<FastAction | undefined> {
  if (!ctx.hasUI) return 'status';
  const choice = await ctx.ui.select(`${state.detail}. 选择：`, state.on ? ['关闭', '保持开启'] : ['开启', '保持关闭']);
  if (!choice || choice.startsWith('保持')) return undefined;
  return choice === '开启' ? 'on' : 'off';
}

export async function handleFastCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext) {
  const requested = args.trim().toLowerCase();
  if (requested && !['on', 'off', 'status'].includes(requested)) {
    ctx.ui.notify('用法：/fast，或 /fast on|off|status', 'warning');
    return;
  }
  const state = currentFast(ctx);
  if (state.kind === 'unsupported') {
    ctx.ui.notify('/fast 只支持当前的 ChatGPT/Codex 或 Grok 4.7。请先选择支持的模型。', 'warning');
    return;
  }
  const action = (requested || await askAction(ctx, state)) as FastAction | undefined;
  if (!action || action === 'status' || (action === 'on') === state.on) {
    ctx.ui.notify(`${state.detail}。未更改。`, 'info');
    return;
  }
  if (state.kind === 'grok' && action === 'on') {
    const ok = ctx.hasUI ? await ctx.ui.confirm('开启 Grok Fast？', 'grok-4.7-build-fast 费用更高。') : true;
    if (!ok) {
      ctx.ui.notify('未更改。', 'info');
      return;
    }
  }
  if (state.kind === 'codex') {
    try {
      writeCodexFastEnabled(action === 'on');
      ctx.ui.notify(`ChatGPT/Codex fast ${action === 'on' ? '已开启（priority）' : '已关闭'}`, 'info');
    } catch (error) {
      ctx.ui.notify(`无法保存：${error instanceof Error ? error.message : String(error)}`, 'warning');
    }
    return;
  }
  await handleGrokFast(pi, ctx, action);
}

export function registerFastCommand(pi: ExtensionAPI) {
  pi.registerCommand('fast', {
    description: '开启或关闭当前 ChatGPT/Codex、Grok 4.7 的 fast',
    handler: (args, ctx) => handleFastCommand(pi, args, ctx),
  });
}
