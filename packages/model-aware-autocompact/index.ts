import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	adoptLegacyContextGuard,
	isValidPercent,
	loadConfig,
	saveConfig as persistConfig,
	shouldAdoptLegacyGuard,
} from "./config.ts";
import {
	createOverheadTracker,
	decideGuard,
	estimateRawTokens,
	estimateMessageTokens,
	type GuardMessage,
	type OverheadTracker,
} from "./context-guard.ts";
import { createSummaryGuard } from "./output-summaries.ts";

const STATUS_KEY = "model-aware-autocompact";

function modelKey(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	let config = loadConfig(agentDir);
	let pendingLegacyAdoption = shouldAdoptLegacyGuard(agentDir);
	const saveConfig = () => persistConfig(agentDir, config);

	function percentFor(
		model: { provider: string; id: string } | undefined,
	): number {
		if (!model) return config.percent;
		return config.models[modelKey(model)] ?? config.percent;
	}

	function thresholdFor(contextWindow: number, percent: number): number {
		return Math.floor(contextWindow * (percent / 100));
	}

	// Keep our own lock through the callback, not just session_compact (which fires
	// before Pi clears its controller). External compactions have their own lock.
	let compacting: object | undefined;
	let externalCompacting = false;
	let agentRunning = false;
	const trackers = new Map<string, OverheadTracker>();
	const summaryGuard = createSummaryGuard();
	let projectionEpoch = 0;
	let lastRequest: {
		model: string;
		raw: number;
		appendedTokens: number;
		trimmed: boolean;
	} | undefined;
	let summaryWarnedThisRun = false;
	let notifiedThisRun = false;
	let hookSeen = false;
	let windowSeen = false;
	let llmCalls = 0;
	const warned = new Set<string>();

	function trackerFor(ctx: ExtensionContext): OverheadTracker {
		const key = ctx.model ? modelKey(ctx.model) : "?/?";
		let tracker = trackers.get(key);
		if (!tracker) {
			tracker = createOverheadTracker();
			trackers.set(key, tracker);
		}
		return tracker;
	}

	function resetProjection(): void {
		projectionEpoch++;
		summaryGuard.reset();
		lastRequest = undefined;
	}

	function notify(
		ctx: ExtensionContext,
		message: string,
		type: "info" | "warning",
	): void {
		try {
			if (ctx.hasUI) ctx.ui.notify(`model-aware-autocompact: ${message}`, type);
		} catch {
			// A guard diagnostic must never break a request.
		}
	}

	function warn(ctx: ExtensionContext, kind: string, message: string): void {
		if (warned.has(kind)) return;
		warned.add(kind);
		notify(ctx, message, "warning");
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.model?.contextWindow) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}

		const percent = percentFor(ctx.model);
		const threshold = thresholdFor(ctx.model.contextWindow, percent);
		const overridden =
			config.models[modelKey(ctx.model)] === undefined ? "" : "*";
		const compactThreshold =
			threshold >= 1_000_000
				? `${Number((threshold / 1_000_000).toFixed(1))}m`
				: `${Math.round(threshold / 1_000)}k`;
		ctx.ui.setStatus(
			STATUS_KEY,
			`compact ${percent}%${overridden}/${compactThreshold}`,
		);
	}

	function compactIfNeeded(ctx: ExtensionContext): void {
		if (
			compacting ||
			externalCompacting ||
			agentRunning ||
			!ctx.isIdle() ||
			ctx.hasPendingMessages()
		)
			return;

		const usage = ctx.getContextUsage();
		// Unknown usage immediately after compaction must not reuse an old estimate.
		if (!usage || usage.tokens === null || !(usage.contextWindow > 0)) return;

		let tokens = usage.tokens;
		if (
			ctx.model &&
			lastRequest?.model === modelKey(ctx.model) &&
			lastRequest.trimmed
		) {
			// A trimmed provider report must not hide untrimmed transcript growth from
			// the configured percentage policy. Never reuse a different model/projection.
			tokens = Math.max(
				tokens,
				trackerFor(ctx).adjust(lastRequest.raw + lastRequest.appendedTokens),
			);
		}
		const percent = percentFor(ctx.model);
		const threshold = thresholdFor(usage.contextWindow, percent);
		if (tokens < threshold) return;

		const owner = {};
		compacting = owner;
		if (ctx.hasUI) {
			ctx.ui.notify(
				`上下文已达 ${((tokens / usage.contextWindow) * 100).toFixed(1)}%，开始自动 compact（阈值 ${percent}% / ${threshold.toLocaleString()} tokens）`,
				"info",
			);
		}

		try {
			ctx.compact({
				customInstructions: `Triggered automatically at ${percent}% context usage.`,
				onComplete: () => {
					if (compacting !== owner) return;
					compacting = undefined;
					resetProjection();
					if (ctx.hasUI) ctx.ui.notify("自动 compact 完成", "info");
				},
				onError: (error) => {
					if (compacting !== owner) return;
					compacting = undefined;
					if (ctx.hasUI)
						ctx.ui.notify(`自动 compact 失败：${error.message}`, "error");
				},
			});
		} catch (error) {
			if (compacting === owner) compacting = undefined;
			throw error;
		}
	}

	function parsePercent(value: string): number | undefined {
		const percent = Number(value.replace(/%$/, ""));
		return isValidPercent(percent) ? percent : undefined;
	}

	pi.on("session_start", (_event, ctx) => {
		compacting = undefined;
		externalCompacting = false;
		agentRunning = false;
		resetProjection();
		trackers.clear();
		hookSeen = false;
		windowSeen = false;
		llmCalls = 0;
		warned.clear();
		notifiedThisRun = false;
		summaryWarnedThisRun = false;
		updateStatus(ctx);
		if (pendingLegacyAdoption) {
			pendingLegacyAdoption = false;
			try {
				config = adoptLegacyContextGuard(agentDir, config.contextGuard);
				updateStatus(ctx);
			} catch (error) {
				notify(
					ctx,
					`could not save the inherited contextGuard setting: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
		}
	});
	pi.on("session_tree", () => resetProjection());
	pi.on("session_shutdown", () => resetProjection());

	pi.on("context", async (event, ctx) => {
		if (!config.contextGuard.enabled || compacting || externalCompacting) return;
		hookSeen = true;
		lastRequest = undefined;
		if (event.messages.length === 0) return;
		let systemPrompt = "";
		try {
			systemPrompt = ctx.getSystemPrompt() ?? "";
		} catch {
			/* still measure messages */
		}
		const messages = event.messages as unknown as GuardMessage[];
		const raw = estimateRawTokens(messages, systemPrompt);
		const tracker = trackerFor(ctx);
		const settings = config.contextGuard;
		const decision = decideGuard(
			tracker.adjust(raw),
			ctx.model?.contextWindow ?? 0,
			settings,
		);
		const request = {
			model: ctx.model ? modelKey(ctx.model) : "?/?",
			raw,
			appendedTokens: 0,
			trimmed: false,
		};
		lastRequest = request;
		if (decision.window <= 0) return;
		windowSeen = true;
		const epoch = projectionEpoch;
		const plan = await summaryGuard.apply(
			messages,
			{
				targetTokens: decision.trim
					? decision.targetTokens
					: Number.POSITIVE_INFINITY,
				keepVerbatimTokens: settings.keepVerbatimTokens,
				minElideTokens: settings.minElideTokens,
			},
			ctx,
			config.compressModel,
		);
		// Never apply a late summary to a different session, model or projection.
		if (
			epoch !== projectionEpoch || lastRequest !== request ||
			!ctx.model || modelKey(ctx.model) !== request.model
		) return;
		if (plan.summaryError && !summaryWarnedThisRun) {
			summaryWarnedThisRun = true;
			const hint = config.compressModel !== undefined
				? " Check compressModel and that model's login."
				: "";
			notify(ctx, `tool-output summary failed; original output kept.${hint}`, "warning");
		}
		if (!plan.changed) return;
		request.trimmed = true;
		if (plan.elidedNow > 0 && !notifiedThisRun) {
			notifiedThisRun = true;
			notify(
				ctx,
				`context reached ${Math.round(decision.percent * 100)}% of the ` +
					`${decision.window.toLocaleString("en-US")}-token window mid-run; older tool output is ` +
					"being replaced by cached summaries in requests. Nothing was removed from the transcript.",
				"info",
			);
		}
		return { messages: plan.messages as unknown as typeof event.messages };
	});

	pi.on("message_end", (event, ctx) => {
		if (!config.contextGuard.enabled) return;
		// The last context hook precedes the response and its tool results. Include
		// those newly appended messages without learning overhead from generated output.
		if (lastRequest && ctx.model && lastRequest.model === modelKey(ctx.model)) {
			lastRequest.appendedTokens += estimateMessageTokens(
				event.message as unknown as GuardMessage,
			);
		}
		const usage =
			event.message.role === "assistant" ? event.message.usage : undefined;
		if (usage) llmCalls++;
		if (llmCalls >= 5) {
			if (!hookSeen) {
				warn(
					ctx,
					"hook_missing",
					"the context guard is NOT running: this Pi build no longer calls the pre-request hook it " +
						"needs, so long autonomous runs are unprotected against context overflow again. Check for an extension update.",
				);
			} else if (!windowSeen) {
				warn(
					ctx,
					"window_unknown",
					`the context guard is standing down on ${ctx.model?.provider}/${ctx.model?.id}: Pi does not ` +
						"know this model's context window, so there is nothing to measure against. Give the model a contextWindow in models.json to switch the guard back on.",
				);
			}
		}
		if (
			!usage ||
			!lastRequest ||
			lastRequest.trimmed ||
			!ctx.model ||
			lastRequest.model !== modelKey(ctx.model)
		)
			return;
		const reported =
			Number(usage.input ?? 0) +
			Number(usage.cacheRead ?? 0) +
			Number(usage.cacheWrite ?? 0);
		if (reported > 0) trackerFor(ctx).observe(lastRequest.raw, reported);
	});

	pi.on("agent_start", () => {
		agentRunning = true;
		notifiedThisRun = false;
		summaryWarnedThisRun = false;
		summaryGuard.beginRun();
	});

	pi.on("model_select", (event, ctx) => {
		resetProjection();
		updateStatus(ctx);
		const percent = percentFor(event.model);
		const threshold = thresholdFor(event.model.contextWindow, percent);
		if (event.source !== "restore" && ctx.hasUI) {
			const scope =
				config.models[modelKey(event.model)] === undefined
					? "默认"
					: "模型专用";
			ctx.ui.notify(
				`已应用${scope}阈值 ${percent}%：${threshold.toLocaleString()} / ${event.model.contextWindow.toLocaleString()} tokens`,
				"info",
			);
		}

		// 切到更小的上下文窗口后，当前会话可能已经超过新阈值。
		if (event.source !== "restore") compactIfNeeded(ctx);
	});

	// 等待 Agent 完全结束（包括工具调用、重试和后续消息）后再 compact，
	// 避免在连续工具调用过程中打断任务。
	pi.on("agent_settled", (_event, ctx) => {
		agentRunning = false;
		compactIfNeeded(ctx);
	});
	pi.on("session_before_compact", () => {
		externalCompacting = true;
		resetProjection();
	});
	pi.on("session_compact", () => {
		externalCompacting = false;
		resetProjection();
	});
	pi.on("session_compact_failed", () => {
		externalCompacting = false;
	});

	pi.registerCommand("autocompact-percent", {
		description: "查看或永久设置默认/指定模型的自动 compact 百分比",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const currentKey = ctx.model ? modelKey(ctx.model) : undefined;

			if (parts.length === 0 || parts[0] === "status") {
				const percent = percentFor(ctx.model);
				const contextWindow = ctx.model?.contextWindow;
				const threshold = contextWindow
					? thresholdFor(contextWindow, percent)
					: undefined;
				const override =
					currentKey && config.models[currentKey] !== undefined
						? `，模型专用：${config.models[currentKey]}%`
						: "，当前模型使用默认值";
				ctx.ui.notify(
					`默认阈值：${config.percent}%${override}${threshold ? `（当前 ${threshold.toLocaleString()} tokens）` : ""}`,
					"info",
				);
				return;
			}

			if (parts[0] === "list") {
				const entries = Object.entries(config.models);
				ctx.ui.notify(
					entries.length
						? `默认 ${config.percent}%\n${entries.map(([key, percent]) => `${key}: ${percent}%`).join("\n")}`
						: `默认 ${config.percent}%；暂无模型专用设置`,
					"info",
				);
				return;
			}

			if (parts[0] === "reset") {
				const key =
					parts[1] === "current" || parts[1] === "-c" ? currentKey : parts[1];
				if (!key) {
					ctx.ui.notify(
						"用法：/autocompact-percent reset <provider/model|-c>",
						"error",
					);
					return;
				}
				delete config.models[key];
				try {
					saveConfig();
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`保存失败：${message}`, "error");
					return;
				}
				updateStatus(ctx);
				ctx.ui.notify(`${key} 已恢复使用默认阈值 ${config.percent}%`, "info");
				return;
			}

			// 单个数字：修改全局默认值。
			if (parts.length === 1) {
				const percent = parsePercent(parts[0]);
				if (percent === undefined) {
					ctx.ui.notify("用法：/autocompact-percent 50", "error");
					return;
				}
				config.percent = percent;
				try {
					saveConfig();
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`保存失败：${message}`, "error");
					return;
				}
				updateStatus(ctx);
				ctx.ui.notify(`自动 compact 默认阈值已永久设为 ${percent}%`, "info");
				compactIfNeeded(ctx);
				return;
			}

			// 模型加数字：修改指定模型；-c（或 current）表示当前模型。
			const key =
				parts[0] === "current" || parts[0] === "-c" ? currentKey : parts[0];
			const percent = parsePercent(parts[1]);
			if (!key || percent === undefined || !key.includes("/")) {
				ctx.ui.notify(
					"用法：/autocompact-percent <provider/model|-c> <百分比>",
					"error",
				);
				return;
			}

			const slash = key.indexOf("/");
			const provider = key.slice(0, slash);
			const modelId = key.slice(slash + 1);
			if (!ctx.modelRegistry.find(provider, modelId)) {
				ctx.ui.notify(`找不到模型：${key}`, "error");
				return;
			}

			config.models[key] = percent;
			try {
				saveConfig();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`保存失败：${message}`, "error");
				return;
			}
			updateStatus(ctx);
			ctx.ui.notify(`${key} 的自动 compact 阈值已永久设为 ${percent}%`, "info");
			if (key === currentKey) compactIfNeeded(ctx);
		},
	});
}
