/** Request-only Anthropic OAuth shaping and Qwen role compatibility. */

import { createHash } from "node:crypto";

// ===========================================================================
// Anthropic OAuth request shaping (vendored)
//
// Makes Claude Pro/Max (OAuth) accounts work out of the box — no separate
// pi-anthropic-auth install required. Ported from gotgenes/pi-anthropic-auth
// (MIT). The logic is idempotent: if pi-anthropic-auth is ALSO installed, both
// before_provider_request hooks run, but the second sees the request already
// shaped (billing header present, Pi preamble already replaced) and no-ops.
//
// CLAUDE_CODE_VERSION must track the current Claude Code release; if it drifts
// too far Anthropic may reject or miscount OAuth requests. Check `claude
// --version` or https://github.com/anthropics/claude-code.
// ===========================================================================

const PI_DEFAULT_PROMPT_PREFIX =
	"You are an expert coding assistant operating inside pi, a coding agent harness.";
const PI_DEFAULT_PROMPT_TERMINATOR =
	"- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)";
const MINIMAL_ANTHROPIC_OAUTH_PROMPT_PREFIX =
	"You are an expert coding assistant.";
const MINIMAL_ANTHROPIC_OAUTH_PROMPT = [
	MINIMAL_ANTHROPIC_OAUTH_PROMPT_PREFIX,
	"Be concise and helpful.",
	"Use the available tools to answer the user's request.",
	"Show file paths clearly when working with files.",
].join("\n");
const CLAUDE_CODE_IDENTITY_PREFIX =
	"You are Claude Code, Anthropic's official CLI";
export const CLAUDE_CODE_VERSION = "2.1.241";
const BILLING_HEADER_SALT = "59cf53e54c78";
const BILLING_HEADER_POSITIONS = [4, 7, 20] as const;
const CLAUDE_CODE_ENTRYPOINT = "sdk-cli";
const PARAGRAPH_REMOVAL_ANCHORS: readonly string[] = [
	"operating inside pi, a coding agent harness",
	"In addition to the tools above",
	"Pi documentation (read only when the user asks about pi itself",
];
const TEXT_REPLACEMENTS: readonly { match: string; replacement: string }[] = [
	{
		match:
			"Here is some useful information about the environment you are running in:",
		replacement: "Environment context you are running in:",
	},
];

type ShapeTextBlock = { type: "text"; text: string; [key: string]: unknown };
type ShapeMessageBlock = {
	type?: string;
	text?: string;
	[key: string]: unknown;
};
type ShapeMessageParam = {
	role?: string;
	content?: string | ShapeMessageBlock[];
	[key: string]: unknown;
};
type ShapeAnthropicPayload = {
	model?: unknown;
	messages?: unknown;
	system?: unknown;
	stream?: unknown;
	[key: string]: unknown;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAnthropicMessagesPayload(
	payload: unknown,
): payload is ShapeAnthropicPayload {
	return (
		isRecord(payload) &&
		typeof payload.model === "string" &&
		Array.isArray(payload.messages) &&
		typeof payload.stream === "boolean"
	);
}

function hasOAuthAnthropicSystemMarker(block: unknown): boolean {
	if (
		!isRecord(block) ||
		block.type !== "text" ||
		typeof block.text !== "string"
	)
		return false;
	return (
		block.text.includes(CLAUDE_CODE_IDENTITY_PREFIX) ||
		block.text.includes("x-anthropic-billing-header:") ||
		block.text.startsWith(MINIMAL_ANTHROPIC_OAUTH_PROMPT_PREFIX)
	);
}

// Only requests that Pi already marked as OAuth (Claude Code identity block, or
// already-shaped) are touched — API-key Anthropic requests pass through untouched.
function isOAuthAnthropicPayload(payload: ShapeAnthropicPayload): boolean {
	if (!Array.isArray(payload.system)) return false;
	return payload.system.some(hasOAuthAnthropicSystemMarker);
}

function getFirstUserText(messages: ShapeMessageParam[]): string {
	const firstUserMessage = messages.find((message) => message.role === "user");
	if (!firstUserMessage) return "";
	if (typeof firstUserMessage.content === "string")
		return firstUserMessage.content;
	if (!Array.isArray(firstUserMessage.content)) return "";
	const firstTextBlock = firstUserMessage.content.find(
		(block) => block.type === "text" && typeof block.text === "string",
	);
	return typeof firstTextBlock?.text === "string" ? firstTextBlock.text : "";
}

function buildBillingHeaderValue(
	messages: ShapeMessageParam[],
): string | undefined {
	const messageText = getFirstUserText(messages);
	if (!messageText) return undefined;
	const cch = createHash("sha256").update(messageText).digest("hex").slice(0, 5);
	const sampledCharacters = BILLING_HEADER_POSITIONS.map(
		(index) => messageText[index] || "0",
	).join("");
	const suffix = createHash("sha256")
		.update(`${BILLING_HEADER_SALT}${sampledCharacters}${CLAUDE_CODE_VERSION}`)
		.digest("hex")
		.slice(0, 3);
	return [
		"x-anthropic-billing-header:",
		`cc_version=${CLAUDE_CODE_VERSION}.${suffix};`,
		`cc_entrypoint=${CLAUDE_CODE_ENTRYPOINT};`,
		`cch=${cch};`,
	].join(" ");
}

function normalizeSystemBlock(block: unknown): ShapeTextBlock {
	if (typeof block === "string") return { type: "text", text: block };
	if (isRecord(block) && typeof block.text === "string")
		return { ...block, type: "text", text: block.text };
	return { type: "text", text: "" };
}

function prependBillingHeader<T>(
	system: T,
	messages: ShapeMessageParam[],
): T | ShapeTextBlock[] {
	const billingHeader = buildBillingHeaderValue(messages);
	if (!billingHeader) return system;
	const systemBlocks = Array.isArray(system)
		? system.map(normalizeSystemBlock)
		: system == null
			? []
			: [normalizeSystemBlock(system)];
	// Idempotent: don't add a second billing header (e.g. pi-anthropic-auth also ran).
	if (
		systemBlocks.some((block) =>
			block.text.includes("x-anthropic-billing-header:"),
		)
	)
		return systemBlocks;
	const billingBlock: ShapeTextBlock = { type: "text", text: billingHeader };
	return [billingBlock, ...systemBlocks];
}

// The Anthropic API rejects assistant turns where non-tool_use blocks follow a
// tool_use block; Pi's serializer can produce that, so split into two turns.
function splitAssistantToolUseTrailingContent(
	messages: ShapeMessageParam[],
): ShapeMessageParam[] {
	return messages.flatMap((message) => {
		if (message.role !== "assistant" || !Array.isArray(message.content))
			return [message];
		const firstToolUseIndex = message.content.findIndex(
			(block) => block.type === "tool_use",
		);
		if (firstToolUseIndex === -1) return [message];
		const trailingBlocks = message.content.slice(firstToolUseIndex);
		if (!trailingBlocks.some((block) => block.type !== "tool_use"))
			return [message];
		const nonToolUseBlocks = message.content.filter(
			(block) => block.type !== "tool_use",
		);
		const toolUseBlocks = message.content.filter(
			(block) => block.type === "tool_use",
		);
		return [
			{ ...message, content: nonToolUseBlocks },
			{ ...message, content: toolUseBlocks },
		];
	});
}

function sanitizeSystemText(text: string): string {
	const paragraphs = text.split(/\n\n+/);
	const filtered = paragraphs.filter(
		(paragraph) =>
			!PARAGRAPH_REMOVAL_ANCHORS.some((anchor) => paragraph.includes(anchor)),
	);
	let result = filtered.join("\n\n");
	for (const rule of TEXT_REPLACEMENTS)
		result = result.replaceAll(rule.match, rule.replacement);
	return result.trim();
}

function findProjectContextStart(systemPrompt: string): number {
	return systemPrompt.indexOf("\n\n# Project Context\n\n");
}

function shapeAnthropicOAuthSystemPrompt(systemPrompt: string): string {
	const prefixIdx = systemPrompt.indexOf(PI_DEFAULT_PROMPT_PREFIX);
	if (prefixIdx === -1) return systemPrompt;
	const terminatorIdx = systemPrompt.indexOf(
		PI_DEFAULT_PROMPT_TERMINATOR,
		prefixIdx,
	);
	if (terminatorIdx !== -1) {
		const terminatorEnd = terminatorIdx + PI_DEFAULT_PROMPT_TERMINATOR.length;
		const preamble = systemPrompt.slice(prefixIdx, terminatorEnd);
		const sanitized = sanitizeSystemText(preamble);
		const shapedPreamble = sanitized
			? `${MINIMAL_ANTHROPIC_OAUTH_PROMPT}\n\n${sanitized}`
			: MINIMAL_ANTHROPIC_OAUTH_PROMPT;
		return (
			systemPrompt.slice(0, prefixIdx) +
			shapedPreamble +
			systemPrompt.slice(terminatorEnd)
		);
	}
	// Pi reworded its preamble terminator → fall back to slicing from project context.
	const projectContextStart = findProjectContextStart(systemPrompt);
	if (projectContextStart === -1) return MINIMAL_ANTHROPIC_OAUTH_PROMPT;
	return `${MINIMAL_ANTHROPIC_OAUTH_PROMPT}${systemPrompt.slice(projectContextStart)}`;
}

function shapeSystemBlocks(blocks: ShapeTextBlock[]): ShapeTextBlock[] {
	return blocks.map((block) => {
		if (block.type !== "text" || !block.text.includes(PI_DEFAULT_PROMPT_PREFIX))
			return block;
		return { ...block, text: shapeAnthropicOAuthSystemPrompt(block.text) };
	});
}

/** before_provider_request shaper: makes Claude Pro/Max OAuth requests acceptable. */
export function shapeAnthropicOAuthPayload<T>(payload: T): T | ShapeAnthropicPayload {
	if (!isAnthropicMessagesPayload(payload)) return payload;
	const messages = payload.messages as ShapeMessageParam[];
	if (!isOAuthAnthropicPayload(payload)) return payload; // API-key / non-OAuth → untouched
	const normalizedMessages = splitAssistantToolUseTrailingContent(messages);
	const shapedSystem = Array.isArray(payload.system)
		? shapeSystemBlocks(payload.system as ShapeTextBlock[])
		: payload.system;
	const finalSystem = prependBillingHeader(shapedSystem, normalizedMessages);
	return { ...payload, messages: normalizedMessages, system: finalSystem };
}

/**
 * before_provider_request shaper for Qwen/Alibaba (OpenAI-compatible). Pi sends the system
 * instructions with the OpenAI-only `developer` role (the o1+/Codex convention), but Qwen's
 * compatible-mode API rejects it with `400 invalid_parameter_error: developer is not one of
 * ['system','assistant','user','tool','function']`. Rewrite that role to `system` (which Qwen
 * accepts) in place. Idempotent and role-only — content is untouched. Returns whether it changed
 * anything, so callers/tests can assert it fired.
 */
export function rewriteDeveloperRoleToSystem(payload: unknown): boolean {
	if (!payload || typeof payload !== "object") return false;
	const messages = (payload as { messages?: unknown }).messages;
	if (!Array.isArray(messages)) return false;
	let changed = false;
	for (const message of messages) {
		if (
			message &&
			typeof message === "object" &&
			(message as { role?: unknown }).role === "developer"
		) {
			(message as { role?: unknown }).role = "system";
			changed = true;
		}
	}
	return changed;
}
