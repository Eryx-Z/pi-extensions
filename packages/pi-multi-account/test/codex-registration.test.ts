import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const agentDir = mkdtempSync(join(tmpdir(), "pmacct-registration-"));
const previousDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const { registerCodexSlot, registerCodexCatalog, DEFAULT_CODEX_MODELS, codexModelDef } =
  await import("../provider-slots.ts");
after(() => {
  rmSync(agentDir, { recursive: true, force: true });
  if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousDir;
});

function capture() {
  const calls: Array<{ id: string; config: Parameters<ExtensionAPI["registerProvider"]>[1] }> = [];
  const pi = { registerProvider(id: string, config: Parameters<ExtensionAPI["registerProvider"]>[1]) {
    calls.push({ id, config });
  } } as ExtensionAPI;
  return { calls, pi };
}

function assertRegistration(call: ReturnType<typeof capture>["calls"][number], id: string, models: unknown[]) {
  assert.equal(call.id, id);
  assert.equal(call.config.api, "openai-codex-responses");
  assert.equal(call.config.baseUrl, "https://chatgpt.com/backend-api");
  assert.equal(call.config.models, models, "catalog identity and unknown model metadata must survive");
  assert.equal(typeof call.config.oauth?.login, "function");
  assert.equal(typeof call.config.oauth?.refreshToken, "function");
  assert.equal(typeof call.config.oauth?.getApiKey, "function");
}

test("only slot provisioning skips the native base provider without an explicit name", () => {
  for (const name of [undefined, ""]) {
    const { calls, pi } = capture();
    registerCodexSlot(pi, "openai-codex", [], name);
    assert.equal(calls.length, 0);
    const models: Array<Record<string, unknown>> = [];
    registerCodexCatalog(pi, "openai-codex", models, name);
    assert.equal(calls.length, 1, "catalog sync must enrich the native base provider");
    assertRegistration(calls[0], "openai-codex", models);
    if (name === "") assert.equal(calls[0].config.name, "");
  }
});

test("base and alias registrations keep explicit names, empty/live catalogs and shared OAuth shape", () => {
  for (const id of ["openai-codex", "openai-codex-account-2"]) {
    for (const models of [[], [{ id: "future-model", contextWindow: 123456, custom: "keep" }]]) {
      const { calls, pi } = capture();
      registerCodexSlot(pi, id, models, "Chosen account");
      registerCodexCatalog(pi, id, models, "Chosen account");
      assert.equal(calls.length, 2);
      for (const call of calls) {
        assertRegistration(call, id, models);
        assert.equal(call.config.name, "Chosen account");
        assert.equal(call.config.oauth?.name, "Chosen account");
      }
      const { oauth: slotOAuth, ...slotConfig } = calls[0].config;
      const { oauth: catalogOAuth, ...catalogConfig } = calls[1].config;
      assert.deepEqual(slotConfig, catalogConfig);
      assert.deepEqual(Object.keys(slotOAuth!).sort(), Object.keys(catalogOAuth!).sort());
    }
  }
});

test("alias provisioning and catalog sync derive the same account label without an explicit name", () => {
  const { calls, pi } = capture();
  const models: Array<Record<string, unknown>> = [];
  registerCodexSlot(pi, "openai-codex-account-2", models);
  registerCodexCatalog(pi, "openai-codex-account-2", models);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].config.name, calls[1].config.name);
  assert.equal(calls[0].config.oauth?.name, calls[1].config.oauth?.name);
});

test("omitting a slot catalog keeps the existing offline defaults", () => {
  const { calls, pi } = capture();
  registerCodexSlot(pi, "openai-codex-account-2");
  assert.deepEqual(calls[0].config.models, DEFAULT_CODEX_MODELS.map(codexModelDef));
});
