import assert from "node:assert/strict";
import test from "node:test";
import { aggregateUsage } from "../src/aggregate.js";
import type { ScanDiagnostics, ScanResult, UsageRecord } from "../src/types.js";
import { buildReportLines, showTokensUi } from "../src/ui.js";

const diagnostics: ScanDiagnostics = {
  filesFound: 2,
  filesRead: 2,
  fileErrors: 0,
  malformedLines: 1,
  missingIds: 0,
  invalidTimestamps: 0,
};

const records: UsageRecord[] = [
  {
    id: "1",
    timestamp: Date.now(),
    provider: "provider",
    model: "model",
    inputTokens: 1_000,
    outputTokens: 200,
    cacheReadTokens: 300,
    cacheWriteTokens: 0,
    totalTokens: 1_500,
    costUSD: 1.25,
  },
  {
    id: "2",
    timestamp: Date.now(),
    provider: "zero-provider",
    model: "zero-model",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUSD: 0,
  },
];

test("renders non-zero usage as labeled bars within the requested width", () => {
  const lines = buildReportLines(aggregateUsage(records, "all"), "all", diagnostics, 60);
  const text = lines.join("\n");
  assert.match(text, /\[ All Time \]/);
  assert.match(text, /By Model/);
  assert.match(text, /By Provider/);
  assert.match(text, /█+/);
  assert.match(text, /1\.5K/);
  assert.match(text, /Skipped: 1 malformed line/);
  assert.doesNotMatch(text, /zero-model|zero-provider|\$0\.00/);
  assert.doesNotMatch(text, /├─|└─/);
  assert.ok(lines.every((line) => line.length <= 60));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function uiHarness() {
  let component: any;
  let renders = 0;
  const finished = deferred<void>();
  const ctx: any = {
    ui: {
      custom(factory: any) {
        component = factory({ requestRender() { renders++; } }, { fg: (_color: string, value: string) => value, bold: (value: string) => value }, {}, () => finished.resolve());
        return finished.promise;
      },
    },
  };
  return { ctx, get component() { return component; }, get renders() { return renders; } };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("opens with loading, paints a ledger snapshot before refresh finishes, and updates the active window", async () => {
  const ui = uiHarness();
  const snapshot = deferred<ScanResult>();
  const refresh = deferred<ScanResult>();
  let scans = 0;
  const shown = showTokensUi(ui.ctx, snapshot.promise, "all", () => { scans++; return refresh.promise; }, true);
  assert.match(ui.component.render(100).join("\n"), /Loading usage/);
  snapshot.resolve({ records, diagnostics });
  await flush();
  assert.equal(scans, 1);
  assert.match(ui.component.render(100).join("\n"), /1\.5K/);
  assert.match(ui.component.render(100).join("\n"), /Refreshing/);
  ui.component.handleInput("r");
  assert.equal(scans, 1, "manual refresh joins startup work");
  ui.component.handleInput("1");
  refresh.resolve({ records: [{ ...records[0]!, totalTokens: 4_500 }], diagnostics });
  await flush();
  const updated = ui.component.render(100).join("\n");
  assert.match(updated, /Today/);
  assert.match(updated, /4\.5K/);
  assert.doesNotMatch(updated, /Refreshing|Loading usage/);
  ui.component.handleInput("q");
  await shown;
});

test("refresh failure retains previous totals and closing prevents late redraws", async () => {
  const ui = uiHarness();
  const refresh = deferred<ScanResult>();
  const shown = showTokensUi(ui.ctx, { records, diagnostics }, "all", () => refresh.promise, true);
  await flush();
  refresh.reject(new Error("private session body must not appear"));
  await flush();
  const failed = ui.component.render(100).join("\n");
  assert.match(failed, /1\.5K/);
  assert.match(failed, /Refresh failed/);
  assert.doesNotMatch(failed, /private session body/);
  ui.component.handleInput("q");
  await shown;

  const lateUi = uiHarness();
  const late = deferred<ScanResult>();
  const lateShown = showTokensUi(lateUi.ctx, { records, diagnostics }, "all", () => late.promise, true);
  await flush();
  lateUi.component.handleInput("q");
  await lateShown;
  const rendersBefore = lateUi.renders;
  late.resolve({ records: [], diagnostics });
  await flush();
  assert.equal(lateUi.renders, rendersBefore);
});

test("renders seven local days as slim columns across the x-axis", () => {
  const lines = buildReportLines(aggregateUsage(records, "7"), "7", diagnostics, 100);
  const text = lines.join("\n");
  assert.match(text, /Daily Trend/);
  assert.equal(aggregateUsage(records, "7").daily.length, 7);
  assert.match(text, /\d{2}\/\d{2}/);
  assert.match(text, /█+/);
  assert.ok(lines.every((line) => line.length <= 100));
});
