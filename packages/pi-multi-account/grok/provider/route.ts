import { getBaseUrl, refresh } from '../auth/oauth.js';
import { ACCOUNT_VAULT_MARKER, getAccountVault, mutateAccountVault } from './accountVault.js';

// Compatibility with existing pi-grok-cli vault credentials, without loading that plugin.
const refreshes = new Map<string, Promise<Awaited<ReturnType<typeof refresh>>>>();

export async function resolveGrokRoute(apiKey?: string): Promise<{ token: string; baseUrl: string }> {
  const token = process.env.GROK_CLI_OAUTH_TOKEN || apiKey;
  if (!token) throw new Error('Grok login required: /login grok-cli');
  if (token !== ACCOUNT_VAULT_MARKER) return { token, baseUrl: getBaseUrl() };

  const vault = await getAccountVault();
  const account = vault.accounts.find(a => a.id === vault.activeAccountId && a.credential)
    ?? vault.accounts.find(a => a.credential);
  if (!account?.credential) throw new Error('Grok account vault has no credentials: /login grok-cli');
  const credential = account.credential;
  if (Date.now() < credential.expires) {
    return { token: credential.access, baseUrl: credential.baseUrl ?? getBaseUrl() };
  }
  const key = `${account.id}:${account.revision}`;
  let pending = refreshes.get(key);
  if (!pending) {
    pending = refresh({ ...credential });
    refreshes.set(key, pending);
  }
  try {
    const refreshed = await pending;
    const stored = await mutateAccountVault(latest => {
      const current = latest.accounts.find(a => a.id === account.id);
      if (!current?.credential || current.revision !== account.revision) return false;
      current.credential = { ...refreshed };
      current.revision += 1;
      return true;
    });
    if (!stored) return resolveGrokRoute(apiKey);
    return { token: refreshed.access, baseUrl: typeof refreshed.baseUrl === 'string' ? refreshed.baseUrl : getBaseUrl() };
  } finally {
    if (refreshes.get(key) === pending) refreshes.delete(key);
  }
}
