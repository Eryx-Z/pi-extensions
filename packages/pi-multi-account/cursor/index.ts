/**
 * Cursor Provider Extension for pi
 *
 * Provides access to Cursor models (Claude, GPT, Gemini, etc.) via:
 * 1. Browser-based PKCE OAuth login to Cursor
 * 2. Local proxy translating OpenAI format → Cursor gRPC protocol
 *
 * Usage:
 *   /login cursor    — authenticate via browser
 *   /model           — select any Cursor model
 *
 * Based on https://github.com/ephraimduncan/opencode-cursor by Ephraim Duncan.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import {
  generateCursorAuthParams,
  getTokenExpiry,
  pollCursorAuth,
  refreshCursorToken,
} from "./auth.ts";
import { cleanupSessionState, getCursorModels, resetConversationForSession, startProxy, stopProxy, type CursorModel } from "./proxy.ts";
import { registerSessionLifecycleHooks } from "./session-lifecycle.ts";

import { FALLBACK_MODELS, modelConfig, processModels, type ProcessedModel } from "./models.ts";

// Keep the single-account entry point's existing model exports compatible.
export {
  FALLBACK_MODELS,
  buildEffortMap,
  modelConfig,
  parseModelId,
  processModels,
  supportsReasoningModelId,
} from "./models.ts";

let extensionDebugLogFilePath: string | undefined;

function isExtensionDebugEnabled(): boolean {
  const raw = process.env.PI_CURSOR_PROVIDER_DEBUG?.trim().toLowerCase();
  return !!raw && raw !== "0" && raw !== "false" && raw !== "off";
}

function getExtensionDebugLogFilePath(): string {
  if (extensionDebugLogFilePath) return extensionDebugLogFilePath;
  const configured = process.env.PI_CURSOR_PROVIDER_EXTENSION_DEBUG_FILE?.trim();
  if (configured) {
    extensionDebugLogFilePath = configured;
    return extensionDebugLogFilePath;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  extensionDebugLogFilePath = pathJoin(tmpdir(), `pi-cursor-provider-extension-debug-${stamp}-${process.pid}.log`);
  return extensionDebugLogFilePath;
}

function truncateDebugValue(value: string, max = 240): string {
  return value.length > max ? `${value.slice(0, max)}…<truncated ${value.length - max} chars>` : value;
}

function summarizeContent(content: unknown): unknown {
  if (typeof content === "string") return truncateDebugValue(content);
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (!block || typeof block !== "object") return block;
    const typed = block as Record<string, unknown>;
    switch (typed.type) {
      case "text":
        return { type: "text", text: truncateDebugValue(String(typed.text ?? "")) };
      case "thinking":
        return { type: "thinking", thinking: truncateDebugValue(String(typed.thinking ?? "")) };
      case "toolCall":
        return {
          type: "toolCall",
          id: typed.id,
          name: typed.name,
          arguments: typed.arguments,
        };
      case "image":
        return { type: "image", mimeType: typed.mimeType, data: `<redacted base64 ${String(typed.data ?? "").length} chars>` };
      default:
        return typed;
    }
  });
}

function summarizeMessage(message: unknown): unknown {
  if (!message || typeof message !== "object") return message;
  const typed = message as Record<string, unknown>;
  return {
    role: typed.role,
    stopReason: typed.stopReason,
    toolCallId: typed.toolCallId,
    toolName: typed.toolName,
    isError: typed.isError,
    errorMessage: typed.errorMessage,
    content: summarizeContent(typed.content),
  };
}

function summarizeBranchTail(ctx: { sessionManager?: { getBranch?: () => unknown[]; getLeafId?: () => string; getSessionId?: () => string } }, limit = 6): unknown {
  try {
    const branch = ctx.sessionManager?.getBranch?.();
    if (!Array.isArray(branch)) return undefined;
    return {
      sessionId: ctx.sessionManager?.getSessionId?.(),
      leafId: ctx.sessionManager?.getLeafId?.(),
      size: branch.length,
      tail: branch.slice(-limit).map((entry) => {
        if (!entry || typeof entry !== "object") return entry;
        const typed = entry as Record<string, unknown>;
        return {
          type: typed.type,
          id: typed.id,
          parentId: typed.parentId,
          customType: typed.customType,
          message: summarizeMessage(typed.message),
        };
      }),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function summarizeProviderPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const typed = payload as Record<string, unknown>;
  const messages = Array.isArray(typed.messages) ? typed.messages.map((message) => summarizeMessage(message)).slice(-8) : undefined;
  return {
    model: typed.model,
    stream: typed.stream,
    pi_session_id: typed.pi_session_id,
    messageCount: Array.isArray(typed.messages) ? typed.messages.length : undefined,
    messages,
    toolCount: Array.isArray(typed.tools) ? typed.tools.length : undefined,
  };
}

function debugExtensionLog(event: string, data?: Record<string, unknown>): void {
  if (!isExtensionDebugEnabled()) return;
  const payload = JSON.stringify({
    ts: new Date().toISOString(),
    pid: process.pid,
    scope: "extension",
    event,
    ...data,
  });
  appendFileSync(getExtensionDebugLogFilePath(), `${payload}\n`, "utf8");
}

// ── Extension ──

export function registerSessionLifecycleCleanup(pi: ExtensionAPI) {
  registerSessionLifecycleHooks(pi, {
    cleanupSessionState,
    resetConversationForSession,
    stopProxy,
    debug: debugExtensionLog,
  });
}

function registerExtensionDebugHooks(pi: ExtensionAPI) {
  if (!isExtensionDebugEnabled()) return;

  pi.on("message_start", async (event, ctx) => {
    if (ctx.model?.provider !== "cursor") return;
    debugExtensionLog("message.start", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
      model: ctx.model?.id,
      message: summarizeMessage((event as { message?: unknown }).message),
    });
  });

  pi.on("message_update", async (event, ctx) => {
    if (ctx.model?.provider !== "cursor") return;
    const typedEvent = event as { message?: unknown; assistantMessageEvent?: Record<string, unknown> };
    debugExtensionLog("message.update", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
      model: ctx.model?.id,
      assistantMessageEvent: typedEvent.assistantMessageEvent
        ? {
            type: typedEvent.assistantMessageEvent.type,
            delta: truncateDebugValue(String((typedEvent.assistantMessageEvent as Record<string, unknown>).delta ?? (typedEvent.assistantMessageEvent as Record<string, unknown>).content ?? "")),
          }
        : undefined,
      message: summarizeMessage(typedEvent.message),
    });
  });

  pi.on("message_end", async (event, ctx) => {
    if (ctx.model?.provider !== "cursor") return;
    debugExtensionLog("message.end", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
      model: ctx.model?.id,
      message: summarizeMessage((event as { message?: unknown }).message),
      branch: summarizeBranchTail(ctx),
    });
  });

  pi.on("context", async (event, ctx) => {
    if (ctx.model?.provider !== "cursor") return;
    const typedEvent = event as { messages?: unknown[] };
    debugExtensionLog("context", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
      model: ctx.model?.id,
      messageCount: Array.isArray(typedEvent.messages) ? typedEvent.messages.length : undefined,
      messages: Array.isArray(typedEvent.messages)
        ? typedEvent.messages.slice(-8).map((message) => summarizeMessage(message))
        : undefined,
      branch: summarizeBranchTail(ctx),
    });
  });

  pi.on("turn_end", async (event, ctx) => {
    if (ctx.model?.provider !== "cursor") return;
    const typedEvent = event as { turnIndex?: number; message?: unknown; toolResults?: unknown[] };
    debugExtensionLog("turn.end", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
      model: ctx.model?.id,
      turnIndex: typedEvent.turnIndex,
      message: summarizeMessage(typedEvent.message),
      toolResults: Array.isArray(typedEvent.toolResults)
        ? typedEvent.toolResults.map((message) => summarizeMessage(message))
        : undefined,
      branch: summarizeBranchTail(ctx),
    });
  });

  debugExtensionLog("extension.debug_hooks_registered", { logFile: getExtensionDebugLogFilePath() });
}

export default async function (pi: ExtensionAPI) {
  // Current access token, updated by login/refresh/getApiKey
  let currentToken = "";

  // Start proxy eagerly — it just binds a port, no auth needed until a request arrives.
  // The getAccessToken callback reads currentToken at request time.
  const proxyReady = startProxy(async () => {
    if (!currentToken) throw new Error("Not logged in to Cursor. Run /login cursor");
    return currentToken;
  });

  const skipDedup = !!process.env.PI_CURSOR_RAW_MODELS;

  registerSessionLifecycleCleanup(pi);
  registerExtensionDebugHooks(pi);
  debugExtensionLog("extension.start", {
    debugLogFile: isExtensionDebugEnabled() ? getExtensionDebugLogFilePath() : undefined,
  });

  pi.on("before_provider_request", (event, ctx) => {
    const payload = event.payload as Record<string, unknown> | undefined;
    if (payload && ctx.model?.provider === "cursor") {
      payload.pi_session_id = ctx.sessionManager.getSessionId();
      debugExtensionLog("before_provider_request", {
        sessionId: ctx.sessionManager.getSessionId(),
        leafId: ctx.sessionManager.getLeafId?.(),
        model: ctx.model?.id,
        payload: summarizeProviderPayload(payload),
        branch: summarizeBranchTail(ctx),
      });
    }
    return payload;
  });

  // Await proxy so models are registered before pi proceeds with model resolution.
  const port = await proxyReady;
  register(pi, port, FALLBACK_MODELS);

  function register(pi: ExtensionAPI, port: number, rawModels: CursorModel[]) {
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const processed = skipDedup
      ? rawModels.map(m => ({ ...m, supportsEffort: false } as ProcessedModel))
      : processModels(rawModels);

    pi.registerProvider("cursor", {
      baseUrl,
      api: "openai-completions",
      models: processed.map(modelConfig),
      oauth: {
        name: "Cursor",

        async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
          const { verifier, uuid, loginUrl } = await generateCursorAuthParams();
          callbacks.onAuth({ url: loginUrl });
          const { accessToken, refreshToken } = await pollCursorAuth(uuid, verifier);
          currentToken = accessToken;

          // Discover real models and re-register
          const realPort = await proxyReady;
          try {
            const discovered = await getCursorModels(accessToken);
            if (discovered.length > 0) register(pi, realPort, discovered);
          } catch {
            // catalog discovery is best-effort; FALLBACK_MODELS are already registered
          }

          return {
            refresh: refreshToken,
            access: accessToken,
            expires: getTokenExpiry(accessToken),
          };
        },

        async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
          const refreshed = await refreshCursorToken(credentials.refresh);
          currentToken = refreshed.access;

          // Discover real models on refresh too
          const realPort = await proxyReady;
          try {
            const discovered = await getCursorModels(refreshed.access);
            if (discovered.length > 0) register(pi, realPort, discovered);
          } catch {
            // catalog discovery is best-effort; FALLBACK_MODELS are already registered
          }

          return refreshed;
        },

        getApiKey(credentials: OAuthCredentials): string {
          currentToken = credentials.access;
          return "cursor-proxy";
        },
      },
    });
  }


}
