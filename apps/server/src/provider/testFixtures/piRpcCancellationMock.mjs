#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

const isWindows = NodePath.sep === "\\";
const hangAbort = process.env.T3_PI_RPC_HANG_ABORT === "1";
const markerPath = process.env.T3_PI_RPC_CANCEL_MARKER_PATH;
const pidPath = process.env.T3_PI_RPC_CANCEL_PID_PATH;
let promptCount = 0;
let activeToolProcess;
let activeToolExited = Promise.resolve();

const processIsRunning = (pid) => {
  try {
    const state = NodeFS.readFileSync(`/proc/${String(pid)}/stat`, "utf8").match(
      /^\d+ \(.*\) ([A-Z]) /,
    )?.[1];
    return state !== undefined && state !== "Z";
  } catch {
    return false;
  }
};
const waitUntilStopped = async (pid) => {
  while (processIsRunning(pid)) await new Promise((resolve) => setTimeout(resolve, 5));
};

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const respond = (command, data) =>
  send({
    id: command.id,
    type: "response",
    command: command.type,
    success: true,
    ...(data === undefined ? {} : { data }),
  });

NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  switch (command.type) {
    case "get_state":
      respond(command, {
        sessionId: "pi-rpc-cancellation-session",
        sessionFile: null,
        model: { provider: "mock", id: "model" },
        thinkingLevel: "low",
        autoCompactionEnabled: true,
      });
      return;
    case "get_available_models":
      respond(command, { models: [{ provider: "mock", id: "model", name: "Model" }] });
      return;
    case "get_commands":
      respond(command, { commands: [] });
      return;
    case "set_model":
    case "set_thinking_level":
      respond(command);
      return;
    case "prompt": {
      promptCount += 1;
      respond(command);
      send({ type: "agent_start" });
      if (promptCount === 1) {
        if (!markerPath || !pidPath) throw new Error("Missing cancellation fixture paths");
        const childScript = `const fs = require("node:fs"); setTimeout(() => fs.writeFileSync(process.argv[1], "SHOULD_NOT_EXIST"), 600);`;
        const parentScript = `const cp = require("node:child_process"); const fs = require("node:fs"); const child = cp.spawn(process.execPath, ["-e", process.argv[3], process.argv[1]], { stdio: "ignore" }); fs.writeFileSync(process.argv[2], process.pid + "\\n" + child.pid, "utf8"); setInterval(() => {}, 1000);`;
        activeToolProcess = NodeChildProcess.spawn(
          process.execPath,
          ["-e", parentScript, markerPath, pidPath, childScript],
          { detached: !isWindows, stdio: "ignore" },
        );
        activeToolExited = new Promise((resolve) => activeToolProcess.once("exit", resolve));
        send({
          type: "tool_execution_start",
          toolCallId: "cancelled-bash",
          toolName: "bash",
          args: { command: "delayed marker" },
        });
        return;
      }
      send({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "RESUME_OK" },
      });
      send({ type: "agent_end" });
      send({ type: "agent_settled" });
      return;
    }
    case "abort":
      if (hangAbort) return;
      setTimeout(async () => {
        if (activeToolProcess?.pid) {
          if (isWindows) {
            NodeChildProcess.spawnSync(
              NodePath.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
              ["/F", "/T", "/PID", String(activeToolProcess.pid)],
              { stdio: "ignore", windowsHide: true },
            );
          } else {
            try {
              process.kill(-activeToolProcess.pid, "SIGKILL");
            } catch {
              try {
                process.kill(activeToolProcess.pid, "SIGKILL");
              } catch {}
            }
          }
          await activeToolExited;
          const toolPids = NodeFS.readFileSync(pidPath, "utf8").trim().split("\n").map(Number);
          for (const pid of toolPids) await waitUntilStopped(pid);
        }
        send({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "CANCELLED_LATE_OUTPUT" },
        });
        send({
          type: "tool_execution_end",
          toolCallId: "cancelled-bash",
          toolName: "bash",
          result: {
            content: [{ type: "text", text: "CANCELLED_LATE_TOOL_OUTPUT" }],
            details: {},
          },
          isError: false,
        });
        send({ type: "agent_end" });
        send({ type: "agent_settled" });
        respond(command);
      }, 100);
      return;
    default:
      respond(command);
  }
});
