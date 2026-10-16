import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "pmacct-storage-"));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const { loadConfig, normalizeConfig } = await import("../failover-config.ts");
const { loadState, saveState, STATE_VERSION } = await import("../failover-state.ts");
const configPath = join(agentDir, "provider-failover.json");
const statePath = join(agentDir, "provider-failover-state.json");

beforeEach(() => {
  for (const path of [configPath, statePath, statePath + ".tmp"]) {
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

test("state saves are private atomic replacements and current-version reads preserve unknown fields", () => {
  saveState({ lastUserModel: { provider: "openai-codex", id: "model" } });
  const expected = { stateVersion: STATE_VERSION, lastUserModel: { provider: "openai-codex", id: "model" } };
  assert.deepEqual(readState(), expected);
  assertPrivateFile(statePath);
  assert.equal(existsSync(statePath + ".tmp"), false);
  const withFutureField = { ...expected, futureMetadata: { keep: true }, lastProbeAtByProvider: { legacy: 1 } };
  writeFileSync(statePath, JSON.stringify(withFutureField));
  assert.deepEqual(loadState(), withFutureField);
  assert.deepEqual(readState(), withFutureField);
});

test("a failed state write never throws or destroys the previous complete state", () => {
  saveState({ lastUserThinkingLevel: "high" });
  const before = readFileSync(statePath, "utf8");
  mkdirSync(statePath + ".tmp"); // Block the temporary write, independently of user/root permissions.
  assert.doesNotThrow(() => saveState({ lastUserThinkingLevel: "low" }));
  assert.equal(readFileSync(statePath, "utf8"), before);
});
