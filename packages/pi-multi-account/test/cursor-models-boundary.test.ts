import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
// Cursor's vendored entry points are intentionally excluded by the package tsconfig.
// Load their actual runtime surface without pulling the whole proxy/proto tree into tsc.
const models = await import(new URL("../cursor/models.ts", import.meta.url).href);
const { FALLBACK_MODELS: sharedFallbackModels, registerCursorProvider } =
  await import(new URL("../cursor/cursor-shared.ts", import.meta.url).href);
const {
  FALLBACK_MODELS,
  buildEffortMap,
  modelConfig,
  parseModelId,
  processModels,
  supportsReasoningModelId,
} = await import(new URL("../cursor/index.ts", import.meta.url).href);

function model(id: string, name = id) {
  return { id, name, reasoning: false, contextWindow: 200_000, maxTokens: 32_000 };
}

test("Cursor model parsing preserves suffix order and namespaced reasoning families", () => {
  assert.deepEqual(parseModelId("claude-4.6-opus-high-thinking-fast"), {
    base: "claude-4.6-opus", effort: "high", fast: true, thinking: true,
  });
  assert.deepEqual(parseModelId("unknown-preview"), {
    base: "unknown-preview", effort: "", fast: false, thinking: false,
  });
  for (const id of ["default", "cursor-grok-4.6", "GPT-5.4", "unknown-high", "unknown-thinking"]) {
    assert.equal(supportsReasoningModelId(id), true, id);
  }
  assert.equal(supportsReasoningModelId("unknown-preview"), false);
});

test("Cursor effort folding preserves ordering, representative metadata and fast/thinking variants", () => {
  const raw = [
    model("gpt-5.4-high", "GPT 5.4 High"),
    { ...model("gpt-5.4-medium", "GPT 5.4 Medium"), maxTokens: 16_000 },
    model("gpt-5.4-low", "GPT 5.4 Low"),
    model("gpt-5.4-high-thinking-fast", "GPT 5.4 Thinking Fast"),
    model("composer-2", "Composer 2"),
  ];
  const before = structuredClone(raw);
  const processed = processModels(raw);
  assert.deepEqual(raw, before, "processing must not mutate the catalog");
  assert.deepEqual(processed.map((m: { id: string }) => m.id), ["composer-2", "gpt-5.4", "gpt-5.4-thinking-fast"]);
  assert.equal(processed[0]!.supportsEffort, false);
  assert.equal(processed[1]!.name, "GPT 5.4");
  assert.equal(processed[1]!.maxTokens, 16_000);
  assert.deepEqual(processed[1]!.effortMap, {
    minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high",
  });
  assert.deepEqual(processed[2]!.effortMap, {
    minimal: "high", low: "high", medium: "high", high: "high", xhigh: "high",
  });
  assert.deepEqual(buildEffortMap(new Set()), {});
  assert.deepEqual(buildEffortMap(new Set(["", "none", "xhigh", "max"])), {
    minimal: "none", low: "none", medium: "", high: "", xhigh: "max",
  });
});

test("Cursor model registration keeps effort configuration, token limits and estimated costs", () => {
  const [processed] = processModels([model("gpt-5.4-high", "GPT 5.4 High")]);
  assert.deepEqual(modelConfig(processed!), {
    id: "gpt-5.4", name: "GPT 5.4", reasoning: true, input: ["text"],
    cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
    contextWindow: 200_000, maxTokens: 32_000,
    thinkingLevelMap: { off: null, minimal: "high", low: "high", medium: "high", high: "high", xhigh: "high" },
    compat: {
      supportsDeveloperRole: false, supportsReasoningEffort: true,
      reasoningEffortMap: { minimal: "high", low: "high", medium: "high", high: "high", xhigh: "high" },
      maxTokensField: "max_tokens",
    },
  });
  const config = (id: string) => modelConfig(processModels([model(id)])[0]!);
  assert.deepEqual(config("unknown").cost, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 });
  assert.deepEqual(config("claude-new-opus-fast").cost, { input: 30, output: 150, cacheRead: 3, cacheWrite: 37.5 });
  assert.deepEqual(config("gpt-5.4-mini-preview").cost, { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 });
  assert.equal("thinkingLevelMap" in config("unknown"), false);
});

test("Cursor fallback catalog is reasoning-normalized and restores the folded Grok model", () => {
  for (const entry of FALLBACK_MODELS) {
    assert.equal(entry.reasoning, supportsReasoningModelId(entry.id), entry.id);
  }
  const grok = processModels(FALLBACK_MODELS).find((m: { id: string }) => m.id === "cursor-grok-4.6");
  assert.ok(grok);
  assert.equal(modelConfig(grok).reasoning, true);
});

test("the single-account entry point re-exports the same shared model implementation", () => {
  assert.equal(FALLBACK_MODELS, models.FALLBACK_MODELS);
  assert.equal(sharedFallbackModels, models.FALLBACK_MODELS);
  assert.equal(buildEffortMap, models.buildEffortMap);
  assert.equal(modelConfig, models.modelConfig);
  assert.equal(parseModelId, models.parseModelId);
  assert.equal(processModels, models.processModels);
  assert.equal(supportsReasoningModelId, models.supportsReasoningModelId);
});

test("multi-account registration uses the shared catalog configuration without starting the proxy", () => {
  const registered: Array<{ id: string; config: any }> = [];
  const pi = { registerProvider: (id: string, config: any) => registered.push({ id, config }) };
  registerCursorProvider(pi, "cursor-account-2", 45678);
  assert.equal(registered.length, 1);
  assert.equal(registered[0]!.id, "cursor-account-2");
  assert.equal(registered[0]!.config.name, "Cursor (cursor-account-2)");
  assert.equal(registered[0]!.config.baseUrl, "http://127.0.0.1:45678/v1");
  assert.deepEqual(registered[0]!.config.models, processModels(FALLBACK_MODELS).map(modelConfig));
  assert.equal(registered[0]!.config.oauth.getApiKey({ access: "slot-token" }), "slot-token");
});

/** Follow local runtime imports/re-exports, including literal dynamic imports; erase type-only edges. */
function runtimeModuleGraph(entry: URL): Set<string> {
  const visited = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const url = pending.pop()!;
    if (visited.has(url.href)) continue;
    visited.add(url.href);
    if (url.pathname.endsWith(".json")) continue;
    const source = readFileSync(url, "utf8");
    const { outputText } = ts.transpileModule(source, {
      fileName: url.pathname,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    });
    for (const dependency of ts.preProcessFile(outputText, true, true).importedFiles) {
      if (dependency.fileName.startsWith(".")) pending.push(new URL(dependency.fileName, url));
    }
  }
  return visited;
}

test("cursor-shared's transitive runtime module graph cannot reach the single-account entry point", () => {
  const graph = runtimeModuleGraph(new URL("../cursor/cursor-shared.ts", import.meta.url));
  assert.ok(graph.has(new URL("../cursor/models.ts", import.meta.url).href));
  assert.equal(graph.has(new URL("../cursor/index.ts", import.meta.url).href), false);
});

test("the pure model module does not load authentication, proxy or extension entry points", () => {
  const graph = runtimeModuleGraph(new URL("../cursor/models.ts", import.meta.url));
  for (const file of ["auth.ts", "proxy.ts", "index.ts", "cursor-shared.ts"]) {
    assert.equal(graph.has(new URL(`../cursor/${file}`, import.meta.url).href), false, file);
  }
});
