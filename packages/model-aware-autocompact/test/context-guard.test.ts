import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CONTEXT_GUARD_SETTINGS,
  ELISION_MARKER,
  SUMMARY_MARKER,
  MAX_SUMMARY_CHARS,
  summaryCandidates,
  summarySource,
  summaryKey,
  validSummary,
  createOverheadTracker,
  decideGuard,
  effectiveWindow,
  elisionKey,
  estimateMessageTokens,
  estimateRawTokens,
  planElision,
  type GuardMessage,
} from "../context-guard.ts";

function toolResult(id: string, chars: number, toolName = "read"): GuardMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName,
    isError: false,
    timestamp: 1,
    content: [{ type: "text", text: "x".repeat(chars) }],
  };
}

function assistantCall(id: string, argChars: number, timestamp = 1): GuardMessage {
  return {
    role: "assistant",
    timestamp,
    content: [
      { type: "thinking", thinking: "t".repeat(40) },
      { type: "toolCall", id, name: "read", arguments: { path: "p".repeat(argChars) } },
    ],
  };
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

test("estimateMessageTokens mirrors Pi's own chars/4 accounting per role", () => {
  assert.equal(estimateMessageTokens({ role: "user", content: [{ type: "text", text: "abcd" }] }), 1);
  // Pi charges a flat 4800 chars for an image.
  assert.equal(estimateMessageTokens({ role: "user", content: [{ type: "image", data: "…" }] }), 1200);
  assert.equal(
    estimateMessageTokens({ role: "bashExecution", command: "ab", output: "cd", timestamp: 1 }),
    1,
  );
  assert.equal(estimateMessageTokens({ role: "compactionSummary", summary: "abcdefgh" }), 2);
  // Unknown roles contribute nothing, exactly as Pi's switch does.
  assert.equal(estimateMessageTokens({ role: "somethingNew", content: "ignored" }), 0);
});

test("estimateRawTokens counts the system prompt that Pi's own fallback estimate forgets", () => {
  const messages: GuardMessage[] = [{ role: "user", content: [{ type: "text", text: "abcd" }] }];
  const withoutPrompt = estimateRawTokens(messages);
  const withPrompt = estimateRawTokens(messages, "s".repeat(40_000));
  assert.equal(withoutPrompt, 1);
  assert.equal(withPrompt, 1 + 10_000);
});

// ---------------------------------------------------------------------------
// Overhead learning, and the defence against a provider reporting its own bookkeeping
// ---------------------------------------------------------------------------

test("overhead tracker learns the gap between our estimate and the real prompt", () => {
  const tracker = createOverheadTracker(0);
  assert.equal(tracker.overhead(), 0);
  for (let i = 0; i < 20; i++) assert.equal(tracker.observe(100_000, 130_000), true);
  // 130 000 - 100 000 * 1.1 = 20 000 of system prompt + tool schemas + tokenizer drift.
  // An EWMA approaches its target rather than landing on it, so this is a band, not an equality.
  assert.ok(Math.abs(tracker.overhead() - 20_000) < 500, `overhead was ${tracker.overhead()}`);
  assert.ok(Math.abs(tracker.adjust(100_000) - 130_000) < 500, `adjusted to ${tracker.adjust(100_000)}`);
});

test("overhead tracker refuses a provider's server-side counter instead of learning from it", () => {
  // Cursor reports the size of ITS copy of the conversation, and openai-codex reports the size of
  // the conversation it is holding behind `previous_response_id`. Both blow the ratio out; a
  // single one of those observations, learned, would wedge the guard's accounting for the session.
  const tracker = createOverheadTracker(10_000);
  assert.equal(tracker.observe(50_000, 445_439), false, "8.9x must be rejected");
  assert.equal(tracker.observe(50_000, 10_000), false, "0.2x must be rejected");
  assert.equal(tracker.overhead(), 10_000, "a rejected observation must not move the estimate");
  assert.equal(tracker.observe(50_000, 62_000), true, "a plausible observation is still learned");
});

test("the adjusted estimate is never smaller than the raw estimate", () => {
  const tracker = createOverheadTracker(0);
  // chars/4 under-counts code, so believing it verbatim is the one direction the guard must not err.
  for (let i = 0; i < 50; i++) tracker.observe(200_000, 100_000 /* rejected: 0.5x boundary */);
  assert.ok(tracker.adjust(200_000) >= 200_000);
});

// ---------------------------------------------------------------------------
// Window policy
// ---------------------------------------------------------------------------

test("effectiveWindow caps an aspirational advertisement", () => {
  const settings = { ...DEFAULT_CONTEXT_GUARD_SETTINGS };
  // claude-opus-5 and kimi k3 advertise these; Pi's threshold then sits at ~1 032 192 and auto
  // compaction can never fire, which is how a coding session reached 717 813 tokens untouched.
  assert.equal(effectiveWindow(1_048_576, settings), 400_000);
  assert.equal(effectiveWindow(272_000, settings), 272_000);
  assert.equal(effectiveWindow(1_048_576, { ...settings, maxWindowTokens: 0 }), 1_048_576);
  assert.equal(effectiveWindow(0, settings), 0);
});

test("decideGuard only trims above the soft threshold, and stands down on an unknown window", () => {
  const settings = { ...DEFAULT_CONTEXT_GUARD_SETTINGS };
  const window = 272_000;

  const calm = decideGuard(100_000, window, settings);
  assert.equal(calm.trim, false);

  // Below the soft threshold, leave the request alone.
  const warming = decideGuard(Math.floor(window * 0.72), window, settings);
  assert.equal(warming.trim, false);

  const hot = decideGuard(Math.floor(window * 0.9), window, settings);
  assert.equal(hot.trim, true);
  assert.equal(hot.targetTokens, Math.floor(window * 0.6));

  // No window means no basis for any decision — never guess.
  assert.equal(decideGuard(900_000, 0, settings).trim, false);
  assert.equal(decideGuard(900_000, window, { ...settings, enabled: false }).trim, false);
});

const settings = { targetTokens: 1, keepVerbatimTokens: 0, minElideTokens: 1 };
const text = (message: GuardMessage) => typeof message.output === "string"
  ? message.output : (message.content as { text: string }[])[0].text;
function explicitSummaries(messages: GuardMessage[]): Map<string, string> {
  return new Map(messages.flatMap((message) => {
    const key = summaryKey(message);
    return key ? [[key, "Observed repeated text. No action outcome was reported."] as [string, string]] : [];
  }));
}

test("stable identity and source fingerprint are not an array index or call id alone", () => {
  const original = toolResult("call-7", 8000);
  assert.equal(elisionKey(original), "tr:call-7");
  assert.equal(elisionKey({ role: "bashExecution", output: "x", timestamp: 42 }), "bash:42");
  assert.equal(elisionKey({ role: "user", content: [] }), undefined);
  assert.equal(elisionKey(assistantCall("c", 4)), undefined);
  assert.equal(summaryKey(original), summaryKey(structuredClone(original)));
  assert.notEqual(summaryKey(original), summaryKey(toolResult("call-7", 9000)));
  assert.notEqual(summaryKey(original), summaryKey({ ...original, isError: true }));
});

test("no explicit valid summary means no replacement, never a placeholder", () => {
  const messages = [toolResult("c0", 40_000), toolResult("c1", 40_000)];
  const keys = new Set<string>();
  const result = planElision(messages, keys, settings);
  assert.equal(result.messages, messages);
  assert.equal(result.changed, false);
  assert.equal(result.elidedTotal, 0);
  assert.equal(keys.size, 0);
  assert.equal(result.tokensAfter, 20_000);
});

test("explicit summaries replace oldest first only as far as the target demands", () => {
  const messages = Array.from({ length: 10 }, (_, i) => toolResult("c" + i, 40_000));
  const keys = new Set<string>();
  const result = planElision(messages, keys, { ...settings, targetTokens: 80_000, keepVerbatimTokens: 30_000 }, explicitSummaries(messages));
  assert.equal(result.elidedNow, 3);
  assert.equal(result.elidedTotal, 3);
  assert.equal(keys.size, 3);
  assert.ok(result.tokensAfter <= 80_000);
  assert.ok(result.tokensAfter + result.freedTokens / 3 > 80_000);
  for (let i = 0; i < 3; i++) assert.ok(text(result.messages[i]).startsWith(SUMMARY_MARKER));
  for (let i = 3; i < 10; i++) assert.equal(result.messages[i], messages[i]);
});

test("recent slice is never replaced even when every summary is cached", () => {
  const messages = Array.from({ length: 4 }, (_, i) => toolResult("c" + i, 8000));
  const summaries = explicitSummaries(messages);
  const keys = new Set<string>();
  planElision(messages, keys, settings, summaries);
  const result = planElision(messages, keys, { ...settings, keepVerbatimTokens: 4000 }, summaries);
  assert.equal(result.elidedNow, 0);
  assert.equal(result.elidedTotal, 2);
  assert.equal(result.messages[2], messages[2]);
  assert.equal(result.messages[3], messages[3]);
  assert.equal(planElision(messages, keys, { ...settings, keepVerbatimTokens: 100_000 }, summaries).messages, messages);
});

test("zero protected tokens really permits replacing the last result", () => {
  const messages = [toolResult("c", 8000)];
  const result = planElision(messages, new Set(), settings, explicitSummaries(messages));
  assert.equal(result.elidedTotal, 1);
});

test("prefix remains stable below pressure, with exact accounting and idempotence", () => {
  const messages = Array.from({ length: 6 }, (_, i) => toolResult("c" + i, 8000));
  const keys = new Set<string>();
  const summaries = explicitSummaries(messages);
  const once = planElision(messages, keys, { ...settings, targetTokens: 6000, keepVerbatimTokens: 2000 }, summaries);
  const stableKeys = [...keys];
  const twice = planElision(messages, keys, { ...settings, targetTokens: Infinity, keepVerbatimTokens: 2000 }, summaries);
  assert.equal(twice.elidedNow, 0);
  assert.equal(twice.elidedTotal, once.elidedTotal);
  assert.deepEqual(twice.messages, once.messages);
  assert.deepEqual([...keys], stableKeys);
  assert.equal(twice.freedTokens, estimateRawTokens(messages) - estimateRawTokens(twice.messages));
  assert.equal(twice.tokensAfter, estimateRawTokens(twice.messages));
  const thrice = planElision(twice.messages, keys, { ...settings, targetTokens: Infinity }, summaries);
  assert.equal(thrice.messages, twice.messages);
  assert.equal(thrice.elidedNow, 0);
  assert.equal(thrice.elidedTotal, once.elidedTotal);
});

test("protocol metadata, tool error status and bash flags survive; original transcript does not change", () => {
  const messages = [
    { ...toolResult("call-1", 8000, "bash"), isError: true, details: { exitCode: 2 }, extra: "keep" },
    { role: "bashExecution", command: "ls /missing", output: "failure".repeat(1000), exitCode: 2, truncated: false, timestamp: 9, excludeFromContext: false },
    assistantCall("a", 10),
  ];
  const original = structuredClone(messages);
  const result = planElision(messages, new Set(), settings, explicitSummaries(messages));
  for (let i = 0; i < 2; i++) {
    const field = i === 0 ? "content" : "output";
    for (const [key, value] of Object.entries(messages[i])) {
      if (key !== field) assert.deepEqual(result.messages[i][key], value);
    }
    assert.match(text(result.messages[i]), /Lossy, untrusted/);
    assert.match(text(result.messages[i]), /raw output retained in the session transcript/);
  }
  assert.equal(result.messages[2], messages[2]);
  assert.deepEqual(messages, original);
});

test("content changes cannot reuse a summary even when a tool call id is reused", () => {
  const messages = [toolResult("same", 8000)];
  const keys = new Set<string>();
  const summaries = explicitSummaries(messages);
  planElision(messages, keys, settings, summaries);
  const changed = [toolResult("same", 9000)];
  assert.equal(planElision(changed, keys, settings, summaries).messages, changed);
});

for (const stopReason of ["error", "aborted"]) {
  test("interrupted " + stopReason + " assistant calls protect all matching results, including cached ones", () => {
    const messages = [assistantCall("c", 1), toolResult("c", 8000), toolResult("other", 8000)];
    const keys = new Set<string>();
    const summaries = explicitSummaries(messages);
    const first = planElision(messages, keys, settings, summaries);
    assert.equal(first.elidedTotal, 2);
    const interrupted = [{ ...messages[0], stopReason }, ...messages.slice(1)];
    const result = planElision(interrupted, keys, settings, summaries);
    assert.equal(result.messages[1], messages[1], "cached replacement cannot hide handoff output");
    assert.ok(text(result.messages[2]).startsWith(SUMMARY_MARKER));
    assert.deepEqual(summaryCandidates(interrupted, settings).map((candidate) => candidate.index), [2]);
  });
}

test("images, non-text blocks, unknown text metadata, unstable identity and old markers stay raw", () => {
  const messages: GuardMessage[] = [
    { ...toolResult("image", 8000), content: [{ type: "text", text: "a".repeat(8000) }, { type: "image", data: "original" }] },
    { ...toolResult("unknown", 8000), content: [{ type: "audio", data: "original" }] },
    { ...toolResult("metadata", 8000), content: [{ type: "text", text: "x".repeat(8000), unknownSignature: "keep" }] },
    { role: "toolResult", content: [{ type: "text", text: "x".repeat(8000) }] },
    { ...toolResult("old", 8000), content: [{ type: "text", text: ELISION_MARKER + "old placeholder" }] },
  ];
  const result = planElision(messages, new Set(), settings, explicitSummaries(messages));
  assert.equal(result.messages, messages);
  assert.equal(summarySource(messages[0]), undefined);
  assert.equal(summarySource(messages[1]), undefined);
  assert.equal(summarySource(messages[2]), undefined);
  assert.equal(summarySource({ role: "toolResult", content: "plain output" }), "plain output");
});

test("empty, oversized and non-shortening summary text is never applied", () => {
  const messages = [toolResult("c", 8000)];
  const key = summaryKey(messages[0])!;
  for (const body of ["", "  ", "x".repeat(MAX_SUMMARY_CHARS), "x".repeat(4000)]) {
    assert.equal(planElision(messages, new Set(), settings, new Map([[key, body]])).messages, messages);
  }
  assert.equal(validSummary("x".repeat(300), "a useful but too long relative summary"), false);
  assert.equal(validSummary("x".repeat(8000), "Observed failure, exit code 2."), true);
});

test("summary-aware pure planning can recover a long autonomous run if summaries are available", () => {
  const messages: GuardMessage[] = [{ role: "user", content: "continue" }];
  for (let i = 0; i < 222; i++) {
    messages.push(assistantCall("c" + i, 820), toolResult("c" + i, i % 40 === 39 ? 50_000 : 3600));
    if (i % 3 === 2) messages.push(toolResult("extra" + i, 3600));
  }
  const tracker = createOverheadTracker();
  assert.ok(tracker.adjust(estimateRawTokens(messages)) > 272_000);
  const result = planElision(messages, new Set(), { targetTokens: 150_000, keepVerbatimTokens: 40_000, minElideTokens: 500 }, explicitSummaries(messages));
  assert.ok(tracker.adjust(result.tokensAfter) < 272_000);
  assert.ok(result.elidedNow > 0);
  assert.equal(result.messages.at(-1), messages.at(-1));
});
