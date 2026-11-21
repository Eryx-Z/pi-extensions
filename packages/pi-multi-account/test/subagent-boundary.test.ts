import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));

// Follow literal local imports, re-exports and dynamic imports. A direct-import
// assertion alone misses the same coupling hidden behind a provider helper.
function localModuleGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  function visit(path: string) {
    path = resolve(path);
    if (seen.has(path)) return;
    seen.add(path);
    if (!path.endsWith(".ts")) return;
    const stripped = stripTypeScriptTypes(readFileSync(path, "utf8"), { mode: "transform" } as unknown as Parameters<typeof stripTypeScriptTypes>[1]);
    const uncommented = stripped.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, "$1");
    const pattern = /(?:\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?|\bimport\s*\(\s*)["'](\.[^"']+)["']/g;
    for (const match of uncommented.matchAll(pattern)) {
      const spec = match[1];
      if (!spec) continue;
      const target = resolve(dirname(path), spec);
      const candidates = target.endsWith(".js")
        ? [target.slice(0, -3) + ".ts", target]
        : [target, target + ".ts", join(target, "index.ts")];
      const resolved = candidates.find((candidate) => existsSync(candidate));
      assert.ok(resolved, `unresolved local module: ${relative(root, path)} -> ${spec}`);
      visit(resolved);
    }
  }
  visit(join(root, entry));
  return new Set([...seen].map((path) => relative(root, path).replaceAll("\\", "/")));
}

test("provider-only RPC startup cannot reach parent failover, Cursor, Grok or commands", () => {
  const modules = localModuleGraph("subagent-provider.ts");
  const forbidden = [...modules].filter((path) =>
    path === "index.ts" || path === "cursor-bridge.ts" ||
    path === "model-catalog.ts" || path === "usage.ts" ||
    path === "fast-command.ts" || path === "failover-config.ts" ||
    path === "failover-state.ts" || path === "request-shaping.ts" ||
    path === "interrupted-turns.ts" || path === "cooldown.ts" || path === "pi-files.ts" ||
    path.startsWith("cursor/") || path.startsWith("grok/")
  );
  assert.deepEqual(forbidden, [], `unrelated parent modules loaded: ${forbidden.join(", ")}`);
});

for (const entry of ["index.ts", "subagent-provider.ts"]) {
  test(`every local module needed by ${entry} is included in the publish file list`, () => {
    const files: string[] = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).files;
    const missing = [...localModuleGraph(entry)].filter((path) =>
      !files.some((file) => path === file || path.startsWith(file + "/"))
    );
    assert.deepEqual(missing, [], `unpublished dependencies: ${missing.join(", ")}`);
  });
}
