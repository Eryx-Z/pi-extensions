/** Versioned failover state persistence. Migration and best-effort writes stay here. */

import { type ModelRef } from "./provider-ids.ts";
import { type UsageSnapshot } from "./usage.ts";
import { type CodexCatalogSnapshot } from "./model-catalog.ts";
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { STATE_PATH } from "./agent-paths.ts";
import { dirname } from "node:path";

export type SwitchRecord = {
	from: ModelRef;
	to: ModelRef;
	reason: string;
	at: number;
};

export type InvalidationRecord = { tokenHash: string; at: number; reason: string };

export type ProviderFailoverState = {
	stateVersion?: number;
	exhaustedUntilByProvider?: Record<string, number>;
	exhaustedUntilByModel?: Record<string, number>;
	invalidatedByProvider?: Record<string, InvalidationRecord>;
	// Providers whose usage-% reading has been PROVEN not to reflect the real limit, because the
	// account refused while the meter still claimed headroom. Persisted so a restart cannot go
	// back to believing a meter already caught lying — that amnesia re-opened the retry loop once
	// per session.
	usageUntrustedUntilByProvider?: Record<string, number>;
	usageByProvider?: Record<string, UsageSnapshot>;
	codexModelCatalogByProvider?: Record<string, CodexCatalogSnapshot>;
	pendingContinuationPrompt?: string;
	pendingFrom?: ModelRef;
	pendingSince?: number;
	pendingReason?: string;
	lastSwitches?: SwitchRecord[];
	/** Last model the user was actually on (failover destination included). Restored after catalogs load. */
	lastUserModel?: { provider: string; id: string };
	/** Thinking level the session ran at (high/max/…). Pi clamps it to the fallback model's caps at restore time, so persist and re-assert after the model is back. */
	lastUserThinkingLevel?: string;
	/** Last chosen model id per family, so /next into that family does not land on the baked-in fallback. */
	lastModelByFamily?: Record<string, string>;
};
export const STATE_VERSION = 5;
const MAX_MIGRATED_COOLDOWN_MS = 8 * 24 * 60 * 60 * 1000;

export function loadState(): ProviderFailoverState {
	try {
		if (!existsSync(STATE_PATH)) return { stateVersion: STATE_VERSION };
		const state = JSON.parse(
			readFileSync(STATE_PATH, "utf8"),
		) as ProviderFailoverState;
		if (state.stateVersion !== STATE_VERSION) {
			if (state.stateVersion === 4) {
				const migrated: ProviderFailoverState = {
					...state,
					stateVersion: STATE_VERSION,
					exhaustedUntilByModel: {},
				};
				saveState(migrated);
				return migrated;
			}
			// v3 could turn one physical 401 into three failures (response/message/agent hooks)
			// and then persist a one-year invalidation. Keep only plausible quota cooldowns;
			// discard invalidations and pending work produced by that broken state machine.
			const now = Date.now();
			const plausibleCooldowns = Object.fromEntries(
				Object.entries(state.exhaustedUntilByProvider ?? {}).filter(
					([, until]) =>
						Number.isFinite(until) &&
						until > now &&
						until <= now + MAX_MIGRATED_COOLDOWN_MS,
				),
			);
			const migrated: ProviderFailoverState = {
				stateVersion: STATE_VERSION,
				exhaustedUntilByProvider: plausibleCooldowns,
				exhaustedUntilByModel: {},
				invalidatedByProvider: {},
				lastSwitches: state.lastSwitches ?? [],
				// A version bump must not forget which model the user was actually on.
				lastUserModel: state.lastUserModel,
				lastUserThinkingLevel: state.lastUserThinkingLevel,
				lastModelByFamily: state.lastModelByFamily,
			};
			saveState(migrated);
			return migrated;
		}
		return state;
	} catch {
		return { stateVersion: STATE_VERSION };
	}
}

export function saveState(state: ProviderFailoverState) {
	// Best-effort: a locked/read-only/full disk must never crash the host. Losing a
	// state write only costs a cooldown estimate that is re-derived on the next error.
	try {
		mkdirSync(dirname(STATE_PATH), { recursive: true, mode: 0o700 });
		// Atomic: a crash mid-write (the EPIPE exit already cost us lastUserModel once)
		// must leave the PREVIOUS complete file, not a truncated JSON the next process
		// discards wholesale.
		const tmp = `${STATE_PATH}.tmp`;
		writeFileSync(
			tmp,
			`${JSON.stringify({ stateVersion: STATE_VERSION, ...state }, null, "\t")}\n`,
			{ encoding: "utf8", mode: 0o600 },
		);
		renameSync(tmp, STATE_PATH);
	} catch {
		/* persistence is non-critical; in-memory state remains correct */
	}
}
