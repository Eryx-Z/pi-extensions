import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyManualOnlyChanges,
  applyManualOnlyToFiles,
  getManualOnlyFromContent,
  resolveSelectors,
  resolveSkillSource,
  searchSkills,
  setManualOnlyInContent,
  splitCommandLine,
} from "./manager.ts";

const SKILL = `---
name: example-skill
description: Example
custom: keep-me # retain this comment
---

# Example

Body stays unchanged.
`;

test("adds the manual-only flag without changing existing frontmatter or body", () => {
  assert.equal(
    setManualOnlyInContent(SKILL, true),
    `---
name: example-skill
description: Example
custom: keep-me # retain this comment
disable-model-invocation: true
---

# Example

Body stays unchanged.
`,
  );
});

test("recognizes and updates a quoted top-level flag key without duplicating it", () => {
  const content = `---
name: quoted-example
description: Example
"disable-model-invocation": true # quoted key
---

# Quoted
`;

  assert.equal(getManualOnlyFromContent(content), true);
  assert.equal(
    setManualOnlyInContent(content, false),
    content.replace("true # quoted key", "false # quoted key"),
  );
});

test("ignores nested YAML keys with the same name as the top-level flag", () => {
  const content = `---
name: nested-example
description: Example
metadata:
  disable-model-invocation: true
---

# Nested
`;

  assert.equal(getManualOnlyFromContent(content), false);
  assert.equal(
    setManualOnlyInContent(content, true),
    content.replace("---\n\n# Nested", "disable-model-invocation: true\n---\n\n# Nested"),
  );
});

test("updates an existing flag while preserving its inline comment", () => {
  const content = SKILL.replace(
    "custom: keep-me # retain this comment",
    "disable-model-invocation: true # user preference",
  );
  const updated = setManualOnlyInContent(content, false);

  assert.equal(updated, content.replace("true # user preference", "false # user preference"));
  assert.equal(getManualOnlyFromContent(updated), false);
  assert.equal(getManualOnlyFromContent(content), true);
});

const SKILLS = [
  { name: "brainstorming", source: "superpowers", scope: "user" },
  { name: "test-driven-development", source: "superpowers", scope: "user" },
  { name: "project-deploy", source: "project-skills", scope: "project" },
];

test("parses quoted selectors in command arguments", () => {
  assert.deepEqual(splitCommandLine('manual "group:daily work" test-*'), [
    "manual",
    "group:daily work",
    "test-*",
  ]);
});

test("resolves exact names, globs, source groups, scopes, and custom groups as a union", () => {
  const groups = {
    quality: ["test-*", "group:project"],
    project: ["scope:project"],
  };

  const matches = resolveSelectors(
    SKILLS,
    ["brainstorming", "source:super*", "group:quality"],
    groups,
  );

  assert.deepEqual(matches.map((skill) => skill.name), [
    "brainstorming",
    "test-driven-development",
    "project-deploy",
  ]);
});

test("treats inherited object properties as unknown group names", () => {
  assert.throws(
    () => resolveSelectors([], ["group:constructor"], {}),
    /Unknown skill group: constructor/,
  );
});

test("aborts before writing when semantic frontmatter validation rejects an update", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-manager-validation-"));
  const path = join(directory, "flow.md");
  const original = `---
{name: flow, description: Flow, disable-model-invocation: false}
---

# Flow
`;
  await writeFile(path, original);

  try {
    await assert.rejects(
      applyManualOnlyChanges([{ path, manualOnly: true }], {
        validateContent: () => {
          throw new Error("updated frontmatter is invalid");
        },
      }),
      /updated frontmatter is invalid/,
    );
    assert.equal(await readFile(path, "utf8"), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("applies mixed manual-only states in one transaction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-manager-mixed-"));
  const first = join(directory, "first.md");
  const second = join(directory, "second.md");
  await writeFile(first, SKILL.replace("example-skill", "first"));
  await writeFile(
    second,
    setManualOnlyInContent(SKILL.replace("example-skill", "second"), true),
  );

  try {
    await applyManualOnlyChanges([
      { path: first, manualOnly: true },
      { path: second, manualOnly: false },
    ]);

    assert.equal(getManualOnlyFromContent(await readFile(first, "utf8")), true);
    assert.equal(getManualOnlyFromContent(await readFile(second, "utf8")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses to overwrite a skill changed after batch preparation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-manager-concurrent-"));
  const path = join(directory, "SKILL.md");
  const original = SKILL;
  const external = SKILL.replace("Body stays unchanged.", "Changed by another process.");
  await writeFile(path, original);
  let reads = 0;

  try {
    await assert.rejects(
      applyManualOnlyChanges([{ path, manualOnly: true }], {
        readCurrent: async (currentPath) => {
          reads++;
          if (reads === 2) await writeFile(currentPath, external);
          return readFile(currentPath, "utf8");
        },
      }),
      /changed concurrently/,
    );
    assert.equal(await readFile(path, "utf8"), external);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not overwrite a newer edit while rolling back another file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-manager-rollback-concurrent-"));
  const first = join(directory, "first.md");
  const second = join(directory, "second.md");
  const external = SKILL.replace("Body stays unchanged.", "Concurrent first-file edit.");
  await writeFile(first, SKILL.replace("example-skill", "first"));
  await writeFile(second, SKILL.replace("example-skill", "second"));

  try {
    await assert.rejects(
      applyManualOnlyToFiles([first, second], true, {
        replaceFile: async (path, content) => {
          if (path === second) {
            await writeFile(first, external);
            throw new Error("second write failed");
          }
          await writeFile(path, content);
        },
      }),
      /rollback was incomplete/,
    );
    assert.equal(await readFile(first, "utf8"), external);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rolls back earlier files when a batch update fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-manager-"));
  const first = join(directory, "first.md");
  const second = join(directory, "second.md");
  await writeFile(first, SKILL.replace("example-skill", "first"));
  await writeFile(second, SKILL.replace("example-skill", "second"));
  const firstOriginal = await readFile(first, "utf8");
  const secondOriginal = await readFile(second, "utf8");

  try {
    await assert.rejects(
      applyManualOnlyToFiles([first, second], true, {
        replaceFile: async (path, content) => {
          if (path === second && content.includes("disable-model-invocation: true")) {
            throw new Error("simulated disk failure");
          }
          await writeFile(path, content);
        },
      }),
      /simulated disk failure/,
    );

    assert.equal(await readFile(first, "utf8"), firstOriginal);
    assert.equal(await readFile(second, "utf8"), secondOriginal);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("resolves skill source from npm and git packages", () => {
  const npmSkill = resolveSkillSource(
    { name: "council-mode", sourceInfo: { source: "npm:pi-subagents", path: "/path/to/SKILL.md" } },
    "",
  );
  assert.equal(npmSkill.source, "pi-subagents");
  assert.ok(npmSkill.sources.includes("pi-subagents"));
  assert.ok(npmSkill.sources.includes("npm:pi-subagents"));

  const scopedNpm = resolveSkillSource(
    { name: "tool", sourceInfo: { source: "npm:@earendil-works/pi-tools", path: "/path/to/SKILL.md" } },
    "",
  );
  assert.equal(scopedNpm.source, "@earendil-works/pi-tools");
  assert.ok(scopedNpm.sources.includes("pi-tools"));

  const gitSkill = resolveSkillSource(
    {
      name: "token-usage",
      sourceInfo: {
        source: "git:https://github.com/Spike-Zz7/pi-token-usage.git@79fd17dadb1da8b4a8fd900fa999b58555763d07",
        path: "/path/to/SKILL.md",
      },
    },
    "",
  );
  assert.equal(gitSkill.source, "pi-token-usage");
  assert.ok(gitSkill.sources.includes("pi-token-usage"));
  assert.ok(gitSkill.sources.includes("Spike-Zz7/pi-token-usage"));
});

test("resolves skill source from multi-skill pack directories and author metadata", () => {
  const packSkill = resolveSkillSource(
    {
      name: "skill:ask-matt",
      sourceInfo: {
        source: "auto",
        path: "/home/user/.agents/skills/mattpocock-skills/skills/engineering/ask-matt/SKILL.md",
      },
    },
    "---\nname: ask-matt\ndescription: test\n---\n",
  );
  assert.equal(packSkill.source, "mattpocock-skills");
  assert.ok(packSkill.sources.includes("mattpocock-skills"));
  assert.ok(packSkill.sources.includes("auto"));

  const authorSkill = resolveSkillSource(
    {
      name: "skill:banner-design",
      sourceInfo: {
        source: "auto",
        path: "/home/user/.agents/skills/banner-design/SKILL.md",
      },
    },
    "---\nname: banner-design\nmetadata:\n  author: claudekit\n---\n",
  );
  assert.equal(authorSkill.source, "claudekit");
  assert.ok(authorSkill.sources.includes("claudekit"));
  assert.ok(authorSkill.sources.includes("banner-design"));

  const standaloneSkill = resolveSkillSource(
    {
      name: "skill:ui-ux-pro-max",
      sourceInfo: {
        source: "auto",
        path: "/home/user/.agents/skills/ui-ux-pro-max/SKILL.md",
      },
    },
    "---\nname: ui-ux-pro-max\n---\n",
  );
  assert.equal(standaloneSkill.source, "ui-ux-pro-max");
  assert.ok(standaloneSkill.sources.includes("ui-ux-pro-max"));

  const explicitSkill = resolveSkillSource(
    {
      name: "brainstorming",
      sourceInfo: { source: "auto", path: "/tmp/custom/SKILL.md" },
    },
    "---\nname: brainstorming\nsource: superpowers\n---\n",
  );
  assert.equal(explicitSkill.source, "superpowers");
  assert.ok(explicitSkill.sources.includes("superpowers"));
});

test("resolves selectors against canonical sources and aliases", () => {
  const skills = [
    {
      name: "banner-design",
      source: "claudekit",
      sources: ["claudekit", "banner-design", "auto"],
      scope: "user",
    },
    {
      name: "ask-matt",
      source: "mattpocock-skills",
      sources: ["mattpocock-skills", "auto"],
      scope: "user",
    },
    {
      name: "council-mode",
      source: "pi-subagents",
      sources: ["pi-subagents", "npm:pi-subagents"],
      scope: "user",
    },
  ];

  assert.deepEqual(
    resolveSelectors(skills, ["source:claudekit"]).map((s) => s.name),
    ["banner-design"],
  );
  assert.deepEqual(
    resolveSelectors(skills, ["source:banner-design"]).map((s) => s.name),
    ["banner-design"],
  );
  assert.deepEqual(
    resolveSelectors(skills, ["source:mattpocock*"]).map((s) => s.name),
    ["ask-matt"],
  );
  assert.deepEqual(
    resolveSelectors(skills, ["source:npm:pi-subagents"]).map((s) => s.name),
    ["council-mode"],
  );
  assert.deepEqual(
    resolveSelectors(skills, ["source:pi-subagents"]).map((s) => s.name),
    ["council-mode"],
  );
  assert.deepEqual(
    resolveSelectors(skills, ["source:auto"]).map((s) => s.name),
    ["banner-design", "ask-matt"],
  );

  assert.deepEqual(
    resolveSelectors(skills, ["all"]).map((s) => s.name),
    ["banner-design", "ask-matt", "council-mode"],
  );
  assert.deepEqual(
    resolveSelectors(skills, ["*"]).map((s) => s.name),
    ["banner-design", "ask-matt", "council-mode"],
  );
});

test("searchSkills searches by name, description, and source keywords", () => {
  const skills = [
    {
      name: "banner-design",
      description: "Design banners for social media and marketing ads",
      source: "claudekit",
      scope: "user",
    },
    {
      name: "code-review",
      description: "Review git pull requests and check code standards",
      source: "mattpocock-skills",
      scope: "user",
    },
    {
      name: "tdd",
      description: "Test-driven development red-green-refactor",
      source: "mattpocock-skills",
      scope: "user",
    },
  ];

  // Search by exact / substring of name
  assert.deepEqual(
    searchSkills(skills, "banner").map((s) => s.name),
    ["banner-design"],
  );

  // Search by description keyword
  assert.deepEqual(
    searchSkills(skills, "pull request").map((s) => s.name),
    ["code-review"],
  );

  // Search by source
  assert.deepEqual(
    searchSkills(skills, "claudekit").map((s) => s.name),
    ["banner-design"],
  );

  // Multi-term AND matching
  assert.deepEqual(
    searchSkills(skills, "matt review").map((s) => s.name),
    ["code-review"],
  );

  // Empty query returns all
  assert.equal(searchSkills(skills, "").length, 3);
  assert.equal(searchSkills(skills, "   ").length, 3);

  // No match
  assert.equal(searchSkills(skills, "nonexistent-query").length, 0);

  // resolveSelectors with $ search selector
  assert.deepEqual(
    resolveSelectors(skills, ["$pull request"]).map((s) => s.name),
    ["code-review"],
  );
  assert.deepEqual(
    resolveSelectors(skills, ["$banner"]).map((s) => s.name),
    ["banner-design"],
  );
});
