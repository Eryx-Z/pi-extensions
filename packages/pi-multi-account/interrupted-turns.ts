/** Deterministic, bounded interrupted-turn handoff rendering. */

// ---------------------------------------------------------------------------
// Interrupted-turn preservation ("black box" handoff record)
// ---------------------------------------------------------------------------
// Two independent pi-ai behaviours combine to erase the interruption point on every
// cross-provider failover:
//
//   1. `transform-messages` skips any assistant message whose stopReason is "error" or
//      "aborted" — incomplete turns are never replayed. The turn that TRIGGERED the
//      failover is exactly the turn that gets dropped.
//   2. The same pass degrades thinking blocks to plain text (and drops redacted ones
//      outright) whenever the next request runs on a different model — which is exactly
//      what an account switch does.
//
// The account taking over therefore receives a continuation prompt telling it "do not
// repeat completed work" while the record of that work has just been deleted, and its
// tool results are left in the transcript with no request to attach them to.
//
// The `context` hook runs on AgentMessage[] BEFORE convertToLlm/transformMessages, so it
// is the last point at which the interrupted turn is still intact. We rewrite it into a
// `user` message — the one role transform-messages passes through verbatim on every
// provider — folding its orphaned tool results into the same record.
//
// Invariants this rendering must keep:
//   * Deterministic: identical input produces byte-identical output, so replaying the
//     hook on every request never invalidates the prompt cache (no timestamps, no rng).
//   * Orphan-free: every tool result belonging to the dropped turn is folded in and
//     removed, so no toolResult survives without its originating tool call.
//   * Bounded: hard caps on every section, so rescuing context can never blow the
//     context window of the account we just switched to.
const HANDOFF_MARKER = "[handoff:interrupted-turn]";
const HANDOFF_MAX_TEXT = 4000;
const HANDOFF_MAX_THINKING = 3000;
const HANDOFF_MAX_ARGS = 800;
const HANDOFF_MAX_RESULT = 1000;
const HANDOFF_MAX_TOOL_CALLS = 12;
const HANDOFF_MAX_ERROR = 400;

/** Head+tail clip: the start says what the turn was doing, the tail says where it died. */
function clipHandoff(value: string, max: number): string {
	const text = value.trim();
	if (text.length <= max) return text;
	const head = Math.ceil(max * 0.6);
	const tail = max - head;
	return `${text.slice(0, head)}\n…[${text.length - max} characters omitted]…\n${text.slice(-tail)}`;
}

function handoffBlockText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block: any) =>
			block && typeof block === "object" && block.type === "text"
				? String(block.text ?? "")
				: "",
		)
		.filter(Boolean)
		.join("\n");
}

/**
 * Render the verbatim handoff record for one interrupted assistant message.
 * Returns undefined when the turn carries nothing worth preserving (a turn aborted
 * before it produced anything), so we leave those to pi's normal drop path.
 */
export function renderHandoffRecord(
	message: any,
	resultsByCallId: Map<string, any>,
): string | undefined {
	const texts: string[] = [];
	const thinking: string[] = [];
	const toolCalls: any[] = [];
	for (const block of Array.isArray(message?.content) ? message.content : []) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "text" && typeof block.text === "string") {
			if (block.text.trim()) texts.push(block.text);
		} else if (block.type === "thinking") {
			// Redacted thinking is an opaque provider-encrypted payload: it cannot be
			// replayed cross-model and has no plain text to preserve.
			if (
				!block.redacted &&
				typeof block.thinking === "string" &&
				block.thinking.trim()
			)
				thinking.push(block.thinking);
		} else if (block.type === "toolCall") {
			toolCalls.push(block);
		}
	}
	const errorMessage =
		typeof message?.errorMessage === "string" ? message.errorMessage.trim() : "";
	if (!texts.length && !thinking.length && !toolCalls.length) return undefined;

	const ref =
		message?.provider && message?.model
			? `${message.provider}/${message.model}`
			: "the previous account";
	const stopped =
		message?.stopReason === "aborted" ? "cancelled" : "interrupted";
	const lines: string[] = [
		`${HANDOFF_MARKER} The turn below ran on ${ref} and was ${stopped} before it finished.`,
		"Pi does not replay interrupted turns, so its content is reproduced here verbatim and will otherwise be lost.",
		"Treat everything in this record as work ALREADY ATTEMPTED: verify the current state before redoing any of it, and continue from the stopping point rather than from the start.",
	];
	if (thinking.length) {
		lines.push(
			"",
			"--- reasoning of the interrupted turn (verbatim) ---",
			clipHandoff(thinking.join("\n"), HANDOFF_MAX_THINKING),
		);
	}
	if (texts.length) {
		lines.push(
			"",
			"--- output written before the interruption (verbatim) ---",
			clipHandoff(texts.join("\n"), HANDOFF_MAX_TEXT),
		);
	}
	if (toolCalls.length) {
		lines.push("", "--- tool calls issued in that turn ---");
		const shown = toolCalls.slice(0, HANDOFF_MAX_TOOL_CALLS);
		shown.forEach((call: any, index: number) => {
			let args = "";
			try {
				args = JSON.stringify(call?.arguments ?? {});
			} catch {
				args = "<unserializable arguments>";
			}
			lines.push(
				`${index + 1}. ${String(call?.name ?? "unknown")} — arguments: ${clipHandoff(args, HANDOFF_MAX_ARGS)}`,
			);
			const result = resultsByCallId.get(String(call?.id));
			if (!result) {
				lines.push(
					"   result: NONE — the turn was interrupted before this call returned. Its effect is UNKNOWN and must be checked.",
				);
				return;
			}
			const body = clipHandoff(
				handoffBlockText(result.content),
				HANDOFF_MAX_RESULT,
			);
			lines.push(
				`   result${result.isError ? " (error)" : ""}: ${body || "<empty>"}`,
			);
		});
		if (toolCalls.length > shown.length)
			lines.push(
				`…and ${toolCalls.length - shown.length} further tool call(s) omitted from this record.`,
			);
	}
	if (errorMessage) {
		lines.push(
			"",
			`--- why it stopped ---`,
			clipHandoff(errorMessage, HANDOFF_MAX_ERROR),
		);
	}
	lines.push("", `--- end of ${HANDOFF_MARKER} ---`);
	return lines.join("\n");
}

/**
 * Replace every interrupted assistant message with a verbatim `user` handoff record and
 * fold in (and remove) the tool results that belonged to it. Returns the original array
 * when there is nothing to preserve, so the caller can skip the hook result entirely.
 */
export function preserveInterruptedTurns(messages: any[]): any[] {
	if (!Array.isArray(messages) || messages.length === 0) return messages;
	const interrupted = messages.filter(
		(message: any) =>
			message?.role === "assistant" &&
			(message.stopReason === "error" || message.stopReason === "aborted"),
	);
	if (interrupted.length === 0) return messages;

	// Tool results are addressed by call id, so a single index over the whole transcript
	// is enough — and it stays correct no matter how the host interleaves them.
	const resultsByCallId = new Map<string, any>();
	for (const message of messages) {
		if (message?.role === "toolResult" && message.toolCallId != null)
			resultsByCallId.set(String(message.toolCallId), message);
	}
	const foldedResultIds = new Set<string>();
	const rendered = new Map<any, string>();
	for (const message of interrupted) {
		const record = renderHandoffRecord(message, resultsByCallId);
		if (!record) continue;
		rendered.set(message, record);
		for (const block of Array.isArray(message.content) ? message.content : []) {
			if (block?.type === "toolCall" && block.id != null)
				foldedResultIds.add(String(block.id));
		}
	}
	if (rendered.size === 0) return messages;

	const out: any[] = [];
	for (const message of messages) {
		const record = rendered.get(message);
		if (record) {
			out.push({
				role: "user",
				content: [{ type: "text", text: record }],
				// Reuse the original timestamp: the record must be byte-identical on every
				// replay or it would invalidate the prompt cache on each request.
				timestamp: message.timestamp,
			});
			continue;
		}
		if (
			message?.role === "toolResult" &&
			message.toolCallId != null &&
			foldedResultIds.has(String(message.toolCallId))
		)
			continue; // folded into the record above; leaving it would orphan it
		out.push(message);
	}
	return out;
}
