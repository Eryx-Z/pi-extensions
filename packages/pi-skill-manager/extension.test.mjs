import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import skillManagerExtension from "./extension.ts";
import { getManualOnlyFromContent } from "./manager.ts";

const SKILL = `---
name: alpha
description: Alpha skill
---

# Alpha
`;

function createHarness(skillPath, agentDir, extraSkills = [], optionOverrides = {}) {
  const commands = new Map();
  const handlers = new Map();
  const notifications = [];
  const editors = [];
  let reloads = 0;

  const pi = {
    getCommands: () => [
      {
        name: "skill:alpha",
        description: "Alpha skill",
        source: "skill",
        sourceInfo: {
          path: skillPath,
          source: "auto",
          scope: "user",
          origin: "top-level",
          baseDir: agentDir,
        },
      },
      ...extraSkills.map((skill) => ({
        name: `skill:${skill.name}`,
        description: `${skill.name} skill`,
        source: "skill",
        sourceInfo: {
          path: skill.path,
          source: skill.source ?? "auto",
          scope: skill.scope ?? "user",
          origin: skill.origin ?? "top-level",
          baseDir: agentDir,
        },
      })),
    ],
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
    on(name, handler) {
      handlers.set(name, handler);
    },
  };

  const ctx = {
    cwd: agentDir,
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => false,
    reload: async () => {
      reloads++;
    },
    ui: {
      theme: { fg: (_color, text) => text },
      notify: (message, level) => notifications.push([message, level]),
      setStatus: () => undefined,
      editor: async (title, content) => {
        editors.push([title, content]);
        return undefined;
      },
      input: async () => undefined,
      select: async () => undefined,
    },
  };

  skillManagerExtension(pi, {
    agentDir,
    configDirName: ".pi",
    ...optionOverrides,
  });
  return { commands, handlers, ctx, notifications, editors, get reloads() { return reloads; } };
}

test("manual command disables model invocation and reloads the runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-manager-extension-"));
  const skillPath = join(directory, "SKILL.md");
  await writeFile(skillPath, SKILL);

  try {
    const harness = createHarness(skillPath, directory);
    await harness.commands.get("skills-manager").handler("manual alpha", harness.ctx);

    assert.equal(getManualOnlyFromContent(await readFile(skillPath, "utf8")), true);
    assert.equal(harness.reloads, 1);
    assert.match(harness.notifications.at(-1)[0], /manual-only/);

    await harness.commands.get("skills-manager").handler("manual alpha", harness.ctx);
    assert.equal(harness.reloads, 1);
    assert.match(harness.notifications.at(-1)[0], /No skill files needed changes/);

    await harness.commands.get("skills-manager").handler("auto-on alpha", harness.ctx);
    assert.equal(getManualOnlyFromContent(await readFile(skillPath, "utf8")), false);
    assert.equal(harness.reloads, 2);
    assert.match(harness.notifications.at(-1)[0], /automatic/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("uses the injected Pi frontmatter parser to reject semantically invalid updates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-manager-parser-"));
  const skillPath = join(directory, "SKILL.md");
  await writeFile(skillPath, SKILL);

  try {
    const harness = createHarness(skillPath, directory, [], {
      parseSkillFrontmatter: () => ({ "disable-model-invocation": false }),
    });
    await harness.commands.get("skills-manager").handler("manual alpha", harness.ctx);

    assert.equal(await readFile(skillPath, "utf8"), SKILL);
    assert.equal(harness.reloads, 0);
    assert.match(harness.notifications.at(-1)[0], /semantic validation failed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("skips an unreadable virtual skill without blocking file-backed skills", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-manager-virtual-"));
  const skillPath = join(directory, "SKILL.md");
  await writeFile(skillPath, SKILL);

  try {
    const virtualPath = join(directory, "missing", "SKILL.md");
    const harness = createHarness(skillPath, directory, [
      { name: "virtual", path: virtualPath, source: "sdk", scope: "temporary" },
    ]);
    await harness.commands.get("skills-manager").handler("manual alpha", harness.ctx);

    assert.equal(getManualOnlyFromContent(await readFile(skillPath, "utf8")), true);
    assert.equal(harness.reloads, 1);
    assert.ok(harness.notifications.some(([message]) => message.includes("virtual") && message.includes("skipped")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TUI creates a global custom group and refreshes its count without reloading skills", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-manager-create-group-"));
  const skillPath = join(directory, "SKILL.md");
  await writeFile(skillPath, SKILL);

  try {
    const harness = createHarness(skillPath, directory);
    const selections = ["Manage custom groups…", "Global groups (0)", "Create group", "Back", undefined];
    const menus = [];
    harness.ctx.ui.select = async (title, options) => {
      menus.push([title, options]);
      return selections.shift();
    };
    harness.ctx.ui.input = async () => "quality";
    harness.ctx.ui.editor = async () => "alpha\nsource:auto\n";

    await harness.commands.get("skills-manager").handler("", harness.ctx);

    const config = JSON.parse(await readFile(join(directory, "skill-manager.json"), "utf8"));
    assert.deepEqual(config.groups.quality, ["alpha", "source:auto"]);
    assert.ok(menus.some(([, options]) => options.includes("Global groups (1)")));
    assert.equal(harness.reloads, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TUI silently cancels group creation when the name dialog is dismissed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-manager-create-cancel-"));
  const skillPath = join(directory, "SKILL.md");
  await writeFile(skillPath, SKILL);

  try {
    const harness = createHarness(skillPath, directory);
    const selections = ["Manage custom groups…", "Global groups (0)", "Create group", "Back", undefined];
    harness.ctx.ui.select = async () => selections.shift();
    harness.ctx.ui.input = async () => undefined;

    await harness.commands.get("skills-manager").handler("", harness.ctx);

    assert.equal(harness.notifications.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TUI edits global group selectors while preserving other config fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-manager-edit-group-"));
  const skillPath = join(directory, "SKILL.md");
  await writeFile(skillPath, SKILL);
  await writeFile(
    join(directory, "skill-manager.json"),
    JSON.stringify({ version: 1, groups: { quality: ["alpha"] } }),
  );

  try {
    const harness = createHarness(skillPath, directory);
    const selections = [
      "Manage custom groups…",
      "Global groups (1)",
      "Edit group",
      "quality",
      "Back",
      undefined,
    ];
    let editorInitialContent;
    harness.ctx.ui.select = async () => selections.shift();
    harness.ctx.ui.editor = async (_title, content) => {
      editorInitialContent = content;
      return "source:auto\nalpha";
    };

    await harness.commands.get("skills-manager").handler("", harness.ctx);

    const config = JSON.parse(await readFile(join(directory, "skill-manager.json"), "utf8"));
    assert.equal(editorInitialContent, "alpha");
    assert.equal(config.version, 1);
    assert.deepEqual(config.groups.quality, ["source:auto", "alpha"]);
    assert.equal(harness.reloads, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TUI refuses to overwrite group configuration changed while its editor was open", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-manager-group-concurrent-"));
  const skillPath = join(directory, "SKILL.md");
  const configPath = join(directory, "skill-manager.json");
  const external = { groups: { quality: ["beta"], external: ["alpha"] } };
  await writeFile(skillPath, SKILL);
  await writeFile(configPath, JSON.stringify({ groups: { quality: ["alpha"] } }));

  try {
    const harness = createHarness(skillPath, directory);
    const selections = ["Manage custom groups…", "Global groups (1)", "Edit group", "quality"];
    harness.ctx.ui.select = async () => selections.shift();
    harness.ctx.ui.editor = async () => {
      await writeFile(configPath, JSON.stringify(external));
      return "source:auto";
    };

    await harness.commands.get("skills-manager").handler("", harness.ctx);

    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), external);
    assert.match(harness.notifications.at(-1)[0], /changed while the group editor was open/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TUI refuses to write while another group editor holds the config lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-manager-document-lock-"));
  const skillPath = join(directory, "SKILL.md");
  const configPath = join(directory, "skill-manager.json");
  const original = JSON.stringify({ groups: { quality: ["alpha"] } });
  await writeFile(skillPath, SKILL);
  await writeFile(configPath, original);
  await writeFile(`${configPath}.lock`, "held");

  try {
    const harness = createHarness(skillPath, directory);
    const selections = ["Manage custom groups…", "Global groups (1)", "Edit group", "quality"];
    harness.ctx.ui.select = async () => selections.shift();
    harness.ctx.ui.editor = async () => "source:auto";

    await harness.commands.get("skills-manager").handler("", harness.ctx);

    assert.equal(await readFile(configPath, "utf8"), original);
    assert.match(harness.notifications.at(-1)[0], /another group editor is writing/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TUI rejects a concurrent change outside the groups field", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-manager-document-concurrent-"));
  const skillPath = join(directory, "SKILL.md");
  const configPath = join(directory, "skill-manager.json");
  const external = { version: 2, groups: { quality: ["alpha"] } };
  await writeFile(skillPath, SKILL);
  await writeFile(configPath, JSON.stringify({ version: 1, groups: { quality: ["alpha"] } }));

  try {
    const harness = createHarness(skillPath, directory);
    const selections = ["Manage custom groups…", "Global groups (1)", "Edit group", "quality"];
    harness.ctx.ui.select = async () => selections.shift();
    harness.ctx.ui.editor = async () => {
      await writeFile(configPath, JSON.stringify(external));
      return "source:auto";
    };

    await harness.commands.get("skills-manager").handler("", harness.ctx);

    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), external);
    assert.match(harness.notifications.at(-1)[0], /changed while the group editor was open/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TUI renames a global group and rewrites same-file group references", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-manager-rename-group-"));
  const skillPath = join(directory, "SKILL.md");
  await writeFile(skillPath, SKILL);
  await writeFile(
    join(directory, "skill-manager.json"),
    JSON.stringify({ groups: { quality: ["alpha"], suite: ["  group:quality  "] } }),
  );

  try {
    const harness = createHarness(skillPath, directory);
    const selections = [
      "Manage custom groups…",
      "Global groups (2)",
      "Rename group",
      "quality",
      "Back",
      undefined,
    ];
    harness.ctx.ui.select = async () => selections.shift();
    harness.ctx.ui.input = async () => "checks";

    await harness.commands.get("skills-manager").handler("", harness.ctx);

    const config = JSON.parse(await readFile(join(directory, "skill-manager.json"), "utf8"));
    assert.equal(config.groups.quality, undefined);
    assert.deepEqual(config.groups.checks, ["alpha"]);
    assert.deepEqual(config.groups.suite, ["  group:checks  "]);
    assert.equal(harness.reloads, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TUI rejects a global deletion when the project config adds a reference during confirmation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-manager-cross-file-concurrent-"));
  const agentDir = join(directory, "agent");
  const project = join(directory, "project");
  const projectConfigDir = join(project, ".pi");
  const globalPath = join(agentDir, "skill-manager.json");
  const projectPath = join(projectConfigDir, "skill-manager.json");
  const skillPath = join(project, "SKILL.md");
  const globalOriginal = { groups: { quality: ["alpha"] } };
  const projectExternal = { groups: { suite: ["group:quality"] } };
  await mkdir(agentDir);
  await mkdir(projectConfigDir, { recursive: true });
  await writeFile(skillPath, SKILL);
  await writeFile(globalPath, JSON.stringify(globalOriginal));
  await writeFile(projectPath, JSON.stringify({ groups: {} }));

  try {
    const harness = createHarness(skillPath, agentDir);
    harness.ctx.cwd = project;
    harness.ctx.isProjectTrusted = () => true;
    const selections = [
      "Manage custom groups…",
      "Global groups (1)",
      "Delete group",
      "quality",
    ];
    harness.ctx.ui.select = async () => selections.shift();
    harness.ctx.ui.confirm = async () => {
      await writeFile(projectPath, JSON.stringify(projectExternal));
      return true;
    };

    await harness.commands.get("skills-manager").handler("", harness.ctx);

    assert.deepEqual(JSON.parse(await readFile(globalPath, "utf8")), globalOriginal);
    assert.deepEqual(JSON.parse(await readFile(projectPath, "utf8")), projectExternal);
    assert.match(harness.notifications.at(-1)[0], /changed while the group editor was open/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TUI safely renames a group to __proto__ without dropping its definition", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-manager-proto-group-"));
  const skillPath = join(directory, "SKILL.md");
  const configPath = join(directory, "skill-manager.json");
  await writeFile(skillPath, SKILL);
  await writeFile(configPath, JSON.stringify({ groups: { quality: ["alpha"] } }));

  try {
    const harness = createHarness(skillPath, directory);
    const selections = [
      "Manage custom groups…",
      "Global groups (1)",
      "Rename group",
      "quality",
      "Back",
      undefined,
    ];
    harness.ctx.ui.select = async () => selections.shift();
    harness.ctx.ui.input = async () => "__proto__";

    await harness.commands.get("skills-manager").handler("", harness.ctx);

    const groups = JSON.parse(await readFile(configPath, "utf8")).groups;
    assert.equal(Object.hasOwn(groups, "quality"), false);
    assert.equal(Object.hasOwn(groups, "__proto__"), true);
    assert.deepEqual(groups.__proto__, ["alpha"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TUI deletes an unreferenced global group after confirmation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-manager-delete-group-"));
  const skillPath = join(directory, "SKILL.md");
  await writeFile(skillPath, SKILL);
  await writeFile(
    join(directory, "skill-manager.json"),
    JSON.stringify({ groups: { quality: ["alpha"] } }),
  );

  try {
    const harness = createHarness(skillPath, directory);
    const selections = [
      "Manage custom groups…",
      "Global groups (1)",
      "Delete group",
      "quality",
      "Back",
      undefined,
    ];
    harness.ctx.ui.select = async () => selections.shift();
    harness.ctx.ui.confirm = async () => true;

    await harness.commands.get("skills-manager").handler("", harness.ctx);

    const config = JSON.parse(await readFile(join(directory, "skill-manager.json"), "utf8"));
    assert.deepEqual(config.groups, {});
    assert.equal(harness.reloads, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TUI blocks deleting a group that another visible group references", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-manager-delete-referenced-"));
  const skillPath = join(directory, "SKILL.md");
  const configPath = join(directory, "skill-manager.json");
  const original = JSON.stringify({ groups: { quality: ["alpha"], suite: ["group:quality"] } });
  await writeFile(skillPath, SKILL);
  await writeFile(configPath, original);

  try {
    const harness = createHarness(skillPath, directory);
    const selections = [
      "Manage custom groups…",
      "Global groups (2)",
      "Delete group",
      "quality",
      "Back",
      undefined,
    ];
    let confirms = 0;
    harness.ctx.ui.select = async () => selections.shift();
    harness.ctx.ui.confirm = async () => {
      confirms++;
      return true;
    };

    await harness.commands.get("skills-manager").handler("", harness.ctx);

    assert.equal(await readFile(configPath, "utf8"), original);
    assert.equal(confirms, 0);
    assert.ok(harness.notifications.some(([message]) => /suite.*references.*quality/.test(message)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TUI refuses to save a custom group with an unknown group reference", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-manager-invalid-group-"));
  const skillPath = join(directory, "SKILL.md");
  const configPath = join(directory, "skill-manager.json");
  await writeFile(skillPath, SKILL);
  await writeFile(configPath, JSON.stringify({ version: 1, groups: {} }));

  try {
    const harness = createHarness(skillPath, directory);
    const selections = ["Manage custom groups…", "Global groups (0)", "Create group"];
    harness.ctx.ui.select = async () => selections.shift();
    harness.ctx.ui.input = async () => "broken";
    harness.ctx.ui.editor = async () => "group:missing";

    await harness.commands.get("skills-manager").handler("", harness.ctx);

    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
      version: 1,
      groups: {},
    });
    assert.match(harness.notifications.at(-1)[0], /Unknown skill group: missing/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TUI creates a project group at the Git root without changing global groups", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-manager-project-create-"));
  const agentDir = join(directory, "agent");
  const repo = join(directory, "repo");
  const cwd = join(repo, "src");
  const skillPath = join(repo, "SKILL.md");
  const globalPath = join(agentDir, "skill-manager.json");
  await mkdir(agentDir);
  await mkdir(cwd, { recursive: true });
  await mkdir(join(repo, ".git"));
  await writeFile(skillPath, SKILL);
  await writeFile(globalPath, JSON.stringify({ groups: { global: ["alpha"] } }));

  try {
    const harness = createHarness(skillPath, agentDir);
    harness.ctx.cwd = cwd;
    harness.ctx.isProjectTrusted = () => true;
    const selections = [
      "Manage custom groups…",
      "Project groups (0)",
      "Create group",
      "Back",
      undefined,
    ];
    harness.ctx.ui.select = async () => selections.shift();
    harness.ctx.ui.input = async () => "project-quality";
    harness.ctx.ui.editor = async () => "group:global";

    await harness.commands.get("skills-manager").handler("", harness.ctx);

    const projectConfig = JSON.parse(
      await readFile(join(repo, ".pi", "skill-manager.json"), "utf8"),
    );
    assert.deepEqual(projectConfig.groups, { "project-quality": ["group:global"] });
    assert.deepEqual(JSON.parse(await readFile(globalPath, "utf8")).groups, {
      global: ["alpha"],
    });
    assert.equal(harness.reloads, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TUI can set an automatic source group to manual-only in one action", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-manager-tui-"));
  const alphaPath = join(directory, "alpha.md");
  const betaPath = join(directory, "beta.md");
  await writeFile(alphaPath, SKILL);
  await writeFile(betaPath, SKILL.replaceAll("alpha", "beta").replace("Alpha", "Beta"));

  try {
    const harness = createHarness(alphaPath, directory, [{ name: "beta", path: betaPath }]);
    const selections = ["Source: auto (2)", "Set all to manual-only"];
    harness.ctx.ui.select = async () => selections.shift();

    await harness.commands.get("skills-manager").handler("", harness.ctx);

    assert.equal(getManualOnlyFromContent(await readFile(alphaPath, "utf8")), true);
    assert.equal(getManualOnlyFromContent(await readFile(betaPath, "utf8")), true);
    assert.equal(harness.reloads, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TUI batches an arbitrary selector-filtered result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-manager-selector-tui-"));
  const alphaPath = join(directory, "alpha.md");
  const betaPath = join(directory, "beta.md");
  await writeFile(alphaPath, SKILL);
  await writeFile(betaPath, SKILL.replaceAll("alpha", "beta").replace("Alpha", "Beta"));

  try {
    const harness = createHarness(alphaPath, directory, [{ name: "beta", path: betaPath }]);
    const selections = ["Custom selectors…", "Set all to manual-only"];
    harness.ctx.ui.select = async () => selections.shift();
    harness.ctx.ui.input = async () => "a*";

    await harness.commands.get("skills-manager").handler("", harness.ctx);

    assert.equal(getManualOnlyFromContent(await readFile(alphaPath, "utf8")), true);
    assert.equal(getManualOnlyFromContent(await readFile(betaPath, "utf8")), false);
    assert.equal(harness.reloads, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TUI stages individual changes and applies them together", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-manager-individual-"));
  const alphaPath = join(directory, "alpha.md");
  const betaPath = join(directory, "beta.md");
  await writeFile(alphaPath, SKILL);
  await writeFile(betaPath, SKILL.replaceAll("alpha", "beta").replace("Alpha", "Beta"));

  try {
    const harness = createHarness(alphaPath, directory, [{ name: "beta", path: betaPath }]);
    const selections = [
      "All skills (2)",
      "Edit individually",
      "alpha [automatic]",
      "Apply changes (1)",
    ];
    harness.ctx.ui.select = async () => selections.shift();

    await harness.commands.get("skills-manager").handler("", harness.ctx);

    assert.equal(getManualOnlyFromContent(await readFile(alphaPath, "utf8")), true);
    assert.equal(getManualOnlyFromContent(await readFile(betaPath, "utf8")), false);
    assert.equal(harness.reloads, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("list and groups commands show states and automatic/custom groups", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-manager-list-"));
  const alphaPath = join(directory, "alpha.md");
  const betaPath = join(directory, "beta.md");
  await writeFile(alphaPath, SKILL);
  await writeFile(
    betaPath,
    setManualOnlyInFixture(SKILL.replaceAll("alpha", "beta").replace("Alpha", "Beta")),
  );
  await writeFile(
    join(directory, "skill-manager.json"),
    JSON.stringify({ groups: { quality: ["alpha", "beta"] } }),
  );

  try {
    const harness = createHarness(alphaPath, directory, [{ name: "beta", path: betaPath }]);
    const command = harness.commands.get("skills-manager");
    await command.handler("list", harness.ctx);
    await command.handler("groups", harness.ctx);

    assert.match(harness.editors[0][1], /alpha.*automatic/);
    assert.match(harness.editors[0][1], /beta.*manual-only/);
    assert.match(harness.editors[1][1], /Source: auto \(2\)/);
    assert.match(harness.editors[1][1], /Custom: quality \(2\)/);
    assert.equal(harness.reloads, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function setManualOnlyInFixture(content) {
  return content.replace("description: Beta skill", "description: Beta skill\ndisable-model-invocation: true");
}

test("list and groups reject modes without dialog UI", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-manager-no-ui-"));
  const skillPath = join(directory, "SKILL.md");
  await writeFile(skillPath, SKILL);

  try {
    const harness = createHarness(skillPath, directory);
    harness.ctx.hasUI = false;
    await harness.commands.get("skills-manager").handler("list", harness.ctx);

    assert.equal(harness.editors.length, 0);
    assert.match(harness.notifications.at(-1)[0], /requires dialog UI/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("trusted project groups override same-named global groups", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-manager-project-group-"));
  const alphaPath = join(directory, "alpha.md");
  const betaPath = join(directory, "beta.md");
  await writeFile(alphaPath, SKILL);
  await writeFile(betaPath, SKILL.replaceAll("alpha", "beta").replace("Alpha", "Beta"));
  await writeFile(
    join(directory, "skill-manager.json"),
    JSON.stringify({ groups: { quality: ["alpha"] } }),
  );
  await mkdir(join(directory, ".pi"));
  await mkdir(join(directory, "src", "nested"), { recursive: true });
  await writeFile(
    join(directory, ".pi", "skill-manager.json"),
    JSON.stringify({ groups: { quality: ["beta"] } }),
  );

  try {
    const harness = createHarness(alphaPath, directory, [{ name: "beta", path: betaPath }]);
    harness.ctx.cwd = join(directory, "src", "nested");
    harness.ctx.isProjectTrusted = () => true;
    await harness.commands.get("skills-manager").handler("manual group:quality", harness.ctx);

    assert.equal(getManualOnlyFromContent(await readFile(alphaPath, "utf8")), false);
    assert.equal(getManualOnlyFromContent(await readFile(betaPath, "utf8")), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("project group lookup does not escape the nearest Git repository", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-manager-boundary-"));
  const agentDir = join(directory, "agent");
  const repo = join(directory, "repo");
  const cwd = join(repo, "src");
  const skillPath = join(repo, "SKILL.md");
  await mkdir(agentDir);
  await mkdir(cwd, { recursive: true });
  await mkdir(join(repo, ".git"));
  await mkdir(join(directory, ".pi"));
  await writeFile(skillPath, SKILL);
  await writeFile(
    join(directory, ".pi", "skill-manager.json"),
    JSON.stringify({ groups: { outside: ["alpha"] } }),
  );

  try {
    const harness = createHarness(skillPath, agentDir);
    harness.ctx.cwd = cwd;
    harness.ctx.isProjectTrusted = () => true;
    await harness.commands.get("skills-manager").handler("manual group:outside", harness.ctx);

    assert.equal(getManualOnlyFromContent(await readFile(skillPath, "utf8")), false);
    assert.equal(harness.reloads, 0);
    assert.match(harness.notifications.at(-1)[0], /Unknown skill group: outside/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("custom groups apply one command to multiple skills", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-manager-group-"));
  const alphaPath = join(directory, "alpha.md");
  const betaPath = join(directory, "beta.md");
  await writeFile(alphaPath, SKILL);
  await writeFile(betaPath, SKILL.replaceAll("alpha", "beta").replace("Alpha", "Beta"));
  await writeFile(
    join(directory, "skill-manager.json"),
    JSON.stringify({ groups: { quality: ["alpha", "beta"] } }),
  );

  try {
    const harness = createHarness(alphaPath, directory, [{ name: "beta", path: betaPath }]);
    await harness.commands.get("skills-manager").handler("manual group:quality", harness.ctx);

    assert.equal(getManualOnlyFromContent(await readFile(alphaPath, "utf8")), true);
    assert.equal(getManualOnlyFromContent(await readFile(betaPath, "utf8")), true);
    assert.equal(harness.reloads, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("supports aliases /manager, /skills, /skill-manager, and natural commands on/off/toggle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-manager-aliases-"));
  const alphaPath = join(directory, "alpha.md");
  const betaPath = join(directory, "beta.md");
  await writeFile(alphaPath, SKILL);
  await writeFile(betaPath, SKILL.replaceAll("alpha", "beta").replace("Alpha", "Beta"));

  try {
    const harness = createHarness(alphaPath, directory, [{ name: "beta", path: betaPath }]);

    // Aliases must be registered
    assert.ok(harness.commands.has("manager"));
    assert.ok(harness.commands.has("skills"));
    assert.ok(harness.commands.has("skill-manager"));

    const managerCmd = harness.commands.get("manager");

    // 1. /manager off alpha
    await managerCmd.handler("off alpha", harness.ctx);
    assert.equal(getManualOnlyFromContent(await readFile(alphaPath, "utf8")), true);
    assert.equal(harness.reloads, 1);

    // 2. /manager on alpha
    await managerCmd.handler("on alpha", harness.ctx);
    assert.equal(getManualOnlyFromContent(await readFile(alphaPath, "utf8")), false);
    assert.equal(harness.reloads, 2);

    // 3. /manager toggle beta
    await managerCmd.handler("toggle beta", harness.ctx);
    assert.equal(getManualOnlyFromContent(await readFile(betaPath, "utf8")), true);
    assert.equal(harness.reloads, 3);

    // 4. Direct toggle by skill name: /manager beta
    await managerCmd.handler("beta", harness.ctx);
    assert.equal(getManualOnlyFromContent(await readFile(betaPath, "utf8")), false);
    assert.equal(harness.reloads, 4);

    // 5. /manager all-off
    await managerCmd.handler("all-off", harness.ctx);
    assert.equal(getManualOnlyFromContent(await readFile(alphaPath, "utf8")), true);
    assert.equal(getManualOnlyFromContent(await readFile(betaPath, "utf8")), true);
    assert.equal(harness.reloads, 5);

    // 6. /manager all-on
    await managerCmd.handler("all-on", harness.ctx);
    assert.equal(getManualOnlyFromContent(await readFile(alphaPath, "utf8")), false);
    assert.equal(getManualOnlyFromContent(await readFile(betaPath, "utf8")), false);
    assert.equal(harness.reloads, 6);

    // 7. /manager status
    await managerCmd.handler("status", harness.ctx);
    assert.match(harness.notifications.at(-1)[0], /Skills:/);

    // 8. /manager search <query> with interactive UI toggle
    harness.ctx.ui.select = async (_title, options) => {
      // Find the option containing alpha and select it
      const match = options.find((opt) => opt.includes("alpha"));
      return match;
    };
    await managerCmd.handler("search alpha", harness.ctx);
    assert.equal(getManualOnlyFromContent(await readFile(alphaPath, "utf8")), true);
    assert.equal(harness.reloads, 7);

    // 9. Direct input without "search" keyword is search: /manager alp
    harness.ctx.ui.select = async (_title, options) => {
      const match = options.find((opt) => opt.includes("alpha"));
      return match;
    };
    await managerCmd.handler("alp", harness.ctx);
    assert.equal(getManualOnlyFromContent(await readFile(alphaPath, "utf8")), false);
    assert.equal(harness.reloads, 8);

    // 10. $ prefix search: /manager $alp
    harness.ctx.ui.select = async (_title, options) => {
      const match = options.find((opt) => opt.includes("alpha"));
      return match;
    };
    await managerCmd.handler("$alp", harness.ctx);
    assert.equal(getManualOnlyFromContent(await readFile(alphaPath, "utf8")), true);
    assert.equal(harness.reloads, 9);

    // 11. $ in selectors: /manager on $alp
    await managerCmd.handler("on $alp", harness.ctx);
    assert.equal(getManualOnlyFromContent(await readFile(alphaPath, "utf8")), false);
    assert.equal(harness.reloads, 10);

    // 12. Autocomplete provider registers on session_start
    let registeredProvider = null;
    const sessionCtx = {
      hasUI: true,
      ui: {
        addAutocompleteProvider(provider) {
          registeredProvider = provider({
            getSuggestions: async () => null,
            applyCompletion: () => {},
          });
        },
      },
    };
    const sessionStartHandler = harness.handlers.get("session_start");
    assert.ok(sessionStartHandler, "session_start handler registered");
    await sessionStartHandler({}, sessionCtx);
    assert.ok(registeredProvider, "autocomplete provider registered");
    assert.deepEqual(registeredProvider.triggerCharacters, ["$"]);

    const suggestions = await registeredProvider.getSuggestions(["test $alp"], 0, 9, {});
    assert.equal(suggestions.prefix, "$alp");
    assert.equal(suggestions.items.length, 1);
    assert.equal(suggestions.items[0].value, "$alpha");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
