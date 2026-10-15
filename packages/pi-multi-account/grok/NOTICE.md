# Grok protocol implementation

This directory includes MIT-licensed source from pi-grok-cli 0.9.4 by J Liew:
https://github.com/kenryu42/pi-grok-cli

The bundled upstream files are `auth/config.ts`, `auth/oauth.ts`,
`shared/errors.ts`, `models/catalog.ts`, `payload/sanitize.ts`,
`provider/stream.ts`, `provider/proxyRetry.ts`, `provider/accountVault.ts`, and
`storage.ts`. The full upstream license is in `LICENSE`.

`register.ts`, `provider/route.ts`, and `fast.ts` integrate that protocol core
into multi-account. There is no runtime dependency on the original plugin.
No Imagine tool, dashboard, account rotation, or usage UI is included.

New OAuth logins use Pi's credential store under provider `grok-cli`.
Existing vault-marker logins continue to read the selected account from
`~/.pi/grok-cli/accounts.json`, preserving compatibility without moving or
removing credentials. An explicit new `/login grok-cli` authenticates anew
and returns a normal OAuth credential to Pi. Vault data is retained.

The inherited `GROK_CLI_OAUTH_TOKEN`, `PI_GROK_CLI_BASE_URL`, OAuth configuration,
and `PI_GROK_CLI_MODELS` environment variables remain supported. They configure
this bundled implementation; no separately installed plugin is needed.
