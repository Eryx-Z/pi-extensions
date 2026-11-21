/** Lightweight cross-process atomic file lock with dead-PID and stale-timeout preemption. */

import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";

const heldInProcess = new Set<string>();
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

export interface FileLockOptions {
	staleMs?: number;
	waitMs?: number;
}

export class FileLockTimeoutError extends Error {
	readonly targetPath: string;
	readonly waitMs: number;
	constructor(targetPath: string, waitMs: number) {
		super(`Timed out after ${waitMs}ms waiting for file lock on ${targetPath}`);
		this.name = "FileLockTimeoutError";
		this.targetPath = targetPath;
		this.waitMs = waitMs;
	}
}

export function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function sleepSync(ms: number): void {
	if (ms <= 0) return;
	Atomics.wait(sleepBuffer, 0, 0, ms);
}

function isLockStale(lockPath: string, staleMs: number, now: number): boolean {
	let mtimeMs = 0;
	try {
		mtimeMs = statSync(lockPath).mtimeMs;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
	try {
		const raw = readFileSync(lockPath, "utf8");
		const parsed = JSON.parse(raw) as { pid?: unknown; acquiredAt?: unknown };
		const pid = typeof parsed?.pid === "number" ? parsed.pid : NaN;
		const acquiredAt =
			typeof parsed?.acquiredAt === "number" && Number.isFinite(parsed.acquiredAt)
				? parsed.acquiredAt
				: mtimeMs;
		if (!isProcessAlive(pid)) return true;
		return now - Math.min(acquiredAt, mtimeMs) > staleMs;
	} catch {
		return now - mtimeMs > Math.min(250, staleMs);
	}
}

function releaseOwnedLock(lockPath: string, token: string): void {
	try {
		const raw = readFileSync(lockPath, "utf8");
		const parsed = JSON.parse(raw) as { token?: unknown };
		if (parsed?.token === token) {
			rmSync(lockPath, { force: true });
		}
	} catch {
		// Already removed or preempted after stall.
	}
}

function preemptStaleLockSync(lockPath: string): void {
	const stalePath = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
	try {
		renameSync(lockPath, stalePath);
		rmSync(stalePath, { force: true });
	} catch {
		// Another waiter already preempted or removed it.
		try {
			rmSync(stalePath, { force: true });
		} catch {
			/* ignore */
		}
	}
}

function tryAcquireLockSync(lockPath: string, token: string): boolean {
	try {
		const fd = openSync(
			lockPath,
			constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
			0o600,
		);
		try {
			const payload = JSON.stringify({
				pid: process.pid,
				token,
				acquiredAt: Date.now(),
			});
			writeSync(fd, payload, 0, "utf8");
		} finally {
			closeSync(fd);
		}
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			return false;
		}
		throw error;
	}
}

export function withFileLockSync<T>(
	targetPath: string,
	fn: () => T,
	options?: FileLockOptions,
): T {
	const canonical = resolvePath(targetPath);
	if (heldInProcess.has(canonical)) {
		return fn();
	}

	const staleMs = options?.staleMs ?? 5_000;
	const waitMs = options?.waitMs ?? 2_000;
	const lockPath = `${canonical}.lock`;
	const token = randomUUID();
	mkdirSync(dirname(canonical), { recursive: true, mode: 0o700 });

	const deadline = Date.now() + Math.max(0, waitMs);
	let delayMs = 2;

	while (!tryAcquireLockSync(lockPath, token)) {
		const now = Date.now();
		if (isLockStale(lockPath, staleMs, now)) {
			preemptStaleLockSync(lockPath);
			continue;
		}
		if (now >= deadline) {
			// Never delete a non-stale lock held by a live process.
			throw new FileLockTimeoutError(canonical, waitMs);
		}
		sleepSync(Math.min(delayMs, 10, Math.max(1, deadline - now)));
		delayMs = Math.min(10, delayMs + 2);
	}

	heldInProcess.add(canonical);
	try {
		return fn();
	} finally {
		heldInProcess.delete(canonical);
		releaseOwnedLock(lockPath, token);
	}
}

export async function withFileLockAsync<T>(
	targetPath: string,
	fn: () => Promise<T> | T,
	options?: FileLockOptions,
): Promise<T> {
	const canonical = resolvePath(targetPath);
	if (heldInProcess.has(canonical)) {
		return await fn();
	}

	const staleMs = options?.staleMs ?? 5_000;
	const waitMs = options?.waitMs ?? 2_000;
	const lockPath = `${canonical}.lock`;
	const token = randomUUID();
	mkdirSync(dirname(canonical), { recursive: true, mode: 0o700 });

	const deadline = Date.now() + Math.max(0, waitMs);
	let delayMs = 4;

	while (!tryAcquireLockSync(lockPath, token)) {
		const now = Date.now();
		if (isLockStale(lockPath, staleMs, now)) {
			preemptStaleLockSync(lockPath);
			continue;
		}
		if (now >= deadline) {
			throw new FileLockTimeoutError(canonical, waitMs);
		}
		const stepMs = Math.min(delayMs, 20, Math.max(1, deadline - now));
		await new Promise((resolve) => setTimeout(resolve, stepMs));
		delayMs = Math.min(20, delayMs + 4);
	}

	heldInProcess.add(canonical);
	try {
		return await fn();
	} finally {
		heldInProcess.delete(canonical);
		releaseOwnedLock(lockPath, token);
	}
}
