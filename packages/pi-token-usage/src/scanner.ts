import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, chmod, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { ScanDiagnostics, ScanResult, UsageRecord } from "./types.js";

const DEFAULT_CONCURRENCY = 8;

type UnknownObject = Record<string, unknown>;

interface FileScanResult {
  records: UsageRecord[];
  malformedLines: number;
  missingIds: number;
  invalidTimestamps: number;
  failed: boolean;
}

interface CachedFile {
  fingerprint: string;
  result: FileScanResult;
}

type LedgerResult = { records: UsageRecord[]; malformedLines: number; failed: boolean };
interface ScanOptions {
  concurrency?: number;
  signal?: AbortSignal;
  syncLedger?: boolean;
  ledgerPath?: string;
}

interface CachedLedger {
  fingerprint: string;
  ino: number;
  size: number;
  headSample: string;
  result: LedgerResult;
}

// Cache usage metadata only, never session text. A changed file is reread in full.
const fileCache = new Map<string, CachedFile>();
const hydratedDiskCaches = new Set<string>();
const ledgerCache = new Map<string, CachedLedger>();
const snapshots = new Map<string, ScanResult>();
const scansInFlight = new Map<string, Promise<ScanResult>>();
const ledgerWrites = new Map<string, Promise<unknown>>();

const LEDGER_LOCK_STALE_MS = 15_000;
const LEDGER_LOCK_WAIT_MS = 5_000;

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function isCrossProcessLockStale(lockPath: string, now: number): Promise<boolean> {
  let mtimeMs = 0;
  try {
    mtimeMs = (await stat(lockPath)).mtimeMs;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown; acquiredAt?: unknown };
    const pid = typeof parsed?.pid === "number" ? parsed.pid : NaN;
    const acquiredAt =
      typeof parsed?.acquiredAt === "number" && Number.isFinite(parsed.acquiredAt)
        ? parsed.acquiredAt
        : mtimeMs;
    if (!isPidAlive(pid)) return true;
    return now - Math.min(acquiredAt, mtimeMs) > LEDGER_LOCK_STALE_MS;
  } catch {
    return now - mtimeMs > 500;
  }
}

async function withCrossProcessLedgerLock<T>(ledgerPath: string, action: () => Promise<T>): Promise<T> {
  const lockPath = `${resolve(ledgerPath)}.lock`;
  const token = randomUUID();
  const deadline = Date.now() + LEDGER_LOCK_WAIT_MS;
  let delayMs = 5;
  let acquired = false;

  while (!acquired) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token, acquiredAt: Date.now() }), "utf8");
      } finally {
        await handle.close();
      }
      acquired = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EACCES" || code === "EPERM" || code === "EROFS") {
        // Parent directory missing or read-only: fall back to in-process serialization.
        return action();
      }
      if (code !== "EEXIST") throw error;
      const now = Date.now();
      if (await isCrossProcessLockStale(lockPath, now)) {
        const staleTmp = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
        try {
          await rename(lockPath, staleTmp);
          await unlink(staleTmp).catch(() => {});
        } catch {
          // Another contender already preempted or released it.
        }
        continue;
      }
      if (now >= deadline) {
        throw new Error(`Timed out waiting for token ledger lock: ${lockPath}`);
      }
      await new Promise((r) => setTimeout(r, Math.min(delayMs, Math.max(1, deadline - now))));
      delayMs = Math.min(25, delayMs + 5);
    }
  }

  try {
    return await action();
  } finally {
    try {
      const parsed = JSON.parse(await readFile(lockPath, "utf8")) as { token?: unknown };
      if (parsed?.token === token) {
        await unlink(lockPath);
      }
    } catch {
      // Already released or preempted.
    }
  }
}

function withLedgerLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const key = resolve(path);
  const pending = (ledgerWrites.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(() => withCrossProcessLedgerLock(key, action));
  ledgerWrites.set(key, pending);
  void pending.finally(() => {
    if (ledgerWrites.get(key) === pending) ledgerWrites.delete(key);
  }).catch(() => {});
  return pending;
}

async function fingerprint(path: string): Promise<string> {
  const info = await stat(path);
  return `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`;
}

function emptyDiagnostics(): ScanDiagnostics {
  return { filesFound: 0, filesRead: 0, fileErrors: 0, malformedLines: 0, missingIds: 0, invalidTimestamps: 0 };
}

function ledgerPathFor(sessionsDirectory: string, options: ScanOptions): string | undefined {
  if (options.syncLedger === false) return undefined;
  if (options.ledgerPath) return resolve(options.ledgerPath);
  if (sessionsDirectory === resolve(getSessionsDirectory())) return resolve(getTokenLedgerPath());
  return basename(sessionsDirectory) === "sessions"
    ? join(dirname(sessionsDirectory), "token-usage.jsonl")
    : undefined;
}

function snapshotKey(sessionsDirectory: string, ledgerPath?: string): string {
  return JSON.stringify([sessionsDirectory, ledgerPath ?? null]);
}

function isObject(value: unknown): value is UnknownObject {
  return typeof value === "object" && value !== null;
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function nameOrUnknown(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value : "unknown";
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseUsageEntry(
  parsed: unknown,
): { record?: UsageRecord; missingId?: true; invalidTimestamp?: true } {
  if (!isObject(parsed) || parsed.type !== "message" || !isObject(parsed.message)) return {};
  const message = parsed.message;
  if (message.role !== "assistant" || !isObject(message.usage)) return {};

  if (typeof parsed.id !== "string" || parsed.id.length === 0) return { missingId: true };
  const timestamp = parseTimestamp(parsed.timestamp);
  if (timestamp === undefined) return { invalidTimestamp: true };

  const usage = message.usage;
  const cost = isObject(usage.cost) ? usage.cost : undefined;
  return {
    record: {
      id: parsed.id,
      timestamp,
      provider: nameOrUnknown(message.provider),
      model: nameOrUnknown(message.model),
      inputTokens: nonNegativeNumber(usage.input),
      outputTokens: nonNegativeNumber(usage.output),
      cacheReadTokens: nonNegativeNumber(usage.cacheRead),
      cacheWriteTokens: nonNegativeNumber(usage.cacheWrite),
      totalTokens: nonNegativeNumber(usage.totalTokens),
      costUSD: nonNegativeNumber(cost?.total),
    },
  };
}

async function findJsonlFiles(directory: string, signal?: AbortSignal): Promise<string[]> {
  const files: string[] = [];

  async function visit(current: string): Promise<void> {
    signal?.throwIfAborted();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (current === directory && code === "ENOENT") return;
      throw error;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      signal?.throwIfAborted();
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    }
  }

  await visit(directory);
  return files.sort((a, b) => a.localeCompare(b));
}

async function scanFile(path: string, signal?: AbortSignal): Promise<FileScanResult> {
  const records: UsageRecord[] = [];
  let malformedLines = 0;
  let missingIds = 0;
  let invalidTimestamps = 0;
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      signal?.throwIfAborted();
      if (!line.includes('"usage"')) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        malformedLines++;
        continue;
      }

      const result = parseUsageEntry(parsed);
      if (result.missingId) missingIds++;
      else if (result.invalidTimestamp) invalidTimestamps++;
      else if (result.record) records.push(result.record);
    }
    return { records, malformedLines, missingIds, invalidTimestamps, failed: false };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { records: [], malformedLines, missingIds, invalidTimestamps, failed: true };
  } finally {
    lines.close();
    stream.destroy();
  }
}

async function scanCachedFile(path: string, signal?: AbortSignal): Promise<{ result: FileScanResult; read: boolean }> {
  const cached = fileCache.get(path);
  try {
    signal?.throwIfAborted();
    const before = await fingerprint(path);
    if (cached?.fingerprint === before) return { result: cached.result, read: false };
    const result = await scanFile(path, signal);
    if (!result.failed) {
      // Do not mark a concurrently appended/replaced file as current.
      const after = await fingerprint(path);
      if (before === after) fileCache.set(path, { fingerprint: before, result });
      return { result, read: true };
    }
    return { result: { ...result, records: cached?.result.records ?? [] }, read: false };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      result: { ...(cached?.result ?? { records: [], malformedLines: 0, missingIds: 0, invalidTimestamps: 0 }), failed: true },
      read: false,
    };
  }
}

export function getAgentDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

export function getSessionsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(getAgentDirectory(env), "sessions");
}

export function getTokenLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getAgentDirectory(env), "token-usage.jsonl");
}

async function readHeadSample(path: string, maxBytes = 128): Promise<string> {
  let handle;
  try {
    handle = await open(path, "r");
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readTokenLedgerRange(
  ledgerPath: string,
  startByte: number,
  signal?: AbortSignal,
): Promise<LedgerResult> {
  const records: UsageRecord[] = [];
  let malformedLines = 0;
  let failed = false;
  let stream: ReturnType<typeof createReadStream> | undefined;
  try {
    stream = createReadStream(ledgerPath, {
      encoding: "utf8",
      ...(startByte > 0 ? { start: startByte } : {}),
    });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      signal?.throwIfAborted();
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as Partial<UsageRecord>;
        if (
          typeof parsed.id === "string" &&
          parsed.id.length > 0 &&
          typeof parsed.timestamp === "number" &&
          Number.isFinite(parsed.timestamp) &&
          typeof parsed.provider === "string" &&
          typeof parsed.model === "string"
        ) {
          records.push({
            id: parsed.id,
            timestamp: parsed.timestamp,
            provider: parsed.provider,
            model: parsed.model,
            inputTokens: nonNegativeNumber(parsed.inputTokens),
            outputTokens: nonNegativeNumber(parsed.outputTokens),
            cacheReadTokens: nonNegativeNumber(parsed.cacheReadTokens),
            cacheWriteTokens: nonNegativeNumber(parsed.cacheWriteTokens),
            totalTokens: nonNegativeNumber(parsed.totalTokens),
            costUSD: nonNegativeNumber(parsed.costUSD),
          });
        } else {
          malformedLines++;
        }
      } catch {
        malformedLines++;
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    failed = (error as NodeJS.ErrnoException).code !== "ENOENT";
  } finally {
    stream?.destroy();
  }
  return { records, malformedLines, failed };
}

export async function readTokenLedger(
  ledgerPath = getTokenLedgerPath(),
  signal?: AbortSignal,
): Promise<LedgerResult> {
  return readTokenLedgerRange(ledgerPath, 0, signal);
}

async function readCachedLedger(ledgerPath: string, signal?: AbortSignal): Promise<LedgerResult> {
  const cached = ledgerCache.get(ledgerPath);
  try {
    signal?.throwIfAborted();
    const info = await stat(ledgerPath);
    const before = `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`;
    if (cached?.fingerprint === before) return cached.result;

    // Fast incremental tail-read when the same inode grew monotonically via appendFile.
    if (
      cached &&
      !cached.result.failed &&
      info.ino === cached.ino &&
      info.size > cached.size &&
      cached.size > 0
    ) {
      const headNow = await readHeadSample(ledgerPath, 128);
      if (headNow.length > 0 && headNow === cached.headSample) {
        const delta = await readTokenLedgerRange(ledgerPath, cached.size, signal);
        if (!delta.failed) {
          const merged: LedgerResult = {
            records: [...cached.result.records, ...delta.records],
            malformedLines: cached.result.malformedLines + delta.malformedLines,
            failed: false,
          };
          const afterInfo = await stat(ledgerPath);
          const after = `${afterInfo.size}:${afterInfo.mtimeMs}:${afterInfo.ctimeMs}:${afterInfo.ino}`;
          if (before === after) {
            ledgerCache.set(ledgerPath, {
              fingerprint: before,
              ino: info.ino,
              size: info.size,
              headSample: headNow,
              result: merged,
            });
          }
          return merged;
        }
      }
    }

    const [result, headSample] = await Promise.all([
      readTokenLedger(ledgerPath, signal),
      readHeadSample(ledgerPath, 128),
    ]);
    if (!result.failed) {
      const after = await fingerprint(ledgerPath);
      if (before === after) {
        ledgerCache.set(ledgerPath, {
          fingerprint: before,
          ino: info.ino,
          size: info.size,
          headSample,
          result,
        });
      }
      return result;
    }
    return { ...result, records: cached?.result.records ?? result.records };
  } catch (error) {
    if (signal?.aborted) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { records: [], malformedLines: 0, failed: false };
    }
    return { records: cached?.result.records ?? [], malformedLines: cached?.result.malformedLines ?? 0, failed: true };
  }
}

/** Fast, possibly stale initial view; a subsequent scan reconciles sessions and ledger. */
export async function readUsageSnapshot(
  sessionsDirectory = getSessionsDirectory(),
  options: ScanOptions = {},
): Promise<ScanResult> {
  options.signal?.throwIfAborted();
  const directory = resolve(sessionsDirectory);
  const ledgerPath = ledgerPathFor(directory, options);
  const cached = snapshots.get(snapshotKey(directory, ledgerPath));
  if (cached) return cached;
  const ledger = ledgerPath
    ? await withLedgerLock(ledgerPath, () => readCachedLedger(ledgerPath, options.signal))
    : undefined;
  const diagnostics = emptyDiagnostics();
  diagnostics.malformedLines = ledger?.malformedLines ?? 0;
  diagnostics.fileErrors = ledger?.failed ? 1 : 0;
  const records = new Map<string, UsageRecord>();
  for (const record of ledger?.records ?? []) {
    if (!records.has(record.id)) records.set(record.id, record);
  }
  return { records: [...records.values()], diagnostics };
}

export function writeTokenLedger(
  records: UsageRecord[],
  ledgerPath = getTokenLedgerPath(),
  signal?: AbortSignal,
): Promise<void> {
  return withLedgerLock(ledgerPath, () => writeTokenLedgerUnlocked(records, ledgerPath, signal));
}

async function writeTokenLedgerUnlocked(
  records: UsageRecord[],
  ledgerPath = getTokenLedgerPath(),
  signal?: AbortSignal,
): Promise<void> {
  const sorted = [...records].sort(
    (a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id),
  );
  const tempPath = `${ledgerPath}.tmp.${process.pid}.${Date.now()}`;
  const content = sorted.map((record) => `${JSON.stringify(record)}\n`).join("");
  signal?.throwIfAborted();
  await writeFile(tempPath, content, { encoding: "utf8", mode: 0o600 });
  try {
    await rename(tempPath, ledgerPath);
  } catch (err) {
    try {
      await unlink(tempPath);
    } catch {}
    throw err;
  }
}

export async function appendLedgerRecord(
  record: UsageRecord,
  ledgerPath = getTokenLedgerPath(),
): Promise<void> {
  await withLedgerLock(ledgerPath, async () => {
    try {
      await appendFile(ledgerPath, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch {
      // Non-fatal
    }
  });
}

export function scanSessions(
  sessionsDirectory = getSessionsDirectory(),
  options: ScanOptions = {},
): Promise<ScanResult> {
  const directory = resolve(sessionsDirectory);
  const ledgerPath = ledgerPathFor(directory, options);
  const key = snapshotKey(directory, ledgerPath);
  // Independently cancellable callers must not cancel a shared command refresh.
  if (!options.signal) {
    const pending = scansInFlight.get(key);
    if (pending) return pending;
  }
  const pending = scanSessionsIncremental(directory, options, ledgerPath).then((result) => {
    snapshots.set(key, result);
    return result;
  });
  if (!options.signal) {
    scansInFlight.set(key, pending);
    void pending.finally(() => {
      if (scansInFlight.get(key) === pending) scansInFlight.delete(key);
    }).catch(() => {});
  }
  return pending;
}

const DISK_CACHE_VERSION = 1;

function resolveDiskScanCachePath(sessionsDirectory: string): string | undefined {
  const explicitDir = process.env.PI_TOKEN_USAGE_CACHE_DIR?.trim();
  const defaultSessions = resolve(join(homedir(), ".pi", "agent", "sessions"));
  if (!explicitDir && resolve(sessionsDirectory) !== defaultSessions) {
    return undefined;
  }
  const cacheDir =
    explicitDir ||
    join(process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache"), "pi", "token-usage");
  const key = createHash("sha256").update(resolve(sessionsDirectory)).digest("hex").slice(0, 16);
  return join(cacheDir, `sessions-${key}.json`);
}

async function hydrateDiskScanCache(sessionsDirectory: string): Promise<void> {
  const key = resolve(sessionsDirectory);
  if (hydratedDiskCaches.has(key)) return;
  hydratedDiskCaches.add(key);
  const cachePath = resolveDiskScanCachePath(key);
  if (!cachePath) return;
  try {
    const parsed = JSON.parse(await readFile(cachePath, "utf8")) as {
      version?: unknown;
      files?: Record<string, CachedFile>;
    };
    if (parsed?.version !== DISK_CACHE_VERSION || !isObject(parsed.files)) return;
    for (const [filePath, entry] of Object.entries(parsed.files)) {
      if (fileCache.has(filePath)) continue;
      if (
        isObject(entry) &&
        typeof entry.fingerprint === "string" &&
        isObject(entry.result) &&
        Array.isArray(entry.result.records) &&
        entry.result.failed === false
      ) {
        fileCache.set(filePath, entry as CachedFile);
      }
    }
  } catch {
    // Missing or unreadable cache is non-fatal.
  }
}

async function persistDiskScanCache(sessionsDirectory: string, files: string[]): Promise<void> {
  const cachePath = resolveDiskScanCachePath(sessionsDirectory);
  if (!cachePath) return;
  const serializedFiles: Record<string, CachedFile> = {};
  for (const file of files) {
    const cached = fileCache.get(file);
    if (cached && !cached.result.failed) {
      serializedFiles[file] = cached;
    }
  }
  const tmpPath = `${cachePath}.tmp.${process.pid}.${randomUUID()}`;
  try {
    await mkdir(dirname(cachePath), { recursive: true, mode: 0o700 });
    await writeFile(
      tmpPath,
      JSON.stringify({ version: DISK_CACHE_VERSION, files: serializedFiles }),
      { encoding: "utf8", mode: 0o600 },
    );
    await chmod(tmpPath, 0o600);
    await rename(tmpPath, cachePath);
  } catch {
    await unlink(tmpPath).catch(() => {});
  }
}

async function scanSessionsIncremental(
  sessionsDirectory: string,
  options: ScanOptions,
  ledgerPath: string | undefined,
): Promise<ScanResult> {
  await hydrateDiskScanCache(sessionsDirectory);
  const files = await findJsonlFiles(sessionsDirectory, options.signal);
  const diagnostics = emptyDiagnostics();
  diagnostics.filesFound = files.length;
  const records: UsageRecord[] = [];
  const seen = new Set<string>();
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY));

  // Process bounded batches concurrently, then merge in sorted file order so
  // duplicate-ID selection is deterministic regardless of I/O completion order.
  for (let start = 0; start < files.length; start += concurrency) {
    options.signal?.throwIfAborted();
    const batch = files.slice(start, start + concurrency);
    const results = await Promise.all(batch.map((file) => scanCachedFile(file, options.signal)));

    for (const { result, read } of results) {
      diagnostics.malformedLines += result.malformedLines;
      diagnostics.missingIds += result.missingIds;
      diagnostics.invalidTimestamps += result.invalidTimestamps;
      if (result.failed) diagnostics.fileErrors++;
      if (read) diagnostics.filesRead++;
      for (const record of result.records) {
        if (seen.has(record.id)) continue;
        seen.add(record.id);
        records.push(record);
      }
    }
  }

  if (diagnostics.filesRead > 0) {
    await persistDiskScanCache(sessionsDirectory, files);
  }

  // Serialize reconciliation with turn-end appends so neither can overwrite the other.
  // Never replace the ledger with just the remaining sessions: deleted/remote history counts.
  if (ledgerPath) {
    await withLedgerLock(ledgerPath, async () => {
      const ledgerResult = await readCachedLedger(ledgerPath, options.signal);
      diagnostics.malformedLines += ledgerResult.malformedLines;
      if (ledgerResult.failed) diagnostics.fileErrors++;
      const ledgerById = new Map(ledgerResult.records.map((record) => [record.id, record]));
      const missingRecords: UsageRecord[] = [];
      let modifiedExisting = false;
      for (const record of records) {
        const previous = ledgerById.get(record.id);
        if (!previous) {
          missingRecords.push(record);
        } else if (
          record.timestamp !== previous.timestamp ||
          record.provider !== previous.provider ||
          record.model !== previous.model ||
          record.inputTokens !== previous.inputTokens ||
          record.outputTokens !== previous.outputTokens ||
          record.cacheReadTokens !== previous.cacheReadTokens ||
          record.cacheWriteTokens !== previous.cacheWriteTokens ||
          record.totalTokens !== previous.totalTokens ||
          record.costUSD !== previous.costUSD
        ) {
          modifiedExisting = true;
        }
      }
      const hasDuplicates = ledgerById.size !== ledgerResult.records.length;
      for (const record of ledgerResult.records) {
        if (seen.has(record.id)) continue;
        seen.add(record.id);
        records.push(record);
      }
      // An unreadable ledger is not an empty ledger; leave it intact for a later retry.
      if (records.length > 0 && !ledgerResult.failed) {
        try {
          if (modifiedExisting || hasDuplicates) {
            await writeTokenLedgerUnlocked(records, ledgerPath, options.signal);
          } else if (missingRecords.length > 0) {
            options.signal?.throwIfAborted();
            const payload = missingRecords.map((record) => `${JSON.stringify(record)}\n`).join("");
            await appendFile(ledgerPath, payload, { encoding: "utf8", mode: 0o600 });
          }
        } catch {
          if (options.signal?.aborted) options.signal.throwIfAborted();
          // Non-fatal if ledger cannot be written.
        }
      }
    });
  }

  return { records, diagnostics };
}
