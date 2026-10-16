import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FileHandle } from "node:fs/promises";
import type { Groups, MutationOptions, SourceOptions, SkillSummary } from "./manager.ts";
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  applyManualOnlyChanges,
  applyManualOnlyToFiles,
  getManualOnlyFromContent,
  resolveSelectors,
  resolveSkillSource,
  searchSkills,
  splitCommandLine,
} from "./manager.ts";

interface ManagerOptions extends SourceOptions {
  agentDir: string;
  configDirName: string;
}

interface Skill extends SkillSummary {
  description: string;
  path: string;
  source: string;
  sources: string[];
  manualOnly: boolean;
  origin?: string;
  baseDir?: string;
}

interface ExpectedDocument {
  path: string;
  content: string | undefined;
}

interface GroupScope {
  label: string;
  name: string;
  path: string;
  groups: Groups;
  guardDocuments: ExpectedDocument[];
  validationGroupSets: (candidate: Groups) => Groups[];
  visibleGroupSets?: Groups[];
}

async function readGroupsDocument(path: string) {
  let content: string | undefined;
  let parsed: unknown;
  try {
    content = await readFile(path, "utf8");
    parsed = JSON.parse(content);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      content = undefined;
      parsed = {};
    } else {
      throw error;
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path}: expected a JSON object`);
  }
  const document = parsed as Record<string, unknown>;
  const groups = document.groups ?? {};
  if (!groups || typeof groups !== "object" || Array.isArray(groups)) {
    throw new Error(`${path}: groups must be an object`);
  }
  for (const [name, selectors] of Object.entries(groups)) {
    if (!Array.isArray(selectors) || selectors.some((selector) => typeof selector !== "string")) {
      throw new Error(`${path}: group ${name} must be an array of selectors`);
    }
  }
  return { content, document, groups: groups as Groups };
}

async function readGroupsFile(path: string) {
  return (await readGroupsDocument(path)).groups;
}

let groupsTemporaryFileCounter = 0;

async function readOptionalText(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function assertGroupDocumentsUnchanged(expectedDocuments: ExpectedDocument[]) {
  for (const expected of expectedDocuments) {
    if ((await readOptionalText(expected.path)) !== expected.content) {
      throw new Error(`${expected.path}: changed while the group editor was open`);
    }
  }
}

async function writeGroupsFile(path: string, groups: Groups, expectedDocuments: ExpectedDocument[]) {
  const documents = [...new Map(expectedDocuments.map((item) => [item.path, item])).values()]
    .sort((left, right) => left.path.localeCompare(right.path));
  const locks: { handle: FileHandle; lockPath: string }[] = [];
  const temporaryPath = join(
    dirname(path),
    `.skill-manager-groups-${process.pid}-${groupsTemporaryFileCounter++}.tmp`,
  );

  try {
    for (const document of documents) {
      await mkdir(dirname(document.path), { recursive: true });
      const lockPath = `${document.path}.lock`;
      try {
        const handle = await open(lockPath, "wx", 0o600);
        locks.push({ handle, lockPath });
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
          throw new Error(`${document.path}: another group editor is writing this config`);
        }
        throw error;
      }
    }

    await assertGroupDocumentsUnchanged(documents);
    const { document } = await readGroupsDocument(path);
    let mode = 0o600;
    try {
      mode = (await stat(path)).mode;
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    await writeFile(temporaryPath, `${JSON.stringify({ ...document, groups }, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode,
    });
    await chmod(temporaryPath, mode);

    await assertGroupDocumentsUnchanged(documents);
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  } finally {
    for (const lock of locks.reverse()) {
      await lock.handle.close().catch(() => undefined);
      await unlink(lock.lockPath).catch(() => undefined);
    }
  }
}

async function resolveProjectGroupsPath(cwd: string, configDirName: string) {
  const start = resolve(cwd);
  let directory = start;
  const home = resolve(homedir());
  while (true) {
    const configDirectory = join(directory, configDirName);
    try {
      if ((await stat(configDirectory)).isDirectory()) {
        return join(configDirectory, "skill-manager.json");
      }
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
    }

    try {
      await stat(join(directory, ".git"));
      return join(configDirectory, "skill-manager.json");
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
    }

    const parent = dirname(directory);
    if (directory === home || parent === directory) {
      return join(start, configDirName, "skill-manager.json");
    }
    directory = parent;
  }
}

async function loadGroups(ctx: ExtensionContext, options: ManagerOptions) {
  const globalGroups = await readGroupsFile(join(options.agentDir, "skill-manager.json"));
  if (!ctx.isProjectTrusted()) return globalGroups;
  const projectPath = await resolveProjectGroupsPath(ctx.cwd, options.configDirName);
  const projectGroups = await readGroupsFile(projectPath);
  return { ...globalGroups, ...projectGroups };
}

function buildAutomaticGroups(skills: Skill[], customGroups: Groups) {
  const groups = new Map([[`All skills (${skills.length})`, skills]]);
  for (const scope of [...new Set(skills.map((skill) => skill.scope))].sort()) {
    const members = skills.filter((skill) => skill.scope === scope);
    groups.set(`Scope: ${scope} (${members.length})`, members);
  }
  for (const source of [...new Set(skills.map((skill) => skill.source))].sort()) {
    const members = skills.filter((skill) => skill.source === source);
    groups.set(`Source: ${source} (${members.length})`, members);
  }
  for (const name of Object.keys(customGroups).sort()) {
    const members = resolveSelectors(skills, [`group:${name}`], customGroups);
    groups.set(`Custom: ${name} (${members.length})`, members);
  }
  return groups;
}

function mutationOptions(options: ManagerOptions): MutationOptions {
  if (!options.parseSkillFrontmatter) return {};
  return {
    validateContent(content, expectedManualOnly, path) {
      const frontmatter = options.parseSkillFrontmatter!(content);
      if (frontmatter["disable-model-invocation"] !== expectedManualOnly) {
        throw new Error(`${path}: semantic validation failed for disable-model-invocation`);
      }
    },
  };
}

async function discoverSkills(pi: ExtensionAPI, options: ManagerOptions, ctx: ExtensionContext) {
  const skills: Skill[] = [];
  for (const command of pi.getCommands()) {
    if (command.source !== "skill") continue;
    const name = command.name.startsWith("skill:") ? command.name.slice(6) : command.name;
    const path = command.sourceInfo?.path;
    if (!path) continue;

    try {
      const content = await readFile(path, "utf8");
      const { source, sources } = resolveSkillSource(command, content, options);
      skills.push({
        name,
        description: command.description ?? "",
        path,
        source,
        sources,
        scope: command.sourceInfo.scope,
        origin: command.sourceInfo.origin,
        baseDir: command.sourceInfo.baseDir,
        manualOnly: options.parseSkillFrontmatter
          ? options.parseSkillFrontmatter(content)["disable-model-invocation"] === true
          : getManualOnlyFromContent(content),
      });
    } catch (error) {
      ctx.ui.notify(
        `Skill ${name} skipped: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

async function updateAndReload(skills: Skill[], manualOnly: boolean, ctx: ExtensionCommandContext, options: ManagerOptions) {
  const changedPaths = await applyManualOnlyToFiles(
    skills.map((skill) => skill.path),
    manualOnly,
    mutationOptions(options),
  );
  if (changedPaths.length === 0) {
    ctx.ui.notify("No skill files needed changes", "info");
    return;
  }
  ctx.ui.notify(
    `${changedPaths.length} skill(s) set to ${manualOnly ? "manual-only" : "automatic"}; reloading`,
    "info",
  );
  await ctx.reload();
}

async function editIndividually(skills: Skill[], ctx: ExtensionCommandContext, options: ManagerOptions) {
  const staged = new Map(skills.map((skill) => [skill.path, skill.manualOnly]));

  while (true) {
    const changed = skills.filter((skill) => staged.get(skill.path) !== skill.manualOnly);
    const applyLabel = `Apply changes (${changed.length})`;
    const labels = new Map(
      skills.map((skill) => [
        `${skill.name} [${staged.get(skill.path) ? "manual-only" : "automatic"}]`,
        skill,
      ]),
    );
    const choice = await ctx.ui.select("Toggle individual skills", [
      applyLabel,
      "Cancel",
      ...labels.keys(),
    ]);

    if (!choice || choice === "Cancel") return;
    if (choice === applyLabel) {
      if (changed.length === 0) {
        ctx.ui.notify("No skill states changed", "info");
        return;
      }
      await applyManualOnlyChanges(
        changed.map((skill) => ({ path: skill.path, manualOnly: staged.get(skill.path)! })),
        mutationOptions(options),
      );
      ctx.ui.notify(`${changed.length} skill(s) updated; reloading`, "info");
      await ctx.reload();
      return;
    }

    const skill = labels.get(choice);
    if (skill) staged.set(skill.path, !staged.get(skill.path));
  }
}

function findGroupReferences(groupSets: Groups[], targetName: string) {
  const references = new Set<string>();
  for (const groups of groupSets) {
    for (const [name, selectors] of Object.entries(groups)) {
      if (
        name !== targetName &&
        selectors.some((selector) => selector.trim() === `group:${targetName}`)
      ) {
        references.add(name);
      }
    }
  }
  return [...references].sort();
}

function renameGroup(groups: Groups, oldName: string, newName: string) {
  const renamed: Groups = Object.create(null);
  for (const [name, selectors] of Object.entries(groups)) {
    renamed[name === oldName ? newName : name] = selectors.map((selector) => {
      if (selector.trim() !== `group:${oldName}`) return selector;
      const leadingWhitespace = selector.match(/^\s*/)?.[0] ?? "";
      const trailingWhitespace = selector.match(/\s*$/)?.[0] ?? "";
      return `${leadingWhitespace}group:${newName}${trailingWhitespace}`;
    });
  }
  return renamed;
}

function selectorsFromEditor(content: string) {
  return content
    .split(/\r?\n/)
    .map((selector) => selector.trim())
    .filter(Boolean);
}

function validateGroupGraph(groups: Groups) {
  for (const name of Object.keys(groups)) {
    resolveSelectors([], [`group:${name}`], groups);
  }
}

async function writeScopedGroups(scope: GroupScope, groups: Groups) {
  for (const resolutionGroups of scope.validationGroupSets(groups)) {
    validateGroupGraph(resolutionGroups);
  }
  await writeGroupsFile(scope.path, groups, scope.guardDocuments);
}

async function manageGroupScope(ctx: ExtensionContext, scope: GroupScope) {
  const groupNames = Object.keys(scope.groups).sort();
  const actions = ["Create group"];
  if (groupNames.length > 0) actions.push("Edit group", "Rename group", "Delete group");
  actions.push("Back");
  const action = await ctx.ui.select(`Manage ${scope.name} groups`, actions);
  if (!action || action === "Back") return;

  if (action === "Create group") {
    const inputName = await ctx.ui.input("New group name", "Example: quality");
    if (inputName === undefined) return;
    const name = inputName.trim();
    if (!name) {
      ctx.ui.notify("Group name cannot be empty", "warning");
      return;
    }
    if (Object.hasOwn(scope.groups, name)) {
      ctx.ui.notify(`Group already exists: ${name}`, "warning");
      return;
    }
    const selectorDocument = await ctx.ui.editor(`Selectors for ${name} (one per line)`, "");
    if (selectorDocument === undefined) return;
    await writeScopedGroups(scope, {
      ...scope.groups,
      [name]: selectorsFromEditor(selectorDocument),
    });
    ctx.ui.notify(`Created ${scope.name} group: ${name}`, "info");
    return;
  }

  if (action === "Edit group") {
    const name = await ctx.ui.select("Choose a group to edit", groupNames);
    if (!name) return;
    const selectorDocument = await ctx.ui.editor(
      `Selectors for ${name} (one per line)`,
      scope.groups[name].join("\n"),
    );
    if (selectorDocument === undefined) return;
    await writeScopedGroups(scope, {
      ...scope.groups,
      [name]: selectorsFromEditor(selectorDocument),
    });
    ctx.ui.notify(`Updated ${scope.name} group: ${name}`, "info");
    return;
  }

  if (action === "Rename group") {
    const oldName = await ctx.ui.select("Choose a group to rename", groupNames);
    if (!oldName) return;
    const inputName = await ctx.ui.input("New group name", oldName);
    if (inputName === undefined) return;
    const newName = inputName.trim();
    if (!newName) {
      ctx.ui.notify("Group name cannot be empty", "warning");
      return;
    }
    if (newName !== oldName && Object.hasOwn(scope.groups, newName)) {
      ctx.ui.notify(`Group already exists: ${newName}`, "warning");
      return;
    }
    if (newName === oldName) {
      ctx.ui.notify("Group name was not changed", "info");
      return;
    }
    await writeScopedGroups(scope, renameGroup(scope.groups, oldName, newName));
    ctx.ui.notify(`Renamed ${scope.name} group: ${oldName} → ${newName}`, "info");
    return;
  }

  if (action === "Delete group") {
    const name = await ctx.ui.select("Choose a group to delete", groupNames);
    if (!name) return;
    const references = findGroupReferences(scope.visibleGroupSets!, name);
    if (references.length > 0) {
      ctx.ui.notify(
        `Group ${references.join(", ")} references ${name}; delete is blocked`,
        "warning",
      );
      return;
    }
    const confirmed = await ctx.ui.confirm(
      `Delete ${scope.name} group ${name}?`,
      "This removes only the group definition; Skill files are unchanged.",
    );
    if (!confirmed) return;
    const remaining = { ...scope.groups };
    delete remaining[name];
    await writeScopedGroups(scope, remaining);
    ctx.ui.notify(`Deleted ${scope.name} group: ${name}`, "info");
  }
}

async function manageCustomGroups(ctx: ExtensionContext, options: ManagerOptions) {
  const globalPath = join(options.agentDir, "skill-manager.json");

  while (true) {
    const globalDocument = await readGroupsDocument(globalPath);
    const globalGroups = globalDocument.groups;
    const scopes: GroupScope[] = [
      {
        label: `Global groups (${Object.keys(globalGroups).length})`,
        name: "global",
        path: globalPath,
        groups: globalGroups,
        guardDocuments: [{ path: globalPath, content: globalDocument.content }],
        validationGroupSets: (candidate) => [candidate],
      },
    ];

    let projectGroups: Groups | undefined;
    if (ctx.isProjectTrusted()) {
      const projectPath = await resolveProjectGroupsPath(ctx.cwd, options.configDirName);
      const projectDocument = await readGroupsDocument(projectPath);
      projectGroups = projectDocument.groups;
      const guardDocuments = [
        { path: globalPath, content: globalDocument.content },
        { path: projectPath, content: projectDocument.content },
      ];
      scopes[0].guardDocuments = guardDocuments;
      scopes[0].validationGroupSets = (candidate) => [
        candidate,
        { ...candidate, ...projectGroups },
      ];
      scopes.push({
        label: `Project groups (${Object.keys(projectGroups).length})`,
        name: "project",
        path: projectPath,
        groups: projectGroups,
        guardDocuments,
        validationGroupSets: (candidate) => [{ ...globalGroups, ...candidate }],
      });
    }

    const scopeChoice = await ctx.ui.select("Choose custom group scope", [
      ...scopes.map((scope) => scope.label),
      "Back",
    ]);
    if (!scopeChoice || scopeChoice === "Back") return;

    const scope = scopes.find((candidate) => candidate.label === scopeChoice);
    if (!scope) continue;
    scope.visibleGroupSets = projectGroups ? [globalGroups, projectGroups] : [globalGroups];
    await manageGroupScope(ctx, scope);
  }
}

function formatSearchResultLabel(skill: Skill) {
  const icon = skill.manualOnly ? "🔴 OFF" : "🟢 ON ";
  const src = skill.source ? ` [${skill.source}]` : "";
  const desc = skill.description
    ? ` - ${skill.description.replace(/\r?\n/g, " ").slice(0, 60)}${skill.description.length > 60 ? "…" : ""}`
    : "";
  return `${icon}  ${skill.name}${src}${desc}`;
}

async function handleSearchResults(results: Skill[], query: string, ctx: ExtensionCommandContext, options: ManagerOptions) {
  const activeCount = results.filter((s) => !s.manualOnly).length;
  const disabledCount = results.length - activeCount;

  const turnOnAll = `🟢 Turn all ${results.length} ON`;
  const turnOffAll = `🔴 Turn all ${results.length} OFF`;

  const items = results.map(formatSearchResultLabel);

  const choice = await ctx.ui.select(
    `Search: "${query}" (${results.length} found: ${activeCount} ON / ${disabledCount} OFF)`,
    [
      "Done / Back",
      turnOnAll,
      turnOffAll,
      ...items,
    ],
  );

  if (!choice || choice === "Done / Back") return;

  if (choice === turnOnAll) {
    await updateAndReload(results, false, ctx, options);
    return;
  }

  if (choice === turnOffAll) {
    await updateAndReload(results, true, ctx, options);
    return;
  }

  const index = items.indexOf(choice);
  if (index !== -1) {
    const skill = results[index];
    const targetManualOnly = !skill.manualOnly;
    await updateAndReload([skill], targetManualOnly, ctx, options);
  }
}

async function executeSearch(query: string, skills: Skill[], ctx: ExtensionCommandContext, options: ManagerOptions) {
  const matches = searchSkills(skills, query);
  if (matches.length === 0) {
    ctx.ui.notify(`No skills found matching "${query}"`, "info");
    return;
  }

  if (ctx.hasUI && ctx.mode === "tui") {
    await handleSearchResults(matches, query, ctx, options);
    return;
  }

  const output = matches
    .map((s) => `${s.manualOnly ? "🔴 OFF" : "🟢 ON "}  ${s.name} [${s.source}] - ${s.description}`)
    .join("\n");
  if (ctx.hasUI) {
    await ctx.ui.editor(`Search results for "${query}" (${matches.length})`, output);
  } else {
    ctx.ui.notify(`Found ${matches.length} skill(s) matching "${query}"`, "info");
  }
}

async function quickToggleSkills(skills: Skill[], ctx: ExtensionCommandContext, options: ManagerOptions) {
  const activeCount = skills.filter((s) => !s.manualOnly).length;
  const maxNameLen = Math.max(...skills.map((s) => s.name.length), 10);
  const items = skills.map((skill) => {
    const icon = skill.manualOnly ? "🔴 OFF" : "🟢 ON ";
    const src = skill.source ? ` · ${skill.source}` : "";
    return `${skill.name.padEnd(maxNameLen + 2)} [${icon}]${src}`;
  });

  const choice = await ctx.ui.select(
    `Select a skill to toggle (${activeCount}/${skills.length} ON)`,
    ["Cancel", ...items],
  );

  if (!choice || choice === "Cancel") return;

  const index = items.indexOf(choice);
  if (index === -1) return;

  const skill = skills[index];
  const targetManualOnly = !skill.manualOnly;
  await updateAndReload([skill], targetManualOnly, ctx, options);
}

async function showManager(pi: ExtensionAPI, ctx: ExtensionCommandContext, options: ManagerOptions) {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/skills-manager without arguments requires TUI mode", "error");
    return;
  }

  const skills = await discoverSkills(pi, options, ctx);
  if (skills.length === 0) {
    ctx.ui.notify("No skills discovered", "info");
    return;
  }

  while (true) {
    const customGroups = await loadGroups(ctx, options);
    const groups = buildAutomaticGroups(skills, customGroups);

    const activeCount = skills.filter((s) => !s.manualOnly).length;
    const disabledCount = skills.length - activeCount;

    const quickToggleChoice = `⚡ Quick toggle skill… (${activeCount} ON / ${disabledCount} OFF)`;
    const turnAllOnChoice = `🟢 Turn all skills ON (${disabledCount} disabled)`;
    const turnAllOffChoice = `🔴 Turn all skills OFF (${activeCount} active)`;
    const customSelectorChoice = "Custom selectors…";
    const manageGroupsChoice = "Manage custom groups…";

    let groupChoice = await ctx.ui.select("Choose a skill group", [
      quickToggleChoice,
      turnAllOnChoice,
      turnAllOffChoice,
      ...groups.keys(),
      customSelectorChoice,
      manageGroupsChoice,
    ]);
    if (!groupChoice) return;

    if (groupChoice === quickToggleChoice) {
      await quickToggleSkills(skills, ctx, options);
      return;
    }

    if (groupChoice === turnAllOnChoice) {
      if (disabledCount === 0) {
        ctx.ui.notify("All skills are already automatic (ON)", "info");
        continue;
      }
      await updateAndReload(skills, false, ctx, options);
      return;
    }

    if (groupChoice === turnAllOffChoice) {
      if (activeCount === 0) {
        ctx.ui.notify("All skills are already manual-only (OFF)", "info");
        continue;
      }
      await updateAndReload(skills, true, ctx, options);
      return;
    }

    if (groupChoice === manageGroupsChoice) {
      await manageCustomGroups(ctx, options);
      continue;
    }

    let selected;
    if (groupChoice === customSelectorChoice) {
      const input = await ctx.ui.input(
        "Skill selectors",
        "Examples: test-*  source:package  group:quality",
      );
      if (!input) return;
      const selectors = splitCommandLine(input);
      selected = resolveSelectors(skills, selectors, customGroups);
      groupChoice = `Custom selectors (${selected.length})`;
    } else {
      selected = groups.get(groupChoice) ?? [];
    }
    if (selected.length === 0) {
      ctx.ui.notify("The selected group contains no loaded skills", "warning");
      return;
    }

    const action = await ctx.ui.select(`Manage ${groupChoice}`, [
      "⚡ Quick toggle in this group…",
      "Set all to automatic",
      "Set all to manual-only",
      "Edit individually",
    ]);
    if (action === "⚡ Quick toggle in this group…") {
      await quickToggleSkills(selected, ctx, options);
      return;
    }
    if (action === "Set all to automatic") await updateAndReload(selected, false, ctx, options);
    if (action === "Set all to manual-only") await updateAndReload(selected, true, ctx, options);
    if (action === "Edit individually") await editIndividually(selected, ctx, options);
    return;
  }
}

export default function skillManagerExtension(pi: ExtensionAPI, options: ManagerOptions) {
  if (typeof pi?.on === "function") {
    pi.on("session_start", (_event, ctx) => {
      if (!ctx?.hasUI || typeof ctx.ui?.addAutocompleteProvider !== "function") return;
      ctx.ui.addAutocompleteProvider((current) => ({
        triggerCharacters: ["$"],
        async getSuggestions(lines, cursorLine, cursorCol, autocompleteOptions) {
          const line = lines[cursorLine] ?? "";
          const beforeCursor = line.slice(0, cursorCol);
          const match = beforeCursor.match(/(?:^|[ \t])\$([^\s$]*)$/);
          if (!match) {
            return current.getSuggestions(lines, cursorLine, cursorCol, autocompleteOptions);
          }

          const query = match[1] ?? "";
          const skills = await discoverSkills(pi, options, ctx);
          const matches = searchSkills(skills, query);
          return {
            prefix: `$${query}`,
            items: matches.map((s) => ({
              value: `$${s.name}`,
              label: `${s.name} [${s.manualOnly ? "OFF" : "ON"}]`,
              description: s.description ? s.description.slice(0, 80) : (s.source ?? ""),
            })),
          };
        },

        applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
          return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
        },

        shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
          return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
        },
      }));
    });
  }

  const handler = async (args: string, ctx: ExtensionCommandContext) => {
    const trimmed = String(args ?? "").trim();
    if (!trimmed) {
      try {
        await showManager(pi, ctx, options);
      } catch (error) {
        ctx.ui.notify(`Skill manager failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
      return;
    }

    try {
      const skills = await discoverSkills(pi, options, ctx);
      const groups = await loadGroups(ctx, options);

      // Check if input starts with $ (e.g. /manager $git or /manager $ git)
      if (trimmed.startsWith("$")) {
        const query = trimmed.slice(1).trim();
        if (!query) {
          ctx.ui.notify("Usage: /manager $<query>", "warning");
          return;
        }
        await executeSearch(query, skills, ctx, options);
        return;
      }

      let words;
      try {
        words = splitCommandLine(trimmed);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }
      if (words.length === 0) return;

      const rawAction = words.shift()!;
      const action = rawAction.toLowerCase();

      if ((action === "list" || action === "ls" || action === "groups") && !ctx.hasUI) {
        ctx.ui.notify(`/skills-manager ${action} requires dialog UI`, "error");
        return;
      }

      if (action === "list" || action === "ls") {
        const selected = words.length > 0 ? resolveSelectors(skills, words, groups) : skills;
        const output = selected
          .map((skill) => `${skill.name}  ${skill.manualOnly ? "manual-only" : "automatic"}  [${skill.scope}/${skill.source}]`)
          .join("\n");
        await ctx.ui.editor("Skill invocation states", output || "No skills matched");
        return;
      }

      if (action === "status") {
        const activeCount = skills.filter((s) => !s.manualOnly).length;
        const disabledCount = skills.length - activeCount;
        ctx.ui.notify(
          `📊 Skills: ${skills.length} total · ${activeCount} automatic (ON) · ${disabledCount} manual-only (OFF)`,
          "info",
        );
        return;
      }

      if (action === "groups") {
        const output = [...buildAutomaticGroups(skills, groups).keys()].join("\n");
        await ctx.ui.editor("Skill groups", output || "No skill groups available");
        return;
      }

      if (action === "search" || action === "find" || action === "s") {
        let query = words.join(" ").trim();
        if (query.startsWith("$")) query = query.slice(1).trim();
        if (!query) {
          if (ctx.hasUI && ctx.mode === "tui") {
            const input = await ctx.ui.input("Search skills", "Search by name, description, or keyword...");
            if (!input || !input.trim()) return;
            query = input.trim();
          } else {
            ctx.ui.notify("Usage: /manager <query> or /manager $<query>", "warning");
            return;
          }
        }
        await executeSearch(query, skills, ctx, options);
        return;
      }

      if (
        action === "all-on" ||
        ((action === "on" || action === "enable" || action === "auto" || action === "auto-on") &&
          (words[0] === "all" || words[0] === "*"))
      ) {
        await updateAndReload(skills, false, ctx, options);
        return;
      }

      if (
        action === "all-off" ||
        ((action === "off" || action === "disable" || action === "manual") &&
          (words[0] === "all" || words[0] === "*"))
      ) {
        await updateAndReload(skills, true, ctx, options);
        return;
      }

      if (action === "toggle" || action === "t") {
        if (words.length === 0) {
          if (ctx.hasUI && ctx.mode === "tui") {
            await quickToggleSkills(skills, ctx, options);
            return;
          }
          ctx.ui.notify("Usage: /manager toggle <skill selectors...>", "warning");
          return;
        }
        const selected = resolveSelectors(skills, words, groups);
        if (selected.length === 0) {
          ctx.ui.notify("No skills matched the supplied selectors", "warning");
          return;
        }
        const updates = selected.map((skill) => ({
          path: skill.path,
          manualOnly: !skill.manualOnly,
        }));
        await applyManualOnlyChanges(updates, mutationOptions(options));
        const summary =
          selected.length === 1
            ? `${selected[0].name} toggled to ${updates[0].manualOnly ? "manual-only (OFF)" : "automatic (ON)"}; reloading`
            : `${selected.length} skill(s) toggled; reloading`;
        ctx.ui.notify(summary, "info");
        await ctx.reload();
        return;
      }

      const isOnAction =
        action === "auto-on" || action === "on" || action === "enable" || action === "auto";
      const isOffAction = action === "manual" || action === "off" || action === "disable";

      if (isOnAction || isOffAction) {
        if (words.length === 0) {
          if (ctx.hasUI && ctx.mode === "tui") {
            const targetSkills = isOnAction
              ? skills.filter((s) => s.manualOnly)
              : skills.filter((s) => !s.manualOnly);
            if (targetSkills.length === 0) {
              ctx.ui.notify(
                isOnAction ? "All skills are already ON" : "All skills are already OFF",
                "info",
              );
              return;
            }
            const choice = await ctx.ui.select(
              isOnAction ? "Choose a skill to turn ON" : "Choose a skill to turn OFF",
              ["Cancel", ...targetSkills.map((s) => `${s.name} (${s.source})`)],
            );
            if (!choice || choice === "Cancel") return;
            const chosen = targetSkills.find((s) => `${s.name} (${s.source})` === choice);
            if (chosen) {
              await updateAndReload([chosen], isOffAction, ctx, options);
            }
            return;
          }
          ctx.ui.notify("At least one skill selector is required", "warning");
          return;
        }

        const selected = resolveSelectors(skills, words, groups);
        if (selected.length === 0) {
          ctx.ui.notify("No skills matched the supplied selectors", "warning");
          return;
        }
        await updateAndReload(selected, isOffAction, ctx, options);
        return;
      }

      // Direct toggle fallback: user typed `/skills <selector>` without an explicit subcommand
      const candidateSelectors = [rawAction, ...words];
      let selected: Skill[] = [];
      try {
        selected = resolveSelectors(skills, candidateSelectors, groups);
      } catch {
        selected = [];
      }

      if (selected.length > 0) {
        const updates = selected.map((skill) => ({
          path: skill.path,
          manualOnly: !skill.manualOnly,
        }));
        await applyManualOnlyChanges(updates, mutationOptions(options));
        const summary =
          selected.length === 1
            ? `${selected[0].name} toggled to ${updates[0].manualOnly ? "manual-only (OFF)" : "automatic (ON)"}; reloading`
            : `${selected.length} skill(s) toggled; reloading`;
        ctx.ui.notify(summary, "info");
        await ctx.reload();
        return;
      }

      // If no selectors matched, direct input is search!
      await executeSearch(trimmed, skills, ctx, options);
    } catch (error) {
      ctx.ui.notify(
        `Skill update failed: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  };

  const commandConfig = {
    description: "Manage automatic skill invocation (/manager [on|off|toggle|list|status])",
    handler,
  };

  pi.registerCommand("skills-manager", commandConfig);
  pi.registerCommand("manager", commandConfig);
  pi.registerCommand("skills", commandConfig);
  pi.registerCommand("skill-manager", commandConfig);
}
