import assert from "node:assert/strict";
import test from "node:test";
import { cooldownFromHeaders, cooldownFromErrorText, cooldownMsFromUsage } from "../cooldown.ts";
import type { UsageSnapshot } from "../usage.ts";

const now = 1_700_000_000_000;

test("header names are case-insensitive and spent windows retain their reset precedence", () => {
  const headers = {
    "X-Codex-Primary-Used-Percent": "100", "X-Codex-Primary-Reset-After-Seconds": "10",
    "X-Codex-Secondary-Used-Percent": "100", "X-Codex-Secondary-Reset-After-Seconds": "120",
    "Retry-After": "30",
  };
  const before = structuredClone(headers);
  assert.equal(cooldownFromHeaders(headers), 120_000);
  assert.equal(cooldownFromHeaders({ ...headers, "X-Codex-Secondary-Used-Percent": "50" }), 10_000);
  assert.equal(cooldownFromHeaders({ ...headers, "X-Codex-Primary-Used-Percent": "50", "X-Codex-Secondary-Used-Percent": "50" }), 30_000);
  assert.equal(cooldownFromHeaders({ ...headers, "X-Codex-Secondary-Reset-After-Seconds": "invalid" }), 30_000);
  assert.deepEqual(headers, before);
});

test("Retry-After handles fractional seconds, HTTP dates, zero and absent hints", (t) => {
  t.mock.method(Date, "now", () => now);
  assert.equal(cooldownFromHeaders({ "retry-after": "1.2345" }), 1235);
  assert.equal(cooldownFromHeaders({ "retry-after": new Date(now + 2000).toUTCString() }), 2000);
  assert.equal(cooldownFromHeaders({ "retry-after": new Date(now - 2000).toUTCString() }), 0);
  assert.equal(cooldownFromHeaders({ "retry-after": "0" }), 0);
  assert.equal(cooldownFromHeaders({ "retry-after": "invalid" }), undefined);
  assert.equal(cooldownFromHeaders({}), undefined);
});

test("epoch reset hints are converted relative to the clock, not mistaken for durations", (t) => {
  t.mock.method(Date, "now", () => now);
  const epoch = String(now / 1000 + 90);
  assert.equal(cooldownFromHeaders({ "x-codex-primary-reset-at": epoch }), 90_000);
  assert.equal(cooldownFromHeaders({ "x-codex-primary-reset-at": String(now / 1000 - 1) }), 0);
  assert.equal(cooldownFromErrorText(`429 {"resets_at": ${epoch}}`), 90_000);
  assert.equal(cooldownFromErrorText(`{"resets_in_seconds": 3, "resets_at": ${epoch}}`), 3000);
});

test("structured error hints outrank prose and spent-secondary hints outrank primary", () => {
  const body = '{"X-Codex-Primary-Used-Percent": 100, "X-Codex-Primary-Reset-After-Seconds": 10, "X-Codex-Secondary-Used-Percent": 100, "X-Codex-Secondary-Reset-After-Seconds": 120}';
  assert.equal(cooldownFromErrorText(body + " Try again in 3 hours."), 120_000);
  assert.equal(cooldownFromErrorText('{"resets_in_seconds": 0} Try again in 3 hours.'), 0);
  assert.equal(cooldownFromErrorText('{"X-Codex-Primary-Reset-After-Seconds": 10} Try again in 3 hours.'), 10_000);
});

test("prose recovery estimates accept supported units but remain uncapped estimates", () => {
  for (const [text, expected] of [
    ["Try again in ~41615 min.", 41615 * 60_000],
    ["Try again in 1.5 hours.", 90 * 60_000],
    ["TRY AGAIN IN 2 days", 2 * 86400_000],
    ["try again in 2s", 2000],
  ] as const) assert.equal(cooldownFromErrorText(text), expected);
  for (const text of ["429 rate limit", "try again in 0 seconds", "try again in 2 weeks"]) {
    assert.equal(cooldownFromErrorText(text), undefined);
  }
});

test("usage estimates preserve the existing primary-headroom and future-window rules", () => {
  const base: UsageSnapshot = { provider: "openai-codex", family: "codex", fetchedAt: now };
  const spent = (resetAfter: number) => ({ usedPercent: 100, resetAt: now + resetAfter });
  const free = { usedPercent: 99, resetAt: now + 60_000 };
  assert.equal(cooldownMsFromUsage(base, now), undefined);
  assert.equal(cooldownMsFromUsage({ ...base, primary: free, secondary: spent(10_000) }, now), 0);
  assert.equal(cooldownMsFromUsage({ ...base, primary: spent(5000), secondary: spent(10_000) }, now), 5000);
  assert.equal(cooldownMsFromUsage({ ...base, primary: spent(-1), secondary: spent(10_000) }, now), 10_000);
  assert.equal(cooldownMsFromUsage({ ...base, secondary: free }, now), 0);
  assert.equal(cooldownMsFromUsage({ ...base, secondary: spent(-1) }, now), 0);
});
