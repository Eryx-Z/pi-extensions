import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { applyCodexFastMode, isCodexFastModel, readCodexFastEnabled } from "./codex-fast.ts";
import { registerAntigravitySlot, registerCodexChildProvider } from "./index.ts";

/** Provider-only RPC startup: no tools, account rotation, model restore or UI hooks. */
export default function subagentProvider(pi: ExtensionAPI) {
  const path = process.env.PI_RPC_SUBAGENT_LOADOUT;
  if (process.env.PI_RPC_SUBAGENT_CHILD !== "1" || !path) throw new Error("Provider entrypoint requires an RPC subagent loadout");
  const loadout = JSON.parse(readFileSync(path, "utf8"));
  const provider = typeof loadout.model === "string" ? loadout.model.split("/")[0] : "";
  if (/^antigravity(?:-account-\d+)?$/.test(provider)) {
    registerAntigravitySlot(pi, provider);
  } else if (/^openai-codex(?:-account-\d+)?$/.test(provider)) {
    registerCodexChildProvider(pi, provider);
  } else {
    throw new Error(`Unsupported child provider: ${provider}`);
  }
  // Mesh children do not load pi-codex-fast-mode. This hook is the only place
  // their Codex requests can pick up the shared preference. Tests may omit `on`.
  const events = pi as {
    on?: (
      event: "before_provider_request",
      handler: (
        event: { payload?: unknown },
        ctx?: { model?: { provider?: unknown; api?: unknown } },
      ) => unknown,
    ) => void;
  };
  if (typeof events.on === "function") {
    events.on("before_provider_request", (event, ctx) => {
      if (!isCodexFastModel(ctx?.model)) return undefined;
      return applyCodexFastMode(event?.payload, readCodexFastEnabled());
    });
  }
}
