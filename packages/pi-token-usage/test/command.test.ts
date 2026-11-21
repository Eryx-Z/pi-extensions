import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tokenUsageExtension from "../src/index.js";

test("TUI opens before any history scan is awaited, including without a ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-token-command-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  let command: any;
  let opened = false;
  let close!: () => void;
  const closed = new Promise<void>((resolve) => { close = resolve; });
  try {
    tokenUsageExtension({ registerCommand(_name: string, definition: any) { command = definition; } } as any);
    const pending = command.handler("all", {
      mode: "tui", hasUI: true,
      ui: { notify() {}, custom(factory: any) {
        opened = true;
        const component = factory({ requestRender() {} }, { fg: (_color: string, value: string) => value, bold: (value: string) => value }, {}, close);
        assert.match(component.render(100).join("\n"), /Loading usage/);
        close();
        return closed;
      } },
    });
    const openedSynchronously = opened;
    await pending;
    assert.equal(openedSynchronously, true, "no silent scan before opening the screen");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("RPC and headless commands keep final plain reports and never open custom TUI", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-token-report-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const output: string[] = [];
  const originalLog = console.log;
  let command: any;
  try {
    await mkdir(join(root, "sessions"));
    await writeFile(join(root, "token-usage.jsonl"), JSON.stringify({ id: "history", timestamp: Date.now(), provider: "test-provider", model: "test-model", totalTokens: 1234 }) + "\n");
    tokenUsageExtension({ registerCommand(_name: string, definition: any) { command = definition; } } as any);
    const ui = {
      custom() { assert.fail("custom TUI must not run outside TUI mode"); },
      notify(message: string, level: string) { assert.equal(level, "info"); output.push(message); },
    };
    await command.handler("all", { mode: "rpc", hasUI: true, ui });
    console.log = (message: string) => { output.push(message); };
    await command.handler("all", { mode: "print", hasUI: false, ui });
    await command.handler("all", { mode: "json", hasUI: false, ui });
    assert.equal(output.length, 3);
    for (const report of output) {
      assert.match(report, /1\.2K/);
      assert.match(report, /test-provider/);
      assert.doesNotMatch(report, /Loading|Refreshing/);
    }
  } finally {
    console.log = originalLog;
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("registers /usage command with 7/30/today/all argument completions", () => {
  let commandName = "";
  let commandDef: any;
  const mockPi: any = {
    registerCommand(name: string, def: any) {
      commandName = name;
      commandDef = def;
    },
  };

  tokenUsageExtension(mockPi);
  assert.equal(commandName, "usage");
  assert.ok(commandDef);

  const completions = commandDef.getArgumentCompletions("");
  assert.deepEqual(completions, [
    { value: "today", label: "today" },
    { value: "7", label: "7" },
    { value: "30", label: "30" },
    { value: "all", label: "all" },
  ]);

  const completions3 = commandDef.getArgumentCompletions("3");
  assert.deepEqual(completions3, [{ value: "30", label: "30" }]);
});

test("turn_end records assistant usage via Pi messageEntryId with matching entry timestamp and avoids full ledger rewrites on delta scan", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-token-turn-end-"));
  const cacheDir = await mkdtemp(join(tmpdir(), "pi-token-cache-"));
  const prevAgent = process.env.PI_CODING_AGENT_DIR;
  const prevCache = process.env.PI_TOKEN_USAGE_CACHE_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.PI_TOKEN_USAGE_CACHE_DIR = cacheDir;
  let turnEndHandler: ((event: any) => Promise<void>) | undefined;
  try {
    const sessionsDir = join(root, "sessions");
    const ledgerPath = join(root, "token-usage.jsonl");
    await mkdir(sessionsDir, { recursive: true });

    tokenUsageExtension({
      registerCommand() {},
      on(event: string, fn: any) {
        if (event === "turn_end") turnEndHandler = fn;
      },
    } as any);
    assert.ok(turnEndHandler, "turn_end listener must be registered");

    const isoTs = "2026-11-21T02:30:00.000Z";
    const expectedMs = Date.parse(isoTs);
    await turnEndHandler!({
      type: "turn_end",
      turnIndex: 0,
      messageEntryId: "entry-live-1",
      message: {
        role: "assistant",
        timestamp: expectedMs,
        provider: "openai-codex",
        model: "gpt-6-astra",
        usage: {
          input: 1200,
          output: 300,
          cacheRead: 5000,
          cacheWrite: 0,
          totalTokens: 6500,
          cost: { total: 0.042 },
        },
      },
      toolResults: [],
    });

    const { readTokenLedger, scanSessions } = await import("../src/scanner.js");
    const afterTurn = await readTokenLedger(ledgerPath);
    assert.equal(afterTurn.records.length, 1);
    assert.equal(afterTurn.records[0]?.id, "entry-live-1");
    assert.equal(afterTurn.records[0]?.timestamp, expectedMs);
    assert.equal(afterTurn.records[0]?.totalTokens, 6500);

    // Matching session file entry + 1 new entry must append in-place (preserving inode) instead of rewriting the ledger.
    const { stat } = await import("node:fs/promises");
    const beforeStat = await stat(ledgerPath);
    await writeFile(
      join(sessionsDir, "s1.jsonl"),
      JSON.stringify({
        type: "message",
        id: "entry-live-1",
        timestamp: isoTs,
        message: {
          role: "assistant",
          provider: "openai-codex",
          model: "gpt-6-astra",
          usage: {
            input: 1200,
            output: 300,
            cacheRead: 5000,
            cacheWrite: 0,
            totalTokens: 6500,
            cost: { total: 0.042 },
          },
        },
      }) +
        "\n" +
        JSON.stringify({
          type: "message",
          id: "entry-delta-2",
          timestamp: isoTs,
          message: {
            role: "assistant",
            provider: "openai-codex",
            model: "gpt-6-astra",
            usage: {
              input: 100,
              output: 50,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 150,
              cost: { total: 0.001 },
            },
          },
        }) +
        "\n",
    );
    const scanned = await scanSessions(sessionsDir, { ledgerPath });
    assert.equal(scanned.records.length, 2);
    const afterStat = await stat(ledgerPath);
    assert.equal(afterStat.ino, beforeStat.ino, "append-only reconciliation must keep ledger inode without full temp-rename rewrite");
  } finally {
    if (prevAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgent;
    if (prevCache === undefined) delete process.env.PI_TOKEN_USAGE_CACHE_DIR;
    else process.env.PI_TOKEN_USAGE_CACHE_DIR = prevCache;
    await rm(root, { recursive: true, force: true });
    await rm(cacheDir, { recursive: true, force: true });
  }
});
