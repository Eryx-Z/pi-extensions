# 🧩 Pi Extensions Monorepo

> A curated monorepo of productivity extensions and tools for the [Pi Coding Agent](https://pi.dev/).

---

## 📦 Packages

| Package | Version | Description |
| :--- | :---: | :--- |
| [`pi-skill-manager`](./packages/pi-skill-manager) | `1.0.0` | Batch-manage automatic Skill invocation (`disable-model-invocation`), interactive TUI, `$` search & custom groups |
| [`pi-status-hub`](./packages/pi-status-hub) | `0.1.0` | Unified status line orchestrator for Pi, eliminating footer collisions, with adaptive 3-stage folding & `/shub` UI |
| [`model-aware-autocompact`](./packages/model-aware-autocompact) | `1.0.0` | Automatic compaction with per-model thresholds and cached summaries of old tool output |
| [`pi-multi-account`](./packages/pi-multi-account) | `1.20.0` | Automatic multi-account failover & rotation across Claude, Codex, Antigravity, Kimi, Cursor, Qwen, Ollama |
| [`pi-token-usage`](./packages/pi-token-usage) | `0.1.0` | Local session token usage and cost visualization panel (`/usage`) |
| [`pi-open-terminal`](./packages/pi-open-terminal) | `1.0.0` | Quick Kitty terminal launcher in current working directory via `/d` |

---

## 🚀 Installation

### 1. Install Full Suite (All Extensions)

Install directly from GitHub via Pi CLI:

```bash
pi install git:github.com/Eryx-Z/pi-extensions
```

Restart Pi or run `/reload` in an active session.

### 2. Selective Loading via Settings Filter

If you only want specific extensions from this repository, configure `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/Eryx-Z/pi-extensions",
      "extensions": [
        "packages/pi-status-hub/src/index.ts",
        "packages/pi-skill-manager/index.ts",
        "packages/pi-multi-account/index.ts"
      ]
    }
  ]
}
```

### 3. Local Development & Monorepo Linking

Clone this repository and point Pi to your local checkout in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "/path/to/pi-extensions"
  ]
}
```

---

## 🛠️ Development

This project uses npm workspaces with Node 22.19+ and one root `package-lock.json`.
Run dependency installation from the repository root, not from individual packages.
All six workspaces must provide `test` and `typecheck` scripts; missing scripts fail
the root checks rather than being silently skipped. Tests use Node's test runner
with `tsx` to load TypeScript; all workspaces use the same TypeScript version range.
The GitHub Actions workflow runs these checks on Node 22 and 24, plus the
`pi-multi-account` package-content check.

```bash
# Reproduce the locked dependencies across all workspaces
npm ci

# Run build across all workspaces
npm run build

# Run type checks
npm run typecheck

# Run test suites
npm run test

# Run both required gates
npm run check
```

---

## 💖 Acknowledgments

- **`pi-multi-account`**: Enhanced and customized with Google Antigravity failover & quota rotation, based on foundational work by [@Sarrius](https://github.com/Sarrius/pi-multi-account).

---

## 📄 License

MIT © Eryx-Z
