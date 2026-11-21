import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { basename } from "node:path";

function resolveTerminalLaunch(cwd: string): {
	command: string;
	args: string[];
	displayName: string;
} {
	const raw = process.env.TERMINAL?.trim();
	if (!raw) {
		return {
			command: "kitty",
			args: ["--directory", cwd],
			displayName: "Kitty",
		};
	}
	const parts = raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [raw];
	const unquoted = parts.map((part) => part.replace(/^["']|["']$/g, ""));
	const command = unquoted[0] || "kitty";
	const extraArgs = unquoted.slice(1);
	const base = basename(command).toLowerCase();
	if (base === "kitty") {
		const hasDirFlag = extraArgs.some(
			(arg) =>
				arg === "--directory" ||
				arg === "-d" ||
				arg.startsWith("--directory="),
		);
		return {
			command,
			args: hasDirFlag ? extraArgs : [...extraArgs, "--directory", cwd],
			displayName: command === "kitty" ? "Kitty" : command,
		};
	}
	return {
		command,
		args: extraArgs,
		displayName: command,
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("d", {
		description: "在 Pi 当前工作目录打开一个新的终端（默认 Kitty，支持 $TERMINAL）",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				if (ctx.hasUI) ctx.ui.notify("/d 只能在 TUI 模式中使用", "warning");
				return;
			}

			const { command, args, displayName } = resolveTerminalLaunch(ctx.cwd);
			const child = spawn(command, args, {
				cwd: ctx.cwd,
				detached: true,
				stdio: "ignore",
			});

			const onSpawn = () => {
				child.removeListener("error", onError);
				child.unref();
				ctx.ui.notify(`已打开终端：${ctx.cwd}`, "info");
			};

			const onError = (error: Error) => {
				child.removeListener("spawn", onSpawn);
				ctx.ui.notify(`无法打开 ${displayName}：${error.message}`, "error");
			};

			child.once("spawn", onSpawn);
			child.once("error", onError);
		},
	});
}
