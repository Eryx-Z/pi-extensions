import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { registerAntigravitySlot } from "./index.ts";

/** Provider-only RPC startup: no tools, account rotation, model restore or UI hooks. */
export default function subagentProvider(pi: ExtensionAPI) {
  const path = process.env.PI_RPC_SUBAGENT_LOADOUT;
  if (process.env.PI_RPC_SUBAGENT_CHILD !== "1" || !path) throw new Error("Provider entrypoint requires an RPC subagent loadout");
  const loadout = JSON.parse(readFileSync(path, "utf8"));
  const provider = typeof loadout.model === "string" ? loadout.model.split("/")[0] : "";
  if (!/^antigravity(?:-account-\d+)?$/.test(provider)) throw new Error(`Unsupported child provider: ${provider}`);
  registerAntigravitySlot(pi, provider);
}
