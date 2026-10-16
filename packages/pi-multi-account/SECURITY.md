# Security Policy

## Reporting a vulnerability

Please report security issues privately via GitHub's
[security advisories](https://github.com/Eryx-Z/pi-extensions/security/advisories/new)
rather than opening a public issue.

## Handling of credentials

pi-multi-account reads authenticated accounts from `~/.pi/agent/auth.json`.
Credentials are used for provider authentication; they must not be included in
config/state diagnostics or vulnerability reports:

- Config/state account-change detection and deduplication use SHA-256
  fingerprints (first 12 hex chars), not raw tokens/keys.
- Its config and state files are written with `0600` permissions.

When reporting an issue, never include tokens, API keys, or the contents of
`auth.json`.
