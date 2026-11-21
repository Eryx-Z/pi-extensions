import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type SessionContext = { sessionManager: { getSessionId(): string; getLeafId?: () => string } };

const registeredApis = new WeakSet<object>();

export function registerSessionLifecycleHooks(
  pi: ExtensionAPI,
  dependencies: {
    cleanupSessionState: (sessionId: string) => void;
    /** Start a new Cursor-side conversation, keeping the session alive. */
    resetConversationForSession?: (sessionId: string) => void;
    stopProxy: () => void;
    debug?: (event: string, data: Record<string, unknown>) => void;
  },
): void {
  if (!pi || typeof pi !== "object" || registeredApis.has(pi)) return;
  registeredApis.add(pi);
  const cleanupCurrentSession = (_event: unknown, ctx: SessionContext) => {
    dependencies.debug?.("session.cleanup_hook", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
    });
    dependencies.cleanupSessionState(ctx.sessionManager.getSessionId());
  };

  pi.on("session_before_switch", cleanupCurrentSession as any);
  pi.on("session_before_fork", cleanupCurrentSession as any);
  pi.on("session_before_tree", cleanupCurrentSession as any);
  // Compaction is the one event that changes what the conversation IS without ending it.
  // Cursor never sees Pi's compacted message list while it holds a checkpoint, so unless the
  // conversation is restarted here, the model keeps the full pre-compaction context and keeps
  // reporting its size — which sends Pi straight into compacting again on the next turn.
  pi.on("session_compact", ((_event: unknown, ctx: SessionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    dependencies.debug?.("session.compact_hook", {
      sessionId,
      leafId: ctx.sessionManager.getLeafId?.(),
    });
    dependencies.resetConversationForSession?.(sessionId);
  }) as any);
  pi.on("session_shutdown", ((event: unknown, ctx: SessionContext) => {
    cleanupCurrentSession(event, ctx);
    // The proxy is process-scoped. Leaving its referenced HTTP listener open after Pi's
    // shutdown makes one-shot `pi -p` delegation print the right answer and then hang forever.
    dependencies.stopProxy();
  }) as any);
}
