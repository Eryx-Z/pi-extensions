# model-aware-autocompact

Model-aware percentage compaction plus request-only summaries of old tool output for Pi. Load this package as a Pi extension; no account/failover extension is required.

## Compaction

The default threshold is **80%** of the model's declared context window. Per-model overrides and existing percentage settings are unchanged:

```text
/autocompact-percent                 # status (also: status)
/autocompact-percent 70              # save default percentage
/autocompact-percent -c 60           # save current model override (also: current)
/autocompact-percent provider/model 60
/autocompact-percent list
/autocompact-percent reset -c        # remove current model override
/autocompact-percent reset provider/model
```

Percentages must be greater than 0 and less than 100. Compaction checks run after `agent_settled`, on non-restore model selection, and after relevant percentage changes, **only while idle**, with no queued work or active compaction. No compaction is initiated by the pre-request or message hooks. Local and external compactions are tracked to prevent overlap.

## Request-only trimming

During long agent runs, the guard estimates each outgoing request (including the system prompt and a conservative learned overhead). Above its soft limit, it uses `compressModel` (or the current model when unset) to summarize the oldest sufficiently large text-only tool results and bash execution output. It preserves message/protocol fields, assistant tool calls, a recent verbatim tail, and original tool results needed for interrupted-turn failover handoffs, regardless of extension load order. Image/mixed-content and oversized inputs that cannot be safely summarized remain unchanged.

Summaries describe outcomes, errors, key paths, identifiers and side effects. They are explicitly marked as lossy, not as original output. Cached summaries are matched against source identity and content and reused across requests; changed source content invalidates a cached summary. There is no placeholder-only fallback: failed, invalid, empty or non-shortening summaries leave the original output intact and show a warning. Failed attempts are suppressed until the next agent run.

**The transcript is never modified.** Re-read or re-run an output if needed. Per-output summaries are not whole-conversation compaction and cannot guarantee that every request fits (for example, protected recent output alone may exceed the window). It never triggers mid-run compaction or adds another compaction threshold. When summaries lower provider-reported usage, a current-model untrimmed request estimate plus messages appended since that request (including the final assistant response and tool output) keeps the configured percentage compaction policy effective at the safe boundary. Elisions and request estimates reset after compaction, session start/switch, or tree navigation; unknown usage immediately after compaction does not trigger another compact.

The guard learns overhead only from plausible, untrimmed responses. After five responses it warns once per session if the pre-request hook is missing or the model's context window is unknown. Unknown windows disable trimming; models can declare `contextWindow` in `models.json`.

## Configuration and migration

Settings live in Pi's agent directory (`getAgentDir()`, normally `~/.pi/agent`), in `model-aware-autocompact.json`:

```json
{
  "percent": 80,
  "models": { "provider/model": 70 },
  "contextGuard": {
    "enabled": true,
    "softPercent": 0.75,
    "targetPercent": 0.6,
    "keepVerbatimTokens": 40000,
    "minElideTokens": 500,
    "maxWindowTokens": 400000
  }
}
```

To select a separate model **only for tool-output summaries**, add a top-level field:

```json
{ "compressModel": "provider/model" }
```

Use the exact registered provider/model identifier from Pi, including an account alias if needed. Model IDs may contain `/`; the first `/` separates the provider. Omit the field to use the current conversation model. An empty, malformed, unknown or unauthenticated selection keeps the original output and warns; there is no fallback to another model. Pi resolves that model's existing credentials. The main conversation model and whole-session compact are unchanged. Restart Pi or use `/reload` after editing this file.

**Privacy:** old tool output is sent to the configured model's provider. Its context window and output limit bound summary requests independently of the main model.

The example shows all guard defaults. `contextGuard: true` uses defaults; `false` disables trimming without disabling percentage compaction. An object overrides individual settings. Guard percentages are **fractions**, unlike `percent`; invalid numeric values fall back to defaults. The target is normalized below the soft limit using the former guard's normalization. `maxWindowTokens: 0` trusts the advertised window; its default 400,000-token cap affects trimming only, not the percentage compaction threshold.

If the new config has **no `contextGuard` property**, only `provider-failover.json.contextGuard` is read as a legacy fallback. An explicit new value, including `false`, always wins. A valid inherited boolean/object is durably adopted into the new config at session start. Adoption rereads the destination, preserves existing percentage settings and unknown fields, and respects a newly explicit guard value. Malformed or unreadable destination files are left unchanged; save failures warn once without failing startup. Percentage commands also save the resolved guard setting. The legacy file is never rewritten, and its account/failover/global `enabled` settings are not consulted. This is configuration adoption only: no transcript/session/data migration occurs.

**Update both extensions together.** A separately installed older `pi-multi-account` may still trim requests. To avoid two active trimmers while using that old version, explicitly set `provider-failover.json` to `"contextGuard": false` and this extension's config to `"contextGuard": true` (or your desired settings). The new explicit value overrides legacy fallback. No installed package copy or user configuration is modified by this source change.

Summary generation costs extra model tokens and adds latency. Each context check makes at most one bounded batch request on the selected summary model's account, with its own isolated request session, cancellation and timeout. No fallback provider is selected. Summaries are cached only in memory and cleared after compaction, session/model switches or tree navigation. Raw session files are never rewritten. The guard may not reach its target in one check; failures preserve information instead of forcing a smaller request.

## Validation

From this directory, using the workspace's existing tools (no dependency installation needed):

```sh
npm test          # node --import tsx --test test/*.test.ts
npm run typecheck # tsc -p tsconfig.json
```
