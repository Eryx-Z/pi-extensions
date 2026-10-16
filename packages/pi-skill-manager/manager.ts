import { chmod, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type Groups = Record<string, string[]>;

export interface SkillSummary {
  name: string;
  description?: string;
  source?: string;
  sources?: string[];
  scope?: string;
}

interface Frontmatter {
  [key: string]: unknown;
  metadata?: Record<string, unknown>;
}

export interface SourceOptions {
  parseSkillFrontmatter?: (content: string) => Frontmatter;
}

interface SkillCommand {
  name: string;
  sourceInfo?: { source: string; path?: string; baseDir?: string };
}

export interface MutationOptions {
  replaceFile?: (path: string, content: string, mode: number) => Promise<void>;
  readCurrent?: (path: string) => Promise<string>;
  validateContent?: (content: string, manualOnly: boolean, path: string) => void | Promise<void>;
}

interface PreparedChange {
  path: string;
  original: string;
  updated: string;
  mode: number;
}

const FLAG = "disable-model-invocation";
let temporaryFileCounter = 0;

function frontmatterBounds(content: string) {
  const opening = content.match(/^\uFEFF?---(\r?\n)/);
  if (!opening) throw new Error("Skill file has no YAML frontmatter");

  const start = opening[0].length;
  const closingPattern = /^(---)[ \t]*(\r?\n|$)/gm;
  closingPattern.lastIndex = start;
  const closing = closingPattern.exec(content);
  if (!closing) throw new Error("Skill file has unterminated YAML frontmatter");

  return { start, end: closing.index };
}

export function getManualOnlyFromContent(content: string) {
  const { start, end } = frontmatterBounds(content);
  const frontmatter = content.slice(start, end);
  const fieldPattern = /^(?:disable-model-invocation|"disable-model-invocation"|'disable-model-invocation')[ \t]*:[ \t]*([^#\r\n]*?)(?:[ \t]*#.*)?$/gm;
  const values = [...frontmatter.matchAll(fieldPattern)].map((match) => match[1].trim().toLowerCase());
  if (values.length > 1) throw new Error(`Skill frontmatter contains duplicate ${FLAG} fields`);
  return values[0] === "true";
}

export function splitCommandLine(input: string) {
  const words: string[] = [];
  let current = "";
  let quote;
  let escaped = false;

  const push = () => {
    if (current) words.push(current);
    current = "";
  };

  for (const character of input) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      push();
      continue;
    }
    current += character;
  }

  if (escaped) current += "\\";
  if (quote) throw new Error("Unterminated quote in command arguments");
  push();
  return words;
}

function globMatches(value: string, pattern: string) {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

function parseGitUrl(raw: string) {
  let clean = raw.replace(/^git:/, "").trim();
  const atRefMatch = clean.match(/(?:^git@[^:]+:[^@]+|https?:\/\/[^@]+)@(.+)$/);
  if (atRefMatch) {
    clean = clean.slice(0, clean.lastIndexOf("@"));
  }
  clean = clean.replace(/\.git$/, "");
  const parts = clean.split(/[/:]/).filter(Boolean);
  const repo = parts.pop();
  const owner = parts.pop();
  return { repo, owner: owner && !owner.includes("@") ? owner : undefined };
}

function cleanAuthorName(author: unknown) {
  if (typeof author !== "string") return "";
  let clean = author.replace(/<[^>]*>/g, "").replace(/\([^)]*\)/g, "").trim();
  clean = clean.replace(/^["']|["']$/g, "").trim();
  return clean;
}

function extractFrontmatterMetadata(content: string, parseSkillFrontmatter: SourceOptions["parseSkillFrontmatter"]): Frontmatter {
  if (parseSkillFrontmatter) {
    try {
      const parsed = parseSkillFrontmatter(content);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  try {
    const opening = content.match(/^\uFEFF?---(\r?\n)/);
    if (!opening) return {};
    const start = opening[0].length;
    const closingPattern = /^(---)[ \t]*(\r?\n|$)/gm;
    closingPattern.lastIndex = start;
    const closing = closingPattern.exec(content);
    if (!closing) return {};
    const slice = content.slice(start, closing.index);
    const metadata: Frontmatter = {};
    const authorMatch = slice.match(/^(?:metadata\s*:\s*\r?\n(?:\s+[^\r\n]*\r?\n)*?\s+author\s*:\s*|author\s*:\s*)(["']?)(.*?)\1\s*$/m);
    if (authorMatch) metadata.author = authorMatch[2].trim();
    const sourceMatch = slice.match(/^(?:metadata\s*:\s*\r?\n(?:\s+[^\r\n]*\r?\n)*?\s+source\s*:\s*|source\s*:\s*)(["']?)(.*?)\1\s*$/m);
    if (sourceMatch) metadata.source = sourceMatch[2].trim();
    const collectionMatch = slice.match(/^(?:metadata\s*:\s*\r?\n(?:\s+[^\r\n]*\r?\n)*?\s+collection\s*:\s*|collection\s*:\s*)(["']?)(.*?)\1\s*$/m);
    if (collectionMatch) metadata.collection = collectionMatch[2].trim();
    const packageMatch = slice.match(/^(?:metadata\s*:\s*\r?\n(?:\s+[^\r\n]*\r?\n)*?\s+package\s*:\s*|package\s*:\s*)(["']?)(.*?)\1\s*$/m);
    if (packageMatch) metadata.package = packageMatch[2].trim();
    return metadata;
  } catch {
    return {};
  }
}

export function resolveSkillSource(command: SkillCommand, content: string, options: SourceOptions = {}) {
  const rawSource = command.sourceInfo?.source ?? "auto";
  const skillPath = command.sourceInfo?.path ?? "";
  const baseDir = command.sourceInfo?.baseDir ?? "";
  const name = command.name.startsWith("skill:") ? command.name.slice(6) : command.name;
  const frontmatter = extractFrontmatterMetadata(content, options.parseSkillFrontmatter);

  const sources = new Set<string>();
  if (rawSource && rawSource !== "auto" && rawSource !== "local") {
    sources.add(rawSource);
  }

  let primary = null;

  // 1. Check npm package source (e.g. npm:pi-subagents or npm:@scope/pkg)
  if (rawSource.startsWith("npm:")) {
    const pkg = rawSource.slice(4);
    sources.add(pkg);
    if (pkg.startsWith("@") && pkg.includes("/")) {
      sources.add(pkg.split("/")[1]);
    }
    primary = pkg;
  } else if (rawSource.startsWith("git:")) {
    // 2. Check git package source
    const parsed = parseGitUrl(rawSource);
    if (parsed?.repo) {
      sources.add(parsed.repo);
      if (parsed.owner) sources.add(`${parsed.owner}/${parsed.repo}`);
      primary = parsed.repo;
    }
  }

  // 3. Explicit frontmatter source/collection/package
  const explicit =
    frontmatter.source ??
    frontmatter.metadata?.source ??
    frontmatter.collection ??
    frontmatter.metadata?.collection ??
    frontmatter.package ??
    frontmatter.metadata?.package;
  if (typeof explicit === "string" && explicit.trim()) {
    const trimmed = explicit.trim();
    sources.add(trimmed);
    if (!primary) primary = trimmed;
  }

  // 4. Check path inside node_modules
  if (skillPath) {
    const normalized = skillPath.replace(/\\/g, "/");
    const nmMatch = normalized.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\/skills\//);
    if (nmMatch) {
      const pkg = nmMatch[1];
      sources.add(pkg);
      if (pkg.startsWith("@") && pkg.includes("/")) sources.add(pkg.split("/")[1]);
      if (!primary) primary = pkg;
    }

    // 5. Check path under skills directories
    let relInsideSkills = null;
    if (baseDir) {
      const normBase = baseDir.replace(/\\/g, "/").replace(/\/$/, "");
      for (const sub of ["/skills/", "/.agents/skills/", "/.pi/skills/"]) {
        const candidate = normBase + sub;
        if (normalized.startsWith(candidate)) {
          relInsideSkills = normalized.slice(candidate.length);
          break;
        }
      }
    }

    if (!relInsideSkills) {
      const roots = [
        "/.agents/skills/",
        "/.pi/agent/skills/",
        "/.pi/skills/",
        "/.claude/skills/",
        "/.codex/skills/",
      ];
      for (const root of roots) {
        const idx = normalized.indexOf(root);
        if (idx !== -1) {
          relInsideSkills = normalized.slice(idx + root.length);
          break;
        }
      }
    }

    if (!relInsideSkills) {
      const idx = normalized.lastIndexOf("/skills/");
      if (idx !== -1) {
        relInsideSkills = normalized.slice(idx + "/skills/".length);
      }
    }

    if (relInsideSkills) {
      const parts = relInsideSkills.split("/").filter(Boolean);
      if (parts.length > 0) {
        const top = parts[0].replace(/\.md$/, "");
        sources.add(top);
        if (parts.length > 1 && top !== name) {
          // Multi-skill pack / collection (e.g. mattpocock-skills)
          if (!primary) primary = top;
        } else {
          // Single skill folder or direct file
          if (!primary) {
            const author = cleanAuthorName(frontmatter.metadata?.author ?? frontmatter.author);
            if (author) {
              sources.add(author);
              primary = author;
            } else {
              primary = top;
            }
          }
        }
      }
    }
  }

  // Author as alias if present and not yet primary
  const author = cleanAuthorName(frontmatter.metadata?.author ?? frontmatter.author);
  if (author) {
    sources.add(author);
  }

  if (!primary) {
    primary = rawSource || "auto";
  }
  sources.add(primary);
  if (rawSource) sources.add(rawSource);

  return { source: primary, sources: Array.from(sources) };
}

export function resolveSelectors<T extends SkillSummary>(skills: T[], selectors: string[], groups: Groups = {}) {
  const selectedNames = new Set<string>();

  function apply(selector: string, groupStack: string[] = []) {
    const value = selector.trim();
    if (!value) return;

    if (value === "all" || value === "*") {
      for (const skill of skills) selectedNames.add(skill.name);
      return;
    }

    if (value.startsWith("$")) {
      const query = value.slice(1).trim();
      const matches = searchSkills(skills, query);
      for (const m of matches) selectedNames.add(m.name);
      return;
    }

    if (value.startsWith("group:")) {
      const groupName = value.slice("group:".length);
      if (!Object.hasOwn(groups, groupName)) {
        throw new Error(`Unknown skill group: ${groupName}`);
      }
      const members = groups[groupName];
      if (groupStack.includes(groupName)) {
        throw new Error(`Skill group cycle: ${[...groupStack, groupName].join(" -> ")}`);
      }
      for (const member of members) apply(member, [...groupStack, groupName]);
      return;
    }

    let field: "name" | "source" | "scope" = "name";
    let pattern = value;
    if (value.startsWith("source:")) {
      field = "source";
      pattern = value.slice("source:".length);
    } else if (value.startsWith("scope:")) {
      field = "scope";
      pattern = value.slice("scope:".length);
    }

    for (const skill of skills) {
      if (field === "source" && Array.isArray(skill.sources)) {
        if (skill.sources.some((s) => globMatches(String(s ?? ""), pattern))) {
          selectedNames.add(skill.name);
          continue;
        }
      }
      if (globMatches(String(skill[field] ?? ""), pattern)) selectedNames.add(skill.name);
    }
  }

  for (const selector of selectors) apply(selector);
  return skills.filter((skill) => selectedNames.has(skill.name));
}

export function searchSkills<T extends SkillSummary>(skills: T[], query: string) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return [...skills];
  const terms = q.split(/\s+/).filter(Boolean);

  return skills.filter((skill) => {
    const name = String(skill.name ?? "").toLowerCase();
    const desc = String(skill.description ?? "").toLowerCase();
    const source = String(skill.source ?? "").toLowerCase();
    const sources = Array.isArray(skill.sources)
      ? skill.sources.map((s) => String(s ?? "").toLowerCase())
      : [];
    const scope = String(skill.scope ?? "").toLowerCase();

    return terms.every(
      (term) =>
        name.includes(term) ||
        desc.includes(term) ||
        source.includes(term) ||
        sources.some((s) => s.includes(term)) ||
        scope.includes(term),
    );
  });
}

export function setManualOnlyInContent(content: string, manualOnly: boolean) {
  const { start, end } = frontmatterBounds(content);
  const frontmatter = content.slice(start, end);
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const fieldPattern = /^((?:disable-model-invocation|"disable-model-invocation"|'disable-model-invocation')[ \t]*:[ \t]*)([^#\r\n]*?)([ \t]*(?:#.*)?)$/gm;
  const matches = [...frontmatter.matchAll(fieldPattern)];

  if (matches.length > 1) throw new Error(`Skill frontmatter contains duplicate ${FLAG} fields`);

  const value = manualOnly ? "true" : "false";
  let updated;
  if (matches.length === 1) {
    updated = frontmatter.replace(fieldPattern, (_line: string, prefix: string, _oldValue: string, suffix: string) => `${prefix}${value}${suffix}`);
  } else {
    const separator = frontmatter.length === 0 || frontmatter.endsWith("\n") ? "" : newline;
    updated = `${frontmatter}${separator}${FLAG}: ${value}${newline}`;
  }

  return content.slice(0, start) + updated + content.slice(end);
}

async function replaceFileAtomically(path: string, content: string, mode: number) {
  const temporaryPath = join(
    dirname(path),
    `.skill-manager-${process.pid}-${temporaryFileCounter++}.tmp`,
  );
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx", mode });
    await chmod(temporaryPath, mode);
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function applyManualOnlyChanges(changes: { path: string; manualOnly: boolean }[], options: MutationOptions = {}) {
  const replaceFile = options.replaceFile ?? replaceFileAtomically;
  const readCurrent = options.readCurrent ?? ((path) => readFile(path, "utf8"));
  const prepared: PreparedChange[] = [];
  const requestedModes = new Map<string, boolean>();

  for (const change of changes) {
    const path = await realpath(change.path);
    if (requestedModes.has(path)) {
      if (requestedModes.get(path) !== change.manualOnly) {
        throw new Error(`Conflicting states requested for ${path}`);
      }
      continue;
    }
    requestedModes.set(path, change.manualOnly);

    const original = await readCurrent(path);
    const updated = setManualOnlyInContent(original, change.manualOnly);
    if (options.validateContent) {
      await options.validateContent(updated, change.manualOnly, path);
    }
    const fileStat = await stat(path);
    if (updated !== original) prepared.push({ path, original, updated, mode: fileStat.mode });
  }

  const completed: PreparedChange[] = [];
  try {
    for (const item of prepared) {
      if ((await readCurrent(item.path)) !== item.original) {
        throw new Error(`${item.path}: skill changed concurrently before write`);
      }
      await replaceFile(item.path, item.updated, item.mode);
      completed.push(item);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const item of completed.reverse()) {
      try {
        if ((await readCurrent(item.path)) !== item.updated) {
          throw new Error(`${item.path}: changed concurrently before rollback`);
        }
        await replaceFile(item.path, item.original, item.mode);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], "Skill update failed and rollback was incomplete");
    }
    throw error;
  }

  return prepared.map((item) => item.path);
}

export async function applyManualOnlyToFiles(paths: string[], manualOnly: boolean, options: MutationOptions = {}) {
  return applyManualOnlyChanges(
    paths.map((path) => ({ path, manualOnly })),
    options,
  );
}
