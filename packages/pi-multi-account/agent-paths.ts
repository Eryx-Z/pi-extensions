/** Shared agent paths. Capture the host-selected directory once, as the parent entry did. */

import { join } from "node:path";
import { homedir } from "node:os";

export const AGENT_DIR =
	process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
export const CONFIG_PATH = join(AGENT_DIR, "provider-failover.json");
export const STATE_PATH = join(AGENT_DIR, "provider-failover-state.json");
export const AUTH_PATH = join(AGENT_DIR, "auth.json");
export const MODELS_CONFIG_PATH = join(AGENT_DIR, "models.json");
export const SETTINGS_PATH = join(AGENT_DIR, "settings.json");
