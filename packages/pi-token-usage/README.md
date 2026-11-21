# pi-token-usage

A lightweight Pi Coding Agent extension that reports the token usage and cost already recorded in local session JSONL files. It does not tokenize conversation text, estimate usage, query account quotas, or recalculate model pricing.

## Install

```bash
cd /home/spike/pi-token-usage
npm install
pi install /home/spike/pi-token-usage
```

Restart Pi after installation, or run `/reload` in an existing Pi TUI. For a one-off test without installing:

```bash
pi -e /home/spike/pi-token-usage/src/index.ts
```

## Use

```text
/usage
/usage today
/usage 7
/usage 30
/usage all
```

Without an argument, `/usage` opens at **Last 7 Days**. In the TUI:

- `←` / `→`: switch time window
- `1` / `2` / `3` / `4`: Today / 7 / 30 / All
- `r`: refresh changed session files (shares any refresh already in progress)
- `q` / `Esc`: close

The TUI opens immediately with a loading message, then shows the last in-memory result or local token ledger while session history refreshes in the background. The current view updates automatically when the refresh finishes; you can change windows or close it while scanning. A failed refresh keeps the previous totals. RPC, print, and JSON modes still return one final, reconciled plain report.

`today` starts at local midnight. `7` includes today and the previous six local calendar days, with a daily column chart. `30` is a rolling window ending at the scan time.

## Data source

Sessions are read recursively from:

```text
~/.pi/agent/sessions/
```

When `PI_CODING_AGENT_DIR` is set, the extension uses:

```text
$PI_CODING_AGENT_DIR/sessions/
```

Only `message` entries with an assistant role and recorded `message.usage` are counted. Records are deduplicated globally by `entry.id`. `entry.timestamp`, rather than file modification time, controls time filtering.

Usage metadata is reconciled with `token-usage.jsonl` beside the sessions directory. The ledger preserves historical records even after their session files are deleted, including records synced from other machines. An unreadable ledger is never replaced with a partial session-only result.

Within one extension runtime, unchanged files reuse their parsed usage metadata. Size, modification/change time, and inode changes trigger a full reread of that file; no conversation text is cached. Cache state resets on `/reload` or restart, so the first background scan still reads the full history. Failed file reads retain last-good cached records and are retried on the next refresh.

## Development

```bash
npm test
npm run typecheck
npm run check
```
