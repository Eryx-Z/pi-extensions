import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const read = (relative: string) =>
	readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const shapingSource = read("../request-shaping.ts");

test("the Claude billing version is exactly one plain release constant", () => {
	const matches = [...shapingSource.matchAll(/CLAUDE_CODE_VERSION = "([^"]+)"/g)];
	assert.equal(matches.length, 1);
	assert.match(matches[0]![1]!, /^\d+\.\d+\.\d+$/);
});

test("the Claude version constant ships in the OAuth billing header", () => {
	assert.ok(shapingSource.includes("cc_version=${CLAUDE_CODE_VERSION}"));
});

// The old per-package Claude-version workflow is no longer in this repository.
// Exercise the actual release checker instead, including its refusal paths, in
// disposable packages so no source or user migration is rewritten by these tests.
function checkPackage(source: string) {
	const root = mkdtempSync(join(tmpdir(), "pmacct-release-check-"));
	const files = ["README.md", "CHANGELOG.md", "LICENSE", "SECURITY.md", "index.ts",
		"codex-fast.ts", "grok-cli-provider.ts", "grok/register.ts", "grok/auth/oauth.ts",
		"grok/LICENSE", "grok/NOTICE.md"];
	try {
		mkdirSync(join(root, "scripts"));
		writeFileSync(join(root, "scripts/check-package.mjs"), read("../scripts/check-package.mjs"));
		writeFileSync(join(root, "package.json"), JSON.stringify({
			name: "multi-account-release-fixture", version: "1.2.3", type: "module", files,
		}));
		for (const file of files) {
			mkdirSync(dirname(join(root, file)), { recursive: true });
			writeFileSync(join(root, file), file === "index.ts" ? source : "fixture\n");
		}
		return execFileSync(process.execPath, [join(root, "scripts/check-package.mjs")], {
			cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("the package checker accepts a release whose runtime version matches the manifest", () => {
	assert.match(checkPackage('const VERSION = "1.2.3";\n'), /package check: pass/);
});

test("the package checker rejects runtime/manifest version drift", () => {
	assert.throws(() => checkPackage('const VERSION = "1.2.2";\n'),
		/VERSION mismatch: index.ts says 1\.2\.2, package.json says 1\.2\.3/);
});

test("the package checker rejects a missing runtime version declaration", () => {
	assert.throws(() => checkPackage('export const renamedVersion = "1.2.3";\n'),
		/index.ts no longer declares/);
});
