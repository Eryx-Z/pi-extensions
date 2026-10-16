import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("d", {
		description: "在 Pi 当前工作目录打开一个新的 Kitty 终端",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				if (ctx.hasUI) ctx.ui.notify("/d 只能在 TUI 模式中使用", "warning");
				return;
			}

			const child = spawn("kitty", ["--directory", ctx.cwd], {
				cwd: ctx.cwd,
				detached: true,
				stdio: "ignore",
			});

			child.once("spawn", () => {
				child.unref();
				ctx.ui.notify(`已打开终端：${ctx.cwd}`, "info");
			});

			child.once("error", (error) => {
				ctx.ui.notify(`无法打开 Kitty：${error.message}`, "error");
			});
		},
	});
}
