import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';

export async function handleGrokFast(pi: ExtensionAPI, ctx: ExtensionCommandContext, action = 'status') {
  if (!['on', 'off', 'status'].includes(action)) {
    ctx.ui.notify('Usage: /multi-account fast grok on|off|status', 'warning');
    return;
  }
  if (action === 'status') {
    ctx.ui.notify(ctx.model?.provider === 'grok-cli'
      ? `Grok fast ${ctx.model.id.endsWith('-fast') ? 'ON' : 'OFF'}: ${ctx.model.id}`
      : 'Grok is not the active provider. Select a grok-cli model first.', 'info');
    return;
  }
  // Do not silently replace a different model family or provider.
  if (ctx.model?.provider !== 'grok-cli' || !['grok-4.7', 'grok-4.7-build-fast'].includes(ctx.model.id)) {
    ctx.ui.notify('Select grok-cli/grok-4.7 or grok-cli/grok-4.7-build-fast first.', 'warning');
    return;
  }
  const id = action === 'on' ? 'grok-4.7-build-fast' : 'grok-4.7';
  const model = ctx.modelRegistry.find('grok-cli', id);
  if (!model || !(await pi.setModel(model))) {
    ctx.ui.notify('Grok model unavailable. Run /login grok-cli and check PI_GROK_CLI_MODELS.', 'warning');
    return;
  }
  ctx.ui.notify(`Grok fast ${action.toUpperCase()}: ${id}${action === 'on' ? ' (higher usage cost)' : ''}`, 'info');
}
