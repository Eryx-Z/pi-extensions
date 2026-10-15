import { lazyStream, type Model, type SimpleStreamOptions } from '@earendil-works/pi-ai';
import { streamSimpleOpenAIResponses } from '@earendil-works/pi-ai/compat';
import type { ExtensionAPI, ProviderConfig } from '@earendil-works/pi-coding-agent';
import * as oauth from './auth/oauth.js';
import { resolveModels } from './models/catalog.js';
import { sanitizePayload } from './payload/sanitize.js';
import { ACCOUNT_VAULT_MARKER } from './provider/accountVault.js';
import { resolveGrokRoute } from './provider/route.js';
import { streamWithProxyRetry } from './provider/proxyRetry.js';
import { grokCliModelHeaders, grokCliVersionHeaders, resolveGrokCliVersion, refreshGrokCliVersion } from './provider/stream.js';

/** Shared parent/child provider core. No tools, model restore, account rotation or UI hooks. */
export function registerGrokProvider(pi: ExtensionAPI, child = false) {
  const generations = new Map<string, number>();
  const convId = (id: string) => generations.has(id) ? `${id}:${generations.get(id)}` : id;
  const authentication: NonNullable<ProviderConfig['oauth']> = {
    name: 'Grok (multi-account)',
    usesCallbackServer: true,
    async login(callbacks) {
      if (child) throw new Error('Log in to Grok from the parent session: /login grok-cli');
      if (process.env.GROK_CLI_OAUTH_TOKEN) throw new Error('Unset GROK_CLI_OAUTH_TOKEN before logging in to Grok.');
      // New logins use Pi's normal credential store. Existing vault markers remain supported.
      return oauth.login(callbacks);
    },
    refreshToken(credentials) {
      if (credentials.access === ACCOUNT_VAULT_MARKER && credentials.refresh === ACCOUNT_VAULT_MARKER) {
        return Promise.resolve({ ...credentials, expires: Number.MAX_SAFE_INTEGER });
      }
      return oauth.refresh(credentials);
    },
    getApiKey: credentials => credentials.access,
  };
  pi.registerProvider('grok-cli', {
    name: 'Grok (multi-account)',
    baseUrl: oauth.getBaseUrl(),
    api: 'openai-responses',
    oauth: authentication,
    ...(process.env.GROK_CLI_OAUTH_TOKEN ? { apiKey: '$GROK_CLI_OAUTH_TOKEN' } : {}),
    models: resolveModels().map(model => ({ ...model, headers: grokCliModelHeaders(model.id) })),
    streamSimple(model, context, options?: SimpleStreamOptions) {
      const sessionId = options?.sessionId;
      return lazyStream(model, async () => {
        const [route, resolvedVersion] = await Promise.all([
          resolveGrokRoute(options?.apiKey), resolveGrokCliVersion(),
        ]);
        let version = resolvedVersion;
        return streamWithProxyRetry({
          start: () => streamSimpleOpenAIResponses(
            { ...model, api: 'openai-responses', baseUrl: route.baseUrl } as Model<'openai-responses'>,
            context,
            {
              ...options,
              apiKey: route.token,
              maxRetries: 0,
              headers: {
                ...grokCliVersionHeaders(version), ...options?.headers,
                ...(sessionId ? { 'x-grok-conv-id': convId(sessionId) } : {}),
              },
            },
          ),
          rotate: sessionId ? () => { generations.set(sessionId, (generations.get(sessionId) ?? 0) + 1); } : undefined,
          refreshVersion: async () => { version = await refreshGrokCliVersion(); },
          signal: options?.signal,
          onMessage: () => {},
        });
      });
    },
  });
  pi.on('before_provider_headers', (event, ctx) => {
    if (ctx.model?.provider === 'grok-cli') event.headers['x-grok-conv-id'] = convId(ctx.sessionManager.getSessionId());
  });
  pi.on('before_provider_request', (event, ctx) => {
    if (ctx.model?.provider !== 'grok-cli' || !event.payload || typeof event.payload !== 'object') return;
    return sanitizePayload(event.payload as Record<string, unknown>, ctx.model.id, ctx.sessionManager.getSessionId(), ctx.cwd);
  });
}
