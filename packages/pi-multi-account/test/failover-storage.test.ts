import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "pmacct-storage-"));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const { loadConfig, normalizeConfig } = await import("../failover-config.ts");
const { loadState, saveState, maskEmailAccount, redactSensitiveText, STATE_VERSION } = await import("../failover-state.ts");
const { slotsAsAChildSeesThem, isHostBuiltinProvider } = await import("../pi-files.ts");
const configPath = join(agentDir, "provider-failover.json");
const statePath = join(agentDir, "provider-failover-state.json");
const authPath = join(agentDir, "auth.json");

beforeEach(() => {
  for (const path of [configPath, statePath, statePath + ".tmp", authPath]) {
    rmSync(path, { recursive: true, force: true });
  }
});
after(() => {
  rmSync(agentDir, { recursive: true, force: true });
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

const readState = () => JSON.parse(readFileSync(statePath, "utf8"));

function assertPrivateFile(path: string) {
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
}

test("missing config is created privately and normalizes to the shipped defaults", () => {
  assert.equal(existsSync(configPath), false);
  assert.deepEqual(loadConfig(), normalizeConfig({}));
  assertPrivateFile(configPath);
  const saved = readFileSync(configPath, "utf8");
  const disk = JSON.parse(saved);
  assert.deepEqual(disk, normalizeConfig({}), "one defaults source owns runtime and new-file defaults");
  assert.equal(disk.onlyActive, false);
  for (const key of ["probeCooldownMs", "invalidCooldownMs", "openaiCodexAliases", "anthropicOAuthAliases"]) {
    assert.equal(Object.hasOwn(disk, key), false, `obsolete option ${key} must not be generated`);
  }
  assert.deepEqual(loadConfig(), normalizeConfig(disk));
  assert.equal(readFileSync(configPath, "utf8"), saved, "reading must not rewrite existing config");
});

test("normalization keeps explicit switches and empty priorities, clamps numbers and appends new families", () => {
  const defaults = normalizeConfig({});
  const config = normalizeConfig({
    enabled: false, autoContinue: false, includeCursor: false, childProxy: false,
    debugLog: false, preserveInterruptedContext: false,
    providerOrder: ["cursor"], providerPriority: [],
    maxAccountsPerProvider: 0.2, maxAutoContinuesPerPrompt: 2.9,
    cooldownMs: 0, usageRefreshMs: Infinity,
    reasoningLevel: "xhigh", preferredModels: { cursor: [" cursor-model ", "", "cursor-other"] },
  });
  assert.equal(config.enabled, false);
  assert.equal(config.autoContinue, false);
  assert.equal(config.includeCursor, false);
  assert.equal(config.childProxy, false);
  assert.equal(config.debugLog, false);
  assert.equal(config.preserveInterruptedContext, false);
  assert.deepEqual(config.providerPriority, []);
  assert.deepEqual(config.providerOrder, ["cursor", ...defaults.providerOrder.filter((family) => family !== "cursor")]);
  assert.equal(config.maxAccountsPerProvider, 1);
  assert.equal(config.maxAutoContinuesPerPrompt, 2);
  assert.equal(config.cooldownMs, defaults.cooldownMs);
  assert.equal(config.usageRefreshMs, defaults.usageRefreshMs);
  assert.equal(config.reasoningLevel, "xhigh");
  assert.deepEqual(config.preferredModels, { cursor: ["cursor-model", "cursor-other"] });
});

test("custom error vocabulary augments shipped patterns without case-insensitive duplicates", () => {
  const defaults = normalizeConfig({});
  const pattern = defaults.limitErrorPatterns[0]!;
  const config = normalizeConfig({ limitErrorPatterns: [pattern.toUpperCase(), " custom refusal "] });
  assert.deepEqual(config.limitErrorPatterns, [...defaults.limitErrorPatterns, "custom refusal"]);
  assert.deepEqual(defaults.limitErrorPatterns, normalizeConfig({}).limitErrorPatterns);
});

test("invalid saved values normalize safely and malformed config is not overwritten", () => {
  writeFileSync(configPath, JSON.stringify({
    providerOrder: ["unknown", "openai-codex"], reasoningLevel: "invalid",
    neverFailoverProviders: [" custom ", 42, ""], preferredModels: { custom: [false, " model "] },
  }));
  const config = loadConfig();
  assert.equal(config.reasoningLevel, "auto");
  assert.equal(config.providerOrder[0], "openai-codex");
  assert.deepEqual(config.neverFailoverProviders, ["custom"]);
  assert.deepEqual(config.preferredModels, { custom: ["model"] });
  writeFileSync(configPath, "{broken config");
  assert.deepEqual(loadConfig(), normalizeConfig({}));
  assert.equal(readFileSync(configPath, "utf8"), "{broken config");
});

test("obsolete options in existing configs are ignored without rewriting users' files", () => {
  const saved = JSON.stringify({
    enabled: false, onlyActive: true, providerPriority: [],
    probeCooldownMs: 123, invalidCooldownMs: 456,
    openaiCodexAliases: [{ id: "old-codex-alias", models: ["obsolete-model"] }],
    anthropicOAuthAliases: [{ id: "old-claude-alias" }],
    unrelatedUserSetting: "keep on disk",
  });
  writeFileSync(configPath, saved);
  const config = loadConfig();
  assert.equal(config.enabled, false);
  assert.equal(config.onlyActive, true);
  assert.deepEqual(config.providerPriority, []);
  for (const key of ["probeCooldownMs", "invalidCooldownMs", "openaiCodexAliases", "anthropicOAuthAliases"]) {
    assert.equal(Object.hasOwn(config, key), false);
  }
  assert.equal(readFileSync(configPath, "utf8"), saved);
});

test("missing or malformed state returns the current version without rewriting the file", () => {
  assert.deepEqual(loadState(), { stateVersion: STATE_VERSION });
  assert.equal(existsSync(statePath), false);
  writeFileSync(statePath, "{broken state");
  assert.deepEqual(loadState(), { stateVersion: STATE_VERSION });
  assert.equal(readFileSync(statePath, "utf8"), "{broken state");
});

test("v4 migration clears only per-model cooldowns and persists the other state", () => {
  const old = {
    stateVersion: 4,
    exhaustedUntilByProvider: { "openai-codex": Date.now() + 60_000 },
    exhaustedUntilByModel: { "openai-codex/model": Date.now() + 60_000 },
    invalidatedByProvider: { anthropic: { tokenHash: "fingerprint", at: 1, reason: "invalid" } },
    pendingContinuationPrompt: "continue", pendingFrom: "anthropic/model",
    lastUserModel: { provider: "openai-codex", id: "model" },
    lastUserThinkingLevel: "high", lastModelByFamily: { anthropic: "claude-model" },
  };
  writeFileSync(statePath, JSON.stringify(old));
  const expected = { ...old, stateVersion: STATE_VERSION, exhaustedUntilByModel: {} };
  assert.deepEqual(loadState(), expected);
  assert.deepEqual(readState(), expected);
  assertPrivateFile(statePath);
});

test("older state keeps plausible quota estimates and model preferences, not stale invalidations or pending work", () => {
  const now = Date.now();
  const old = {
    stateVersion: 3,
    exhaustedUntilByProvider: { plausible: now + 60_000, expired: now - 1, implausible: now + 20 * 86400_000 },
    exhaustedUntilByModel: { "anthropic/model": now + 60_000 },
    lastProbeAtByProvider: { plausible: now },
    invalidatedByProvider: { anthropic: { tokenHash: "fingerprint", at: now, reason: "old invalidation" } },
    pendingContinuationPrompt: "stale pending work", pendingFrom: "anthropic/model",
    lastSwitches: [], lastUserModel: { provider: "openai-codex", id: "model" },
    lastUserThinkingLevel: "high", lastModelByFamily: { anthropic: "claude-model" },
  };
  writeFileSync(statePath, JSON.stringify(old));
  const expected = {
    stateVersion: STATE_VERSION, exhaustedUntilByProvider: { plausible: now + 60_000 },
    exhaustedUntilByModel: {},
    invalidatedByProvider: {}, lastSwitches: [], lastUserModel: old.lastUserModel,
    lastUserThinkingLevel: "high", lastModelByFamily: old.lastModelByFamily,
  };
  assert.deepEqual(loadState(), expected);
  assert.deepEqual(readState(), expected);
});

test("state saves are private atomic replacements and strip undeclared legacy keys, zombie slots, and plaintext email PII", () => {
  writeFileSync(authPath, JSON.stringify({
    "openai-codex": { type: "oauth", access: "a", refresh: "r" },
    "cursor-account-2": { type: "oauth", access: "a2", refresh: "r2", email: "user.name@domain.com" },
  }));
  saveState({
    lastUserModel: { provider: "openai-codex", id: "model" },
    exhaustedUntilByProvider: { "openai-codex": 999999, "openai-codex-account-3": 888888 },
    codexModelCatalogByProvider: {
      "openai-codex": { fetchedAt: 1, models: [] },
      "openai-codex-account-3": { fetchedAt: 1, models: [] },
    },
    usageByProvider: {
      "cursor-account-2": {
        provider: "cursor-account-2",
        family: "cursor",
        fetchedAt: 10,
        account: "user.name@domain.com",
      },
      "openai-codex-account-3": {
        provider: "openai-codex-account-3",
        family: "codex",
        fetchedAt: 10,
        account: "ghost@domain.com",
      },
    },
  });
  const expected = {
    stateVersion: STATE_VERSION,
    exhaustedUntilByProvider: { "openai-codex": 999999 },
    usageByProvider: {
      "cursor-account-2": {
        provider: "cursor-account-2",
        family: "cursor",
        fetchedAt: 10,
        account: "u***@domain.com",
      },
    },
    codexModelCatalogByProvider: {
      "openai-codex": { fetchedAt: 1, models: [] },
    },
    lastUserModel: { provider: "openai-codex", id: "model" },
  };
  assert.deepEqual(readState(), expected);
  assertPrivateFile(statePath);
  assert.equal(existsSync(statePath + ".tmp"), false);
  assert.equal(maskEmailAccount("u***@domain.com"), "u***@domain.com", "masking is idempotent");
  assert.equal(maskEmailAccount("acct_12345"), "acct_12345", "non-email identifiers stay intact");
  const dirtyOnDisk = {
    ...expected,
    lastProbeAtByProvider: { "openai-codex": 123 },
    usageByProvider: {
      "cursor-account-2": {
        provider: "cursor-account-2",
        family: "cursor",
        fetchedAt: 10,
        account: "user.name@domain.com",
      },
      "openai-codex-account-3": {
        provider: "openai-codex-account-3",
        family: "codex",
        fetchedAt: 10,
        account: "ghost@domain.com",
      },
    },
  };
  writeFileSync(statePath, JSON.stringify(dirtyOnDisk));
  assert.deepEqual(loadState(), expected);
  assert.deepEqual(readState(), expected);
  assert.equal(Object.hasOwn(readState(), "lastProbeAtByProvider"), false);
});

test("a failed state write never throws or destroys the previous complete state", () => {
  saveState({ lastUserThinkingLevel: "high" });
  const before = readFileSync(statePath, "utf8");
  writeFileSync(authPath, JSON.stringify({ "openai-codex": { type: "oauth", access: "a", refresh: "r" } }));
  const cyclic: Record<string, unknown> = { provider: "openai-codex", family: "codex", fetchedAt: 1 };
  cyclic.self = cyclic;
  assert.doesNotThrow(() => saveState({ lastUserThinkingLevel: "low", usageByProvider: { "openai-codex": cyclic as any } }));
  assert.equal(readFileSync(statePath, "utf8"), before);
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    chmodSync(agentDir, 0o500);
    try {
      assert.doesNotThrow(() => saveState({ lastUserThinkingLevel: "low" }));
      assert.equal(readFileSync(statePath, "utf8"), before);
    } finally {
      chmodSync(agentDir, 0o700);
    }
  }
  assert.deepEqual(readdirSync(agentDir).filter((f) => f.endsWith(".tmp")), []);
});

test("sanitizeState strips disabled families from lastModelByFamily and redacts tokens/emails in reasons", () => {
  writeFileSync(configPath, JSON.stringify({ includeCursor: false, includeQwen: false, includeOllama: true }));
  writeFileSync(authPath, JSON.stringify({
    "openai-codex": { type: "oauth", access: "a", refresh: "r" },
    anthropic: { type: "oauth", access: "a2", refresh: "r2" },
  }));
  saveState({
    lastModelByFamily: {
      "openai-codex": "gpt-6.1-sol",
      cursor: "claude-4-sonnet",
      qwen: "qwen3.8-max",
      ollama: "glm-5.2:cloud",
    },
    pendingReason: "401 for spike.zhang.ai@gmail.com with Bearer sk-secret1234567890",
    invalidatedByProvider: {
      anthropic: {
        tokenHash: "abc",
        at: 100,
        reason: "revoked for alice@example.com key sk-1234567890abcdef",
      },
    },
    lastSwitches: [
      {
        from: "anthropic/claude-opus-5",
        to: "openai-codex/gpt-6.1-sol",
        reason: "quota hit on bob.smith@corp.io token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
        at: 200,
      },
    ],
  });
  const disk = readState();
  assert.deepEqual(disk.lastModelByFamily, {
    "openai-codex": "gpt-6.1-sol",
    ollama: "glm-5.2:cloud",
  });
  assert.equal(disk.pendingReason, "401 for s***@gmail.com with «redacted»");
  assert.equal(disk.invalidatedByProvider.anthropic.reason, "revoked for a***@example.com key «redacted»");
  assert.equal(disk.lastSwitches[0].reason, "quota hit on b***@corp.io token «redacted»");
  assert.equal(redactSensitiveText(disk.pendingReason), disk.pendingReason, "redaction is idempotent");
});

test("slotsAsAChildSeesThem uses explicit host builtin set instead of misclassifying cursor", () => {
  assert.equal(isHostBuiltinProvider("openai-codex"), true);
  assert.equal(isHostBuiltinProvider("anthropic"), true);
  assert.equal(isHostBuiltinProvider("xai"), true);
  assert.equal(isHostBuiltinProvider("cursor"), false);
  const verdicts = slotsAsAChildSeesThem(["openai-codex", "cursor"], {
    "openai-codex": { type: "oauth" },
    cursor: { type: "oauth" },
  });
  assert.equal(verdicts[0]?.usable, true);
  if (verdicts[0]?.usable) assert.equal(verdicts[0].via, "builtin");
  assert.equal(verdicts[1]?.usable, false);
});
