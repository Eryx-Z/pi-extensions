# Contributing to pi-multi-account

Thanks for your interest in improving pi-multi-account! Issues and pull
requests are welcome. All PRs are reviewed by the maintainer before merge.

## Ground rules

- **Never include secrets.** This project only handles SHA-256 fingerprints of
  credentials — never paste tokens, API keys, or `auth.json` contents into
  issues, PRs, logs, or tests.
- Keep each PR focused on a single concern.
- Discuss large or breaking changes in an issue first.

## Development setup

```bash
git clone https://github.com/Eryx-Z/pi-extensions.git
cd pi-extensions
npm ci
```

Requirements: Node.js >= 22.19.0. Install from the repository root; the workspaces
share the root lockfile.

## Before you open a PR

```bash
npm run check                                     # All workspace type checks and tests
npm run pack:check --workspace pi-multi-account    # Verify the published file set
```

CI runs the same checks on every pull request; they must pass before review.

## Module boundaries

- `index.ts`: parent-session discovery, failover, commands and lifecycle hooks.
- `subagent-provider.ts` → `provider-slots.ts`: provider-only Codex/Antigravity RPC startup.
  Neither module may import the parent entry point, Grok, Cursor or command registration.
- `pi-ai-bridge.ts`: lazy OAuth/catalog compatibility across supported pi-ai versions.
- `auth-state.ts`: credential persistence, identity and refresh-race recovery.
- `failover-config.ts`: configuration defaults, normalization and loading.
  `normalizeConfig({})` is the only defaults source; old config files are not rewritten.
- `cooldown.ts`: header/body/usage cooldown estimates; caps and session decisions stay in the parent.
- `pi-files.ts`: published-file shape inspection, child visibility and atomic slot catalogs.
- `failover-state.ts`: versioned state migration and best-effort atomic persistence.
- `request-shaping.ts`: Anthropic OAuth payload shaping and Qwen role compatibility.
- `interrupted-turns.ts`: deterministic, bounded interrupted-turn handoff records.
- `provider-ids.ts`, `account-display.ts`, `agent-paths.ts`: shared naming, labels and paths.
- `cursor/models.ts`: catalog normalization and model configuration; shared and
  single-account Cursor entry points use the same implementation.

Codex slot provisioning delegates to the catalog registration body after its native-base
guard. Do not apply that guard to catalog sync: it must still enrich the native provider.
Keep pure handoff tests in `test/interrupted-context.test.ts`, with one entry-point alias
check and the real installed pi-ai transform integration, not a second parallel unit suite.

Existing named exports from `index.ts` and `cursor/index.ts` remain compatibility
re-exports. Boundary tests follow transitive imports, not just direct imports.
Keep new RPC dependencies in the package's publish file list.

## Coding guidelines

- Match the surrounding style. Keep provider-specific code separate from unrelated
  failover/session behavior when adding modules.
- Prefer small, well-commented guards over clever one-liners — failover logic is
  safety-critical (a bad loop can peg a machine).
- Update `CHANGELOG.md` under a new version / `Unreleased` heading describing the
  user-visible effect of your change.

## Releasing (maintainer only)

This repository has a validation workflow, not an automated publishing workflow.
Do not use the upstream repository's `publish.yml` instructions here.

Before preparing a release:

1. Finish and commit any coordinated workspace migration; do not release a dirty tree.
2. Bump `version` in **both** this package's `package.json` and `const VERSION` in
   `index.ts`, and add the `CHANGELOG.md` entry.
3. From the repository root, run `npm run check` and
   `npm run release:check --workspace pi-multi-account`.
4. Have the maintainer confirm publishing credentials and the release procedure.
   The checks above do not publish anything.
