# pi-multi-account

Automatic multi-account failover & rotation for [Pi Agent](https://pi.dev/), across **Anthropic (Claude)**, **OpenAI / ChatGPT Codex**, **Google Antigravity**, **Kimi For Coding**, **Cursor**, **Qwen / Alibaba**, and **Ollama**.

When the account you are using hits a quota or rate limit, `pi-multi-account` transparently switches to the next authenticated account/model and (optionally) resumes the interrupted task — so a long agent run does not die just because one account ran out of budget.

## RPC subagent model inheritance

For `pi-agent-mesh` and compatible `pi-interactive-subagents` versions, this extension answers the synchronous `rpc-subagents:provider-source:v1` discovery event for `antigravity`, `antigravity-account-N`, `openai-codex` and `openai-codex-account-N`. It advertises `subagent-provider.ts`, a provider-only child entrypoint that registers only the account selected in the frozen loadout. It installs no tools, UI hooks, model restoration or automatic failover. Read-only child tool restrictions remain unchanged; provider code is trusted code, not a filesystem sandbox. Both updated extensions must be loaded in the parent. Codex children use the selected provider's stored OAuth. Custom `models.json` proxy routes remain intact; this plugin's exact published loopback slot route is instead accessed directly upstream using that slot's OAuth, retaining its published model metadata and avoiding dependence on the parent proxy's lifetime. Other provider families are unchanged.

### Standalone ChatGPT/Codex and Grok fast modes

Use `/fast` to see the current state and choose 开启 or 关闭. `/fast on`, `/fast off`, and `/fast status` skip the menu. Supports the current ChatGPT/Codex model (including account slots) and Grok 4.7; other models are left unchanged. Turning Grok fast on asks for confirmation because it costs more. Headless mode reports status instead of changing it. The longer commands below remain compatible.

Neither `pi-grok-cli` nor `@gowthamgts/pi-codex-fast-mode` is required. Disable those separate extensions if installed, to avoid duplicate provider registration or conflicting request hooks. Pi itself and this package's normal dependencies are still required.

- **ChatGPT/Codex:** sign in through Pi's `/login` (OpenAI Codex), then run `/multi-account fast codex on|off|status`. The shorter `/multi-account fast on|off|status` remains a Codex-only alias. Enabled requests use `service_tier: "priority"` on `openai-codex` and numbered account slots, including RPC children. The preference defaults to on and remains compatible with `codex-fast-mode.json` under the Pi agent directory.
- **Grok:** `/login grok-cli`, then select `grok-cli/grok-4.7-build-fast` in `/model`. While using Grok 4.7, `/multi-account fast grok on|off|status` switches between `grok-4.7-build-fast` and `grok-4.7`. This is a model change, not a Codex service tier or global preference. Fast mode has higher usage cost. Other model families are not silently replaced.

The bundled `grok/` implementation owns OAuth, token refresh, the model catalog, request sanitization, and streaming. Both the parent and provider-only RPC children use it. Existing Grok vault-marker logins and `GROK_CLI_OAUTH_TOKEN` remain supported; fresh logins use Pi's normal credential store. No existing credentials are moved or deleted. This integration does not add Grok account rotation, Imagine, or usage commands. See `grok/NOTICE.md` and `grok/LICENSE` for provenance.

## What it does

- **Auto-discovers** every authenticated account from `~/.pi/agent/auth.json` (Anthropic Claude Pro/Max, OpenAI/ChatGPT Codex, Google Antigravity, Kimi For Coding, Cursor, Qwen/Alibaba, and Ollama) and builds the failover rotation dynamically — no manual config editing.
- **Grows the rotation on login.** Run `/login`, choose **Use a subscription** for a subscription provider or select an `antigravity-account-N` slot for Google login. The next discovery sweep adds it to the rotation automatically.
- **Auto-discovers new Codex models per account.** At session start (and on `reload` / `rediscover`) it reads OpenAI's authenticated model catalog, mirrors each account's actually available models onto its Pi alias, and follows OpenAI's server priority. A new flagship can therefore win immediately without an extension release or a hard-coded model id.
- **Handles auth failures without poisoning healthy OAuth accounts.** A generic final 401 briefly cools down a refreshable account and moves the current task forward. Explicit provider verdicts such as `authentication token has been invalidated` force an early refresh; if the refresh token is dead too, the slot is removed and Pi prints the interactive `/login` recovery steps.
- **Fails over on quota / rate-limit** (429 / 402 / 403 and friends): the exhausted account goes on cooldown (parsed from the provider's own reset metadata when available) and Pi first tries another account of the same family that still has the exact model and thinking level. A 100% usage forecast is not a skip: that sibling is asked unless it already refused this session. Another family is used only when no sibling can take the model.
- **Optional auto-continue**: queues a safe continuation prompt after a switch so the agent keeps going from the last safe point.
- **Session-bound overnight resume**: if every account is cooling down, the live Pi session waits for the earliest recovery and continues automatically. A new user message, `/multi-account stop`, session exit, or Esc during a running turn cancels the chain.
- **Deduplicates provably identical accounts** so duplicate Codex workspace/member identities and identical credentials do not consume multiple rotation slots or get separate cooldowns. Different members of one ChatGPT Team workspace remain separate rotation accounts. New provable duplicate logins are rejected before the redundant slot is saved.
- **Keeps YOUR reasoning level across switches.** Whatever the session runs at — your Pi default, `/thinking`, or a per-agent `--thinking low` — is preserved and restored after every account/model switch, so it never drifts downward when a weaker fallback model clamps it. The extension does not override your level (set `reasoningLevel` if you *want* a forced one), and extreme levels such as `xhigh` / Max / Ultra are never forced.
- **Shows live limits for the active account** in Pi's footer: remaining 5-hour and 7-day allowance plus reset countdowns for Codex and Anthropic OAuth accounts.

## Install

```bash
pi install npm:pi-multi-account
```

Restart Pi or run `/reload` after installation.

Requires Node 22.19+ and `@earendil-works/pi-ai` 0.78 or newer — it is installed automatically as a
dependency. Both the pre-0.80 OAuth API and the 0.80+ provider-factory API are supported, so the
extension keeps working across pi-ai upgrades. If a pi-ai it cannot adapt is ever encountered, the
extension still loads and API-key accounts keep rotating; only subscription login is unavailable,
and it says so at session start.

> **Anthropic (Claude Pro/Max) and Google Antigravity work out of the box.**
> Antigravity's base `antigravity` provider and every `antigravity-account-*` alias
> use Google OAuth and the native Cloud Code Assist stream. Do not also load the
> standalone `pi-antigravity` extension, as both packages register the base provider.
> This integration deliberately excludes Antigravity image generation commands/tools.

### Recommended setting

Set Pi provider-level retries to zero so the SDK does not keep retrying an exhausted account before failover kicks in. In `~/.pi/agent/settings.json`:

```json
{ "retry": { "provider": { "maxRetries": 0 } } }
```

## Usage

Add accounts by opening the login picker:

```text
/login
Use a subscription
ChatGPT Plus/Pro (Codex openai-codex-account-2)
# Or choose Antigravity (antigravity-account-2) and complete Google sign-in
/multi-account rediscover
```

Pi 0.79.3 does not accept a provider argument after `/login`; select the account
slot from the interactive provider picker instead.

Check what's in the rotation at any time:

```text
/multi-account status
```

Force-refresh and display detailed limits for the active account:

```text
/multi-account limits refresh
```

Example status output:

```text
pi-multi-account v1.20.0  ● 已启用  自动发现 ON
账号     owner@example.com: Team
模型     gpt-5.6-sol
轮换     owner@example.com: Team  →  member@example.com: Team
全部额度
  ● owner@example.com: Team  当前
    可用  │  5h 剩余 86% · 4h 后重置  │  7d 剩余 83% · 6d13h 后重置
  ● member@example.com: Team
    可用  │  5h 剩余 42% · 2h12m 后重置  │  7d 剩余 71% · 5d8h 后重置
恢复     全部账号当前可用
子进程   2/2 可用
操作     best  ·  next  ·  limits
完整诊断  /status full
```

The interactive view uses the active Pi theme for status, quota, warning, and muted text colors. Internal slot ids stay in `status full`; the compact view identifies accounts as `email: subscription` whenever quota metadata provides them.

### Commands

Use `/status` for the account overview (`/status full` for complete diagnostics). The management command keeps its three aliases: `/multi-account`, `/provider-failover`, `/failover`.

| Subcommand | Description |
|---|---|
| `status` (default) | Show a compact overview of the current model, limits, rotation, recovery, and actionable warnings. It refreshes every authenticated rotation account whose cache has expired (Codex: five minutes by default; Anthropic: at least ten minutes), even when the footer is disabled; repeated commands within that TTL use the cache. This is also available directly as `/status`; use `/status full` (aliases: `verbose`, `details`) for every diagnostic and registered login slot. |
| `limits [refresh]` | Show active-account limits; `refresh` bypasses the cache. Codex and Claude use their 5h/7d windows. xAI OAuth uses the Grok CLI billing period and subscription name, and only shows a percent when that endpoint publishes one. This explicit query works even when `showUsage` is false. Aliases: `usage`, `quota`. |
| `rediscover` | Force a re-scan of `auth.json`, rebuild the rotation, and refresh Codex model catalogs now. |
| `add [anthropic\|codex\|kimi\|antigravity\|cursor\|ollama\|qwen]` | Print the next free account slot to select from the interactive `/login` picker. Anthropic, Codex, Kimi, Cursor, and Antigravity are logged in through `/login`; API-key families are filled in `auth.json`. |
| `remove [anthropic\|codex\|kimi\|antigravity\|cursor\|ollama\|qwen\|<provider-id>]` | Remove an account from `auth.json` and rotation. Family name drops the highest numbered alias slot; a full provider id removes that exact slot. Aliases: `rm`, `delete`. |
| `next` | Manually switch to the next fallback, deliberately overriding recorded cooldowns. |
| `only-active [on\|off]` | Narrow `/model` to the active rotation account: every other provider's models are hidden (its auth is preserved) and restored on switch or `off`. Alias: `focus`. |
| `stop` | Abort and cancel automatic failover/resume for the current task. |
| `reset` | Clear all cooldowns, invalidations and any pending auto-resume. |
| `reload` | Reload config from disk and re-discover accounts. |
| `enable` / `disable` | Turn failover on/off for the current Pi process. |

## How rotation membership works

- **Joins the rotation** when an account has a present, non-expired credential in `auth.json` (after `/login`).
- **Leaves the rotation** when the credential is logged out / removed, its access token is expired with no refresh token, an API key is rejected, or a refreshable OAuth credential produces three distinct final auth failures without a success in between.
- **Quota / rate-limit** does not invalidate an account — it puts it on a temporary cooldown and the account returns once the cooldown expires.
- **Duplicate identities** share one rotation position and one cooldown, and status/startup identifies the redundant slot. Codex/ChatGPT JWTs are matched by workspace plus user identity; Antigravity uses the Google email returned at login; identical API keys or literal identical tokens are also matched. Separate Anthropic OAuth logins cannot be proven identical because Anthropic's stored credential exposes no stable account identifier.

Rotation refresh is triggered by changes to `auth.json` (detected on session/turn start) or on demand with `/multi-account rediscover`.

After re-authenticating an invalidated slot, restart any older Pi processes that
were already running. Pi keeps a still-unexpired access token in each process's
memory, so an old process can continue using the invalidated token even after a
new `/login` updates `auth.json`.

## Configuration

A default config is created at `~/.pi/agent/provider-failover.json` on first run. New files use the same normalized defaults as runtime (including `onlyActive: false`); existing files are not rewritten when loaded. The obsolete `probeCooldownMs`, `invalidCooldownMs`, `openaiCodexAliases` and `anthropicOAuthAliases` options are ignored and no longer generated. Useful keys:

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | Master switch. |
| `autoContinue` | `true` | Queue a continuation prompt after a switch. |
| `autoDiscover` | `true` | Auto-discover accounts from `auth.json`. |
| `autoDiscoverModels` | `true` | Fetch OpenAI's authenticated model catalog for every Codex account and register new models on that account's alias automatically. |
| `includeQwen` | `true` | Include Qwen / Alibaba accounts. |
| `includeOllama` | `true` | Include Ollama (local) accounts. |
| `neverFailoverProviders` | `[]` | Provider ids to never fail away from, e.g. `["my-provider"]`. For **unmanaged** providers that run their own retry logic (typically a companion extension owning retries for that provider) — switching accounts underneath it would fight those retries. Managed accounts still cool and rotate normally. |
| `includeCursor` | `true` | Include Cursor subscription accounts. The Cursor provider is a separate, optional repo — until it is cloned this setting does nothing at all: no cursor login slot is offered and no warning is printed. Run `/multi-account add cursor` to get the install instructions. |
| `childProxy` | `true` | Serve OAuth rotation slots to processes that do not load this extension (a memory extension consolidating its notes, an external CLI, any `pi -p --no-extensions` call) through a loopback route this process owns. Without it such a child resolves the active slot by name, fails at authentication, and silently reroutes to whichever provider Pi finds first — a different account, usually a different vendor. The published route carries a non-secret placeholder; the real credential never leaves the parent. |
| `providerOrder` | `["anthropic","openai-codex","kimi-coding","antigravity","cursor","qwen","ollama"]` | Preferred family order in the rotation. |
| `cooldownMs` | 6 h | Default cooldown when no reset metadata is provided. |
| `showUsage` | `true` | Show active Codex/Claude limits in Pi's footer and poll them automatically. When false, the footer and background quota polling are disabled, but explicit `status`/`limits` commands can still refresh quota. |
| `usageRefreshMs` | 5 min | Per-account usage cache TTL; every authenticated rotation account is refreshed independently, and Anthropic is clamped to at least 10 min to avoid endpoint throttling. |
| `usageStatusRefreshMs` | 1 min | Re-render the footer and sweep idle sessions for stale usage/model catalogs; network refreshes remain limited by their five-minute (Anthropic: ten-minute) TTLs. |
| `maxAutoContinuesPerPrompt` | `8` | Cap on auto-resume hops per task. |
| `continuationPrompt` | (built-in) | Template; supports `{from}`, `{to}`, `{reason}`. |
| `maxRecheckIntervalMs` | `600000` (10 min) | Ceiling on how long any *prediction* may stop an account from being tried again — a recorded cooldown, a usage window, a provider's reset timestamp. Providers refresh quota windows early and unannounced and resize the windows themselves, so those numbers order the rotation but never veto a retry. A refused request costs no tokens; only the account's own answer proves availability. Raise it to probe less often, never to "trust" a provider's estimate. |
| `preserveInterruptedContext` | `true` | Rewrite the turn that triggered the failover into a verbatim `[handoff:interrupted-turn]` record so the account taking over still sees the reasoning, output and tool calls of the turn pi-ai would otherwise drop as unreplayable — including which calls never returned. Deterministic (never moves the prompt-cache breakpoint) and hard-capped. Set to `false` for the previous drop-everything behaviour. |
| `providerPriority` | managed families, per-token providers last | Where work goes once **every** account of the current provider is spent. An ordered list of provider groups — a managed family, or the base id of anything else you are logged in to (`openrouter`, `zai`, `minimax`…), which `providerOrder` could never name. Three bounds: same-provider failover always runs first and is untouched (588 of 602 automatic failovers in a real black box stayed inside the family — that step already worked); an account on a real cooldown is never chosen over a free one; and a group nobody ranked sorts after every group somebody did. Inside those bounds it settles the hop that used to be arbitrary — the other 14 of those 602 scattered across five destinations with no policy behind them. It sits below the per-account liveness signals on purpose: evidence about one account beats a preference about its category. Set with `/multi-account priority ...`. |
| `resumeIdleTimeoutMs` | 90 s | Max time to wait for the previous turn to go idle before a resume gives up and retries later (never an unbounded loop). |
| `stuckWatchdogMs` | 180 s | A resumed turn silent for this long (with no tool running) is treated as wedged. |
| `autoRecoverStuck` | `true` | When a resume wedges, auto-cancel it and auto-resume when an account frees, instead of only notifying. Set `false` for notify-only. |
| `debugLog` | `true` | Write a structured "black box" decision log to `provider-failover-debug.log` (no credentials — only provider/model ids and truncated reasons). View with `/multi-account log`. |
| `preferLatestModel` | `true` | Rank the strongest/current model ahead of older siblings during automatic failover. |
| `reasoningLevel` | `"auto"` | `"auto"` follows the level the session actually runs at (your Pi default, `/thinking`, per-agent `--thinking`) and only restores it after switches. Set an explicit level (`"off"`…`"xhigh"`) to **force** it on every turn regardless of the session — `"xhigh"` only if you really want the extreme level. |
| `preferredModels` | `{}` | Optional manual strongest-first override per family; when present it wins over live catalog priority. |

Compaction and request-only context trimming are owned by Pi or a dedicated extension such as [`model-aware-autocompact`](../model-aware-autocompact). This plugin does not trim old tool results, generate, route, repair or cancel summaries, or enqueue post-compaction continuation. Legacy `contextGuard`, `continueAfterCompaction`, `routeCompactionToHealthyAccount` and `compactionWatchdogMs` settings are ignored here. Autocompact reads the old `contextGuard` value only as a fallback when its own setting is absent. External compaction still resets Cursor checkpoints so requests rebuild from the new history. The separate failover handoff controlled by `preserveInterruptedContext` remains unchanged.

State (cooldowns, invalidations, recent switches, credential-free Codex model catalogs, and an in-session pending resume marker) is persisted to `~/.pi/agent/provider-failover-state.json`. Pending work is deliberately discarded when the session closes or a different session starts.

## Staying unstuck (resilience)

A failover is only useful if the agent actually keeps working afterward. These guarantees keep a switch from silently freezing the session:

- **Resumes only happen when there is something to resume.** The extension continues a turn only when it actually ended in an error it can pick up from — it never tries to "continue" a finished reply (the cause of the cryptic `Cannot continue from message role: assistant` error).
- **A forward-progress watchdog that acts.** If a resumed turn goes completely silent (no streaming, no tool activity, no provider response) and no tool is running, the extension auto-cancels the wedged turn and resumes the work itself when an account frees up — you do not have to press Esc or re-type the prompt. A long, silent build/test command is never mistaken for a wedge.
- **A circuit breaker as the floor.** If automatic recovery keeps failing, the extension drops to *advisory mode*: it still flags limits and switches you to a fresh account, but stops the auto-continue that was failing, so a bad state can never spiral into repeated hangs. It re-enables itself on the next success, a new prompt, or `/multi-account reset`.
- **A black box for diagnosis.** Every decision (switch, error and how it was classified, watchdog action, breaker trip) is appended to `~/.pi/agent/provider-failover-debug.log`. If anything misbehaves, run `/multi-account log` — the exact sequence is there, so a bug can be reproduced and fixed instead of guessed at. The file is bounded in size, contains no credentials, and is safe to share.

## Privacy & security

`pi-multi-account` **reads** `auth.json` but never writes credentials itself and never stores credentials in its state. Account/token values are reduced to a short irreversible SHA-256 fingerprint for re-login detection and deduplication. OAuth access tokens are sent only to their own provider: the usage endpoint (`chatgpt.com/backend-api/wham/usage` or `api.anthropic.com/api/oauth/usage`) and, for Codex, OpenAI's authenticated `chatgpt.com/backend-api/codex/models` catalog. Cached state contains percentages, reset times, plan/credit metadata, model metadata, and the fingerprint, never the token. Config, state, and the debug log are written with `0600` permissions. The debug log records only provider/model ids, decisions, and truncated reasons — token-shaped material is redacted defensively — so it is safe to share when reporting an issue. Disable it with `"debugLog": false` or `/multi-account log off`.

## License

[MIT](./LICENSE)
