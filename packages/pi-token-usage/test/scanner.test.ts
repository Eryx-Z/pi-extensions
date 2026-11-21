import assert from "node:assert/strict";
import { appendFile, chmod, mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendLedgerRecord, getSessionsDirectory, readTokenLedger, readUsageSnapshot, scanSessions } from "../src/scanner.js";

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function assistant(id: string | undefined, timestamp: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "message",
    ...(id === undefined ? {} : { id }),
    timestamp,
    message: {
      role: "assistant",
      provider: "anthropic",
      model: "claude-test",
      usage: {
        input: 10,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
        totalTokens: 19,
        cost: { total: 0.25 },
      },
      ...overrides,
    },
  };
}

test("resolves the configured and default sessions directories", () => {
  assert.equal(getSessionsDirectory({ PI_CODING_AGENT_DIR: "/custom/pi" }), "/custom/pi/sessions");
  assert.match(getSessionsDirectory({}), /\.pi\/agent\/sessions$/);
});

test("scans line-by-line, validates records, and deduplicates IDs across files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-token-usage-"));
  const nested = join(root, "old-project");
  await mkdir(nested);
  const today = new Date().toISOString();
  const first = join(root, "a.jsonl");
  const second = join(nested, "b.jsonl");

  const userEntry = {
    type: "message",
    id: "user-1",
    timestamp: today,
    message: { role: "user", usage: { totalTokens: 999 } },
  };
  const noUsage = {
    type: "message",
    id: "assistant-no-usage",
    timestamp: today,
    message: { role: "assistant" },
  };
  const unknownFields = assistant("def", today, {
    provider: undefined,
    model: "",
    usage: { input: -1, output: undefined, totalTokens: 7, cost: {} },
  });

  try {
    await writeFile(
      first,
      line(assistant("abc", today)) +
        line(userEntry) +
        line(noUsage) +
        '{ broken json "usage"\n' +
        line(assistant(undefined, today)),
    );
    await writeFile(
      second,
      line(assistant("abc", today, { usage: { totalTokens: 999_999 } })) +
        line(unknownFields) +
        line(assistant("bad-time", "not-a-date")),
    );
    // A stale file mtime must not hide a message with a current entry timestamp.
    await utimes(first, new Date("2000-01-01T00:00:00Z"), new Date("2000-01-01T00:00:00Z"));

    const result = await scanSessions(root, { concurrency: 2 });
    assert.equal(result.records.length, 2);
    assert.deepEqual(result.records.map((record) => record.id), ["abc", "def"]);
    assert.equal(result.records[0]?.totalTokens, 19, "lexically first duplicate wins");
    assert.deepEqual(result.records[1], {
      id: "def",
      timestamp: Date.parse(today),
      provider: "unknown",
      model: "unknown",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 7,
      costUSD: 0,
    });
    assert.equal(result.diagnostics.filesFound, 2);
    assert.equal(result.diagnostics.filesRead, 2);
    assert.equal(result.diagnostics.malformedLines, 1);
    assert.equal(result.diagnostics.missingIds, 1);
    assert.equal(result.diagnostics.invalidTimestamps, 1);
    const cached = await scanSessions(root, { concurrency: 1 });
    assert.deepEqual(cached.records, result.records);
    assert.deepEqual(cached.diagnostics, { ...result.diagnostics, filesRead: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reuses unchanged files, rescans append/truncate/same-size edits, and shares concurrent scans", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-token-incremental-"));
  const file = join(root, "a.jsonl");
  const second = join(root, "b.jsonl");
  const timestamp = new Date().toISOString();
  try {
    await writeFile(file, line(assistant("aaa", timestamp)));
    await writeFile(second, line(assistant("bbb", timestamp)));
    const first = await scanSessions(root, { syncLedger: false });
    assert.equal(first.diagnostics.filesRead, 2);
    const concurrent = await Promise.all([
      scanSessions(root, { syncLedger: false }),
      scanSessions(root, { syncLedger: false }),
    ]);
    assert.strictEqual(concurrent[0], concurrent[1], "one result from one in-flight scan");
    assert.equal(concurrent[0]!.diagnostics.filesRead, 0, "unchanged JSONL content is not reread");
    assert.deepEqual(concurrent[0]!.records, first.records);
    assert.equal(concurrent[0]!.diagnostics.malformedLines, first.diagnostics.malformedLines);

    await appendFile(file, line(assistant("ccc", timestamp)));
    const appended = await scanSessions(root, { syncLedger: false });
    assert.equal(appended.diagnostics.filesRead, 1);
    assert.deepEqual(appended.records.map((record) => record.id), ["aaa", "ccc", "bbb"]);

    await writeFile(file, line(assistant("ddd", timestamp)));
    const truncated = await scanSessions(root, { syncLedger: false });
    assert.equal(truncated.diagnostics.filesRead, 1);
    assert.deepEqual(truncated.records.map((record) => record.id), ["ddd", "bbb"]);

    const before = await stat(file);
    await writeFile(file, line(assistant("eee", timestamp)));
    await utimes(file, before.atime, new Date(before.mtimeMs + 2_000));
    const replaced = await scanSessions(root, { syncLedger: false });
    assert.equal(replaced.diagnostics.filesRead, 1);
    assert.deepEqual(replaced.records.map((record) => record.id), ["eee", "bbb"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retains a last-good file result on read failure and retries the failed file", { skip: process.getuid?.() === 0 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-token-failure-"));
  const file = join(root, "a.jsonl");
  const timestamp = new Date().toISOString();
  try {
    await writeFile(file, line(assistant("kept", timestamp)));
    const first = await scanSessions(root, { syncLedger: false });
    await appendFile(file, line(assistant("added", timestamp)));
    await chmod(file, 0);
    const failed = await scanSessions(root, { syncLedger: false });
    assert.equal(failed.diagnostics.fileErrors, 1);
    assert.deepEqual(failed.records, first.records);
    await chmod(file, 0o600);
    const retried = await scanSessions(root, { syncLedger: false });
    assert.equal(retried.diagnostics.filesRead, 1);
    assert.deepEqual(retried.records.map((record) => record.id), ["kept", "added"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps ledger-only history after deleting sessions and does not rewrite an unchanged union", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-token-history-"));
  const sessions = join(root, "sessions");
  const ledgerPath = join(root, "token-usage.jsonl");
  await mkdir(sessions);
  const file = join(sessions, "a.jsonl");
  try {
    await writeFile(file, line(assistant("local", new Date().toISOString())));
    await writeFile(ledgerPath, line({ id: "remote", timestamp: Date.now(), provider: "p", model: "m", totalTokens: 5 }));
    const result = await scanSessions(sessions, { ledgerPath });
    assert.deepEqual(result.records.map((record) => record.id), ["local", "remote"]);
    const before = await readFile(ledgerPath, "utf8");
    const oldTime = new Date("2000-01-01T00:00:00Z");
    await utimes(ledgerPath, oldTime, oldTime);
    await scanSessions(sessions, { ledgerPath });
    assert.equal((await stat(ledgerPath)).mtimeMs, oldTime.getTime(), "no rewrite on an unchanged union");
    await rm(file);
    const deleted = await scanSessions(sessions, { ledgerPath });
    assert.deepEqual(new Set(deleted.records.map((record) => record.id)), new Set(["local", "remote"]));
    assert.equal(await readFile(ledgerPath, "utf8"), before);
    assert.equal((await readTokenLedger(ledgerPath)).records.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persists corrected usage for the same ID before its session is deleted", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-token-correction-"));
  const sessions = join(root, "sessions");
  const ledgerPath = join(root, "token-usage.jsonl");
  const file = join(sessions, "a.jsonl");
  const timestamp = new Date().toISOString();
  await mkdir(sessions);
  try {
    await writeFile(file, line(assistant("same-id", timestamp, { usage: { totalTokens: 100 } })));
    await scanSessions(sessions, { ledgerPath });
    await writeFile(file, line(assistant("same-id", timestamp, { usage: { totalTokens: 200 } })));
    const corrected = await scanSessions(sessions, { ledgerPath });
    assert.equal(corrected.records[0]?.totalTokens, 200);
    assert.equal((await readTokenLedger(ledgerPath)).records[0]?.totalTokens, 200,
      "a changed record must update the ledger even when its ID is unchanged");
    await rm(file);
    assert.equal((await scanSessions(sessions, { ledgerPath })).records[0]?.totalTokens, 200);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("initial snapshot reads only deduplicated ledger metadata, then cached scans serve reopening", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-token-snapshot-"));
  const sessions = join(root, "sessions");
  const ledgerPath = join(root, "token-usage.jsonl");
  await mkdir(sessions);
  try {
    const remote = { id: "remote", timestamp: Date.now(), provider: "p", model: "m", totalTokens: 5 };
    await writeFile(ledgerPath, line(remote) + line(remote));
    await writeFile(join(sessions, "a.jsonl"), line(assistant("local", new Date().toISOString())));
    const snapshot = await readUsageSnapshot(sessions, { ledgerPath });
    assert.deepEqual(snapshot.records.map((record) => record.id), ["remote"]);
    assert.equal(snapshot.diagnostics.filesRead, 0);
    assert.equal(snapshot.diagnostics.filesFound, 0);
    const full = await scanSessions(sessions, { ledgerPath });
    assert.strictEqual(await readUsageSnapshot(sessions, { ledgerPath }), full);
    assert.deepEqual(full.records.map((record) => record.id), ["local", "remote"]);
    assert.equal((await readTokenLedger(ledgerPath)).records.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed ledger read retains cached history and cannot overwrite the ledger", { skip: process.getuid?.() === 0 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-token-ledger-failure-"));
  const sessions = join(root, "sessions");
  const ledgerPath = join(root, "token-usage.jsonl");
  await mkdir(sessions);
  try {
    const ledger = line({ id: "remote", timestamp: Date.now(), provider: "p", model: "m", totalTokens: 5 });
    await writeFile(ledgerPath, ledger);
    await scanSessions(sessions, { ledgerPath });
    await writeFile(join(sessions, "a.jsonl"), line(assistant("local", new Date().toISOString())));
    await chmod(ledgerPath, 0);
    const failed = await scanSessions(sessions, { ledgerPath });
    assert.equal(failed.diagnostics.fileErrors, 1);
    assert.deepEqual(failed.records.map((record) => record.id), ["local", "remote"]);
    await chmod(ledgerPath, 0o600);
    assert.equal(await readFile(ledgerPath, "utf8"), ledger);
    await scanSessions(sessions, { ledgerPath });
    assert.equal((await readTokenLedger(ledgerPath)).records.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent refresh and turn-end appends preserve their union, with idempotent reconciliation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-token-ledger-concurrent-"));
  const sessions = join(root, "sessions");
  const ledgerPath = join(root, "token-usage.jsonl");
  await mkdir(sessions);
  try {
    await writeFile(join(sessions, "a.jsonl"), line(assistant("local", new Date().toISOString())));
    await Promise.all([
      scanSessions(sessions, { ledgerPath }),
      ...Array.from({ length: 20 }, (_, i) => appendLedgerRecord({
        id: `live-${i}`, timestamp: Date.now(), provider: "p", model: "m", inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 5, costUSD: 0,
      }, ledgerPath)),
      scanSessions(sessions, { ledgerPath }),
    ]);
    const full = await scanSessions(sessions, { ledgerPath });
    assert.equal(full.records.length, 21);
    assert.equal((await readTokenLedger(ledgerPath)).records.length, 21);
    await scanSessions(sessions, { ledgerPath });
    assert.equal((await readTokenLedger(ledgerPath)).records.length, 21);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a cancelled scan does not poison a later refresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-token-cancel-"));
  try {
    await writeFile(join(root, "a.jsonl"), line(assistant("local", new Date().toISOString())));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(scanSessions(root, { signal: controller.signal, syncLedger: false }), { name: "AbortError" });
    const result = await scanSessions(root, { syncLedger: false });
    assert.equal(result.records.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns an empty result when the sessions directory does not exist", async () => {
  const root = join(tmpdir(), `missing-pi-sessions-${Date.now()}`);
  const result = await scanSessions(root);
  assert.deepEqual(result.records, []);
  assert.equal(result.diagnostics.filesFound, 0);
});

test("reconciles records with token-usage.jsonl ledger without duplicates", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-token-ledger-"));
  const sessionsDir = join(root, "sessions");
  await mkdir(sessionsDir);
  const ledgerPath = join(root, "token-usage.jsonl");

  const today = new Date().toISOString();
  // Session file has message 1
  await writeFile(
    join(sessionsDir, "session.jsonl"),
    line(assistant("msg-1", today, { usage: { totalTokens: 100 } })),
  );

  // Pre-existing ledger (e.g. from another synced machine) has msg-1 (duplicate) and msg-2 (remote-only)
  await writeFile(
    ledgerPath,
    line({
      id: "msg-1",
      timestamp: Date.now(),
      provider: "anthropic",
      model: "claude-test",
      totalTokens: 100,
    }) +
      line({
        id: "msg-2",
        timestamp: Date.now(),
        provider: "openai",
        model: "gpt-4o",
        totalTokens: 250,
      }),
  );

  try {
    const result = await scanSessions(sessionsDir, { ledgerPath });
    assert.equal(result.records.length, 2);
    assert.ok(result.records.some((r) => r.id === "msg-1"));
    assert.ok(result.records.some((r) => r.id === "msg-2"));

    const { readTokenLedger } = await import("../src/scanner.js");
    const { records: ledgerRecords } = await readTokenLedger(ledgerPath);
    assert.equal(ledgerRecords.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
