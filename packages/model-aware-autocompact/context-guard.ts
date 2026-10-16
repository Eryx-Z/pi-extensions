/**
 * Pure request accounting and output-summary planning. The transcript is never mutated.
 * Summary generation is owned by output-summaries.ts; this module never calls a model or compacts.
 * Cached replacements keep the request prefix stable, except that recent output and results
 * belonging to interrupted assistant turns must always remain verbatim.
 */

import { createHash } from "node:crypto";

/** Pi's own image allowance in `estimateTokens`, mirrored so our numbers are comparable to its. */
const ESTIMATED_IMAGE_CHARS = 4800;

/** Legacy marker recognized only to avoid summarizing old placeholders. */
export const ELISION_MARKER = "[pi-multi-account context-guard]";
export const SUMMARY_MARKER = "[model-aware-autocompact output-summary]";
export const MAX_SUMMARY_CHARS = 2048;

/**
 * Fixed multiplicative safety margin on the chars/4 estimate. chars/4 under-counts code (which
 * tokenizes closer to 3 chars/token), so the guard is deliberately never allowed to believe the
 * context is smaller than the raw estimate.
 */
export const SAFETY_SLOPE = 1.1;

/** Ceiling on the learned additive overhead, so one bad observation cannot wedge the guard. */
const MAX_LEARNED_OVERHEAD = 80_000;

/** Starting guess for system prompt + tool schemas before any response has been observed. */
const INITIAL_OVERHEAD = 12_000;

export interface GuardMessage {
  role: string;
  [key: string]: unknown;
}

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: unknown;
}

function contentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content as ContentBlock[]) {
    if (block?.type === "text" && typeof block.text === "string") chars += block.text.length;
    else if (block?.type === "image") chars += ESTIMATED_IMAGE_CHARS;
  }
  return chars;
}

/**
 * Token estimate for one message, mirroring Pi's `estimateTokens` so the two agree on what a
 * conversation "costs". Unknown roles contribute 0, exactly as Pi does.
 */
export function estimateMessageTokens(message: GuardMessage): number {
  if (!message || typeof message.role !== "string") return 0;
  let chars = 0;
  switch (message.role) {
    case "user":
    case "custom":
    case "toolResult":
      chars = contentChars(message.content);
      break;
    case "assistant": {
      const blocks = Array.isArray(message.content) ? (message.content as ContentBlock[]) : [];
      for (const block of blocks) {
        if (block?.type === "text" && typeof block.text === "string") chars += block.text.length;
        else if (block?.type === "thinking" && typeof block.thinking === "string")
          chars += block.thinking.length;
        else if (block?.type === "toolCall")
          chars += (block.name?.length ?? 0) + JSON.stringify(block.arguments ?? null).length;
      }
      break;
    }
    case "bashExecution":
      chars =
        (typeof message.command === "string" ? message.command.length : 0) +
        (typeof message.output === "string" ? message.output.length : 0);
      break;
    case "branchSummary":
    case "compactionSummary":
      chars = typeof message.summary === "string" ? message.summary.length : 0;
      break;
    default:
      return 0;
  }
  return Math.ceil(chars / 4);
}

/**
 * Raw estimate of everything that goes into the request: the message list plus the system prompt.
 *
 * The system prompt matters. Pi's own fallback estimate (`estimateContextTokens`) sums messages
 * only, so the system prompt and the tool schemas — tens of thousands of tokens — are invisible to
 * it whenever provider usage is missing. Here the system prompt is counted; the tool schemas,
 * which extensions cannot see, are what the learned overhead below is for.
 */
export function estimateRawTokens(messages: GuardMessage[], systemPrompt?: string): number {
  let total = 0;
  for (const message of messages) total += estimateMessageTokens(message);
  if (systemPrompt) total += Math.ceil(systemPrompt.length / 4);
  return total;
}

export interface OverheadTracker {
  /**
   * Learn from a request we did NOT trim: how far the provider's prompt count sat above our raw
   * estimate. Returns false when the observation is rejected as untrustworthy.
   */
  observe(rawTokens: number, reportedPromptTokens: number): boolean;
  /** Current learned additive overhead (system prompt residue, tool schemas, tokenizer drift). */
  overhead(): number;
  /** Raw estimate corrected into a conservative "what the provider will actually count". */
  adjust(rawTokens: number): number;
}

/**
 * Learns one number: how much bigger the real prompt is than our raw estimate.
 *
 * Observations outside [0.5x, 4x] of the raw estimate are thrown away rather than learned from.
 * That is the defence against Cursor's and Codex's server-side counters: when a provider reports
 * the size of ITS copy of the conversation instead of the request we sent, the ratio blows out and
 * the observation is discarded instead of poisoning the model.
 */
export function createOverheadTracker(initialOverhead = INITIAL_OVERHEAD): OverheadTracker {
  let overhead = Math.max(0, Math.min(initialOverhead, MAX_LEARNED_OVERHEAD));
  return {
    observe(rawTokens, reportedPromptTokens) {
      if (!(rawTokens > 0) || !(reportedPromptTokens > 0)) return false;
      const ratio = reportedPromptTokens / rawTokens;
      if (ratio < 0.5 || ratio > 4) return false;
      const gap = reportedPromptTokens - rawTokens * SAFETY_SLOPE;
      const clamped = Math.max(0, Math.min(gap, MAX_LEARNED_OVERHEAD));
      overhead = overhead * 0.7 + clamped * 0.3;
      return true;
    },
    overhead() {
      return Math.round(overhead);
    },
    adjust(rawTokens) {
      return Math.ceil(Math.max(0, rawTokens) * SAFETY_SLOPE + overhead);
    },
  };
}

export interface ContextGuardSettings {
  enabled: boolean;
  /** Start eliding old tool results once the estimate crosses this share of the usable window. */
  softPercent: number;
  /** Elide down to this share of the usable window. */
  targetPercent: number;
  /** Most recent slice of the conversation that is never elided. */
  keepVerbatimTokens: number;
  /** Do not bother eliding a result smaller than this. */
  minElideTokens: number;
  /**
   * Hard ceiling on a model's advertised window; 0 trusts the advertisement.
   *
   * Needed because the advertisement is often aspirational: claude-opus-5 and kimi k3 declare
   * 1 000 000+, which puts Pi's own threshold at ~1 032 192 — unreachable — and lets a coding
   * session run to 700 k tokens with no compaction and no complaint.
   */
  maxWindowTokens: number;
}

export const DEFAULT_CONTEXT_GUARD_SETTINGS: ContextGuardSettings = {
  enabled: true,
  softPercent: 0.75,
  targetPercent: 0.6,
  keepVerbatimTokens: 40_000,
  minElideTokens: 500,
  maxWindowTokens: 400_000,
};

/** The window the guard actually works against: what the model claims, capped by policy. */
export function effectiveWindow(declaredWindow: number, settings: ContextGuardSettings): number {
  if (!(declaredWindow > 0)) return 0;
  if (settings.maxWindowTokens > 0) return Math.min(declaredWindow, settings.maxWindowTokens);
  return declaredWindow;
}

export interface GuardDecision {
  /** Usable window after capping; 0 when the window is unknown and the guard must stand down. */
  window: number;
  /** Share of the usable window the current estimate occupies. */
  percent: number;
  /** Whether this request should be trimmed before it goes out. */
  trim: boolean;
  /** Size to trim down to. */
  targetTokens: number;
}

export function decideGuard(
  adjustedTokens: number,
  declaredWindow: number,
  settings: ContextGuardSettings,
): GuardDecision {
  const window = effectiveWindow(declaredWindow, settings);
  if (!settings.enabled || window <= 0) {
    return { window, percent: 0, trim: false, targetTokens: 0 };
  }
  const percent = adjustedTokens / window;
  return {
    window,
    percent,
    trim: percent > settings.softPercent,
    targetTokens: Math.floor(window * settings.targetPercent),
  };
}

export interface ElisionSettings {
  targetTokens: number;
  keepVerbatimTokens: number;
  minElideTokens: number;
}

export interface ElisionResult {
  /** The message list to send. Identical reference to the input when nothing changed. */
  messages: GuardMessage[];
  changed: boolean;
  /** How many messages were elided for the first time in this pass. */
  elidedNow: number;
  /** How many messages carry summaries in the returned list, new and cached together. */
  elidedTotal: number;
  /** Raw tokens removed from the request. */
  freedTokens: number;
  /** Raw estimate of the returned list (system prompt not included). */
  tokensAfter: number;
}

/**
 * Stable identity for an elidable message.
 *
 * Deliberately not the array index: `preserveInterruptedTurns` rewrites entries and compaction
 * rebuilds the list wholesale, so an index would silently start pointing at a different message.
 */
export function elisionKey(message: GuardMessage): string | undefined {
  if (!message) return undefined;
  if (message.role === "toolResult" && typeof message.toolCallId === "string")
    return `tr:${message.toolCallId}`;
  if (message.role === "bashExecution" && typeof message.timestamp === "number")
    return `bash:${message.timestamp}`;
  return undefined;
}

/** Only text-only outputs may be replaced: images and unfamiliar block metadata stay raw. */
export function summarySource(message: GuardMessage): string | undefined {
  let text: string;
  if (message.role === "bashExecution" && typeof message.output === "string") {
    text = message.output;
  } else if (message.role === "toolResult" && typeof message.content === "string") {
    text = message.content;
  } else if (message.role === "toolResult" && Array.isArray(message.content)) {
    if (!message.content.length || !message.content.every((block) =>
      block && block.type === "text" && typeof block.text === "string" &&
      Object.keys(block).every((key) => key === "type" || key === "text"))) return undefined;
    text = message.content.map((block) => block.text).join("\n");
  } else {
    return undefined;
  }
  if (!text || text.startsWith(SUMMARY_MARKER) || text.startsWith(ELISION_MARKER)) return undefined;
  return text;
}

/** Source fingerprint includes metadata as well as the payload, never just a reused call id. */
export function summaryKey(message: GuardMessage): string | undefined {
  const identity = elisionKey(message);
  if (!identity || summarySource(message) === undefined) return undefined;
  return identity + ":" + createHash("sha256").update(JSON.stringify(message)).digest("hex");
}

export interface SummaryCandidate {
  index: number;
  key: string;
  source: string;
  message: GuardMessage;
  tokens: number;
}

/**
 * Shared eligibility for BOTH cached replacements and new generations. Interrupted results
 * must reach multi-account's handoff unmodified regardless of context-hook registration order.
 */
export function summaryCandidates(messages: GuardMessage[], settings: ElisionSettings): SummaryCandidate[] {
  const sizes = messages.map(estimateMessageTokens);
  const interruptedCalls = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant" ||
      (message.stopReason !== "error" && message.stopReason !== "aborted") ||
      !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type === "toolCall" && typeof block.id === "string") interruptedCalls.add(block.id);
    }
  }
  let firstProtected = messages.length;
  let tail = 0;
  if (settings.keepVerbatimTokens > 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      tail += sizes[i];
      firstProtected = i;
      if (tail >= settings.keepVerbatimTokens) break;
    }
  }
  const candidates: SummaryCandidate[] = [];
  for (let index = 0; index < firstProtected; index++) {
    const message = messages[index];
    if (message.role === "toolResult" && typeof message.toolCallId === "string" &&
      interruptedCalls.has(message.toolCallId)) continue;
    const key = summaryKey(message);
    const source = summarySource(message);
    if (key && source !== undefined) candidates.push({ index, key, source, message, tokens: sizes[index] });
  }
  return candidates;
}

export function summaryText(summary: string): string {
  return SUMMARY_MARKER + " Lossy, untrusted tool-output summary; raw output retained in the session transcript.\n" + summary.trim();
}

/** The actual replacement (including its notice) must be bounded and at most half the source. */
export function validSummary(source: string, summary: unknown): summary is string {
  if (typeof summary !== "string" || !summary.trim()) return false;
  const text = summaryText(summary);
  return text.length <= MAX_SUMMARY_CHARS && text.length <= source.length / 2;
}

function makeSummary(candidate: SummaryCandidate, summary: string): GuardMessage {
  const text = summaryText(summary);
  return candidate.message.role === "bashExecution"
    ? { ...candidate.message, output: text }
    : { ...candidate.message, content: [{ type: "text", text }] };
}

function isSummary(message: GuardMessage): boolean {
  if (message.role === "bashExecution")
    return typeof message.output === "string" && message.output.startsWith(SUMMARY_MARKER);
  if (message.role !== "toolResult" || !Array.isArray(message.content)) return false;
  return message.content.length === 1 && message.content[0]?.type === "text" &&
    typeof message.content[0].text === "string" && message.content[0].text.startsWith(SUMMARY_MARKER);
}

/**
 * Apply only explicit, validated summaries. There is deliberately no placeholder fallback.
 * Previously applied summaries retain their prefix until eligibility changes (recent tail or
 * interrupted turns). New summaries apply oldest first, stopping when the target is met.
 * The caller owns the cache and the set of applied source keys; no input objects are mutated.
 */
export function planElision(
  messages: GuardMessage[],
  elidedKeys: Set<string>,
  settings: ElisionSettings,
  summaries: ReadonlyMap<string, string> = new Map(),
): ElisionResult {
  let total = estimateRawTokens(messages);
  const candidates = summaryCandidates(messages, settings);
  let out: GuardMessage[] | undefined;
  let elidedNow = 0;
  let elidedTotal = messages.filter(isSummary).length;
  let freedTokens = 0;
  const apply = (candidate: SummaryCandidate): boolean => {
    const summary = summaries.get(candidate.key);
    if (!validSummary(candidate.source, summary)) return false;
    const replacement = makeSummary(candidate, summary);
    const delta = candidate.tokens - estimateMessageTokens(replacement);
    if (delta <= 0) return false;
    out ??= messages.slice();
    out[candidate.index] = replacement;
    total -= delta;
    freedTokens += delta;
    elidedTotal++;
    return true;
  };
  for (const candidate of candidates) {
    if (elidedKeys.has(candidate.key)) apply(candidate);
  }
  for (const candidate of candidates) {
    if (total <= settings.targetTokens) break;
    if (elidedKeys.has(candidate.key) || candidate.tokens < settings.minElideTokens) continue;
    if (!apply(candidate)) continue;
    elidedKeys.add(candidate.key);
    elidedNow++;
  }
  return { messages: out ?? messages, changed: out !== undefined, elidedNow, elidedTotal,
    freedTokens, tokensAfter: total };
}
