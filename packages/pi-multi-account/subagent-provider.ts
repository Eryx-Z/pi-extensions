import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { applyCodexFastMode, isCodexFastModel, readCodexFastEnabled } from "./codex-fast.ts";
import { applyXaiFastMode, isXaiFastModel, readXaiFastEnabled } from "./xai-fast.ts";
import { registerCodexChildProvider } from "./provider-slots.ts";

/** Provider-only RPC startup: no tools, account rotation, model restore or UI hooks. */
export default function subagentProvider(pi: ExtensionAPI) {
  const roleRunPath = process.env.PI_RPC_SUBAGENT_ROLE_RUN;
  const path = roleRunPath || process.env.PI_RPC_SUBAGENT_LOADOUT;
  if (process.env.PI_RPC_SUBAGENT_CHILD !== "1" || !path) throw new Error("Provider entrypoint requires an RPC subagent loadout or role run");
  const input = JSON.parse(readFileSync(path, "utf8"));
  const model = roleRunPath ? input?.plan?.model : input?.model;
  const provider = typeof model === "string" ? model.split("/")[0] : "";
  if (/^openai-codex(?:-account-\d+)?$/.test(provider)) {
    registerCodexChildProvider(pi, provider);
  } else if (!/^xai(?:-account-\d+)?$/.test(provider)) {
    throw new Error(`Unsupported child provider: ${provider}`);
  }
  // Mesh children do not load pi-multi-account's parent hooks. This hook bridges
  // shared Codex and xAI fast-mode preferences into RPC children. Tests may omit `on`.
  const events = pi as {
    on?: (
      event: "before_provider_request",
      handler: (
        event: { payload?: unknown },
        ctx?: { model?: { provider?: unknown; api?: unknown; id?: unknown } },
      ) => unknown,
    ) => void;
  };
  if (typeof events.on === "function") {
    events.on("before_provider_request", (event, ctx) => {
      if (isCodexFastModel(ctx?.model)) {
        return applyCodexFastMode(event?.payload, readCodexFastEnabled());
      }
      if (isXaiFastModel(ctx?.model)) {
        return applyXaiFastMode(event?.payload, readXaiFastEnabled());
      }
      return undefined;
    });
  }
}
