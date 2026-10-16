import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, mock, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register from "../index.ts";

afterEach(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
});

function setup(mode = "tui", hasUI = true) {
  let handler: ((args: string, ctx: unknown) => unknown) | undefined;
  const notifications: [string, string][] = [];
  register({
    registerCommand(name: string, command: { handler: typeof handler }) {
      assert.equal(name, "d");
      handler = command.handler;
    },
  } as unknown as ExtensionAPI);
  assert.ok(handler);
  const ctx = {
    mode,
    hasUI,
    cwd: "/tmp/a directory",
    ui: { notify: (message: string, level: string) => notifications.push([message, level]) },
  };
  return { run: () => handler!("", ctx), notifications };
}

function stubSpawn() {
  const child = Object.assign(new EventEmitter(), { unref: mock.fn() });
  const spawn = mock.method(childProcess, "spawn", () => child);
  syncBuiltinESMExports();
  return { child, spawn };
}

test("opens Kitty in the session directory and detaches only after spawn", async () => {
  const { child, spawn } = stubSpawn();
  const { run, notifications } = setup();
  await run();
  assert.deepEqual(spawn.mock.calls[0].arguments, [
    "kitty", ["--directory", "/tmp/a directory"],
    { cwd: "/tmp/a directory", detached: true, stdio: "ignore" },
  ]);
  assert.equal(child.unref.mock.callCount(), 0);
  assert.deepEqual(notifications, []);
  child.emit("spawn");
  assert.equal(child.unref.mock.callCount(), 1);
  assert.deepEqual(notifications, [["已打开终端：/tmp/a directory", "info"]]);
});

test("reports a missing terminal without throwing", async () => {
  const { child } = stubSpawn();
  const { run, notifications } = setup();
  await run();
  child.emit("error", new Error("ENOENT"));
  assert.deepEqual(notifications, [["无法打开 Kitty：ENOENT", "error"]]);
  assert.equal(child.unref.mock.callCount(), 0);
});

test("does not spawn outside TUI and warns only if a UI is available", async () => {
  const { spawn } = stubSpawn();
  const visible = setup("rpc");
  await visible.run();
  assert.deepEqual(visible.notifications, [["/d 只能在 TUI 模式中使用", "warning"]]);
  const headless = setup("rpc", false);
  await headless.run();
  assert.deepEqual(headless.notifications, []);
  assert.equal(spawn.mock.callCount(), 0);
});
