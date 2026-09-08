// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { T3_PI_PERMISSION_EXTENSION_SOURCE } from "./PiPermissionExtension.ts";

interface ToolCallEvent {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
}

interface ExtensionContext {
  readonly hasUI: boolean;
  readonly signal?: AbortSignal;
  readonly ui: {
    readonly select: (
      title: string,
      options: ReadonlyArray<string>,
      settings?: { readonly signal?: AbortSignal },
    ) => Promise<string | undefined>;
  };
}

type ToolCallHandler = (
  event: ToolCallEvent,
  context: ExtensionContext,
) => Promise<{ readonly block: true; readonly reason: string } | undefined>;

interface ExtensionApi {
  readonly on: (event: "tool_call", handler: ToolCallHandler) => void;
}

const extensionPath = NodePath.join(NodeOS.tmpdir(), "t3-pi-permission-extension-test.mjs");

async function loadHandler(
  runtimeMode:
    | "approval-required"
    | "auto-accept-edits"
    | "auto"
    | "full-access" = "approval-required",
): Promise<ToolCallHandler> {
  const fileSystem = await import("node:fs/promises");
  process.env.T3_PI_RUNTIME_MODE = runtimeMode;
  await fileSystem.writeFile(extensionPath, T3_PI_PERMISSION_EXTENSION_SOURCE, "utf8");
  let handler: ToolCallHandler | undefined;
  const module = (await import(extensionPath)) as {
    default: (api: ExtensionApi) => void;
  };
  module.default({
    on: (_event, registered) => {
      handler = registered;
    },
  });
  if (!handler) throw new Error("T3 Pi permission extension did not register tool_call");
  return handler;
}

describe("T3 Pi permission extension", () => {
  it.each(["read", "grep", "find", "ls"])(
    "allows the %s tool without requesting approval in supervised mode",
    async (toolName) => {
      const handler = await loadHandler();
      let requested = false;
      const result = await handler(
        { toolName, input: { path: "README.md" } },
        {
          hasUI: true,
          ui: {
            select: async () => {
              requested = true;
              return "Allow once";
            },
          },
        },
      );

      expect(result).toBeUndefined();
      expect(requested).toBe(false);
    },
  );

  it.each(["edit", "write"])(
    "allows the %s tool without prompting in auto-accept-edits mode",
    async (toolName) => {
      const handler = await loadHandler("auto-accept-edits");
      let requested = false;
      expect(
        await handler(
          { toolName, input: { path: "out.txt" } },
          {
            hasUI: true,
            ui: {
              select: async () => {
                requested = true;
                return "Reject";
              },
            },
          },
        ),
      ).toBeUndefined();
      expect(requested).toBe(false);
    },
  );

  it.each(["read", "grep", "find", "ls", "edit", "write"])(
    "allows the documented %s tool in auto mode",
    async (toolName) => {
      const handler = await loadHandler("auto");
      let requested = false;
      expect(
        await handler(
          { toolName, input: { path: "README.md" } },
          {
            hasUI: true,
            ui: {
              select: async () => {
                requested = true;
                return "Reject";
              },
            },
          },
        ),
      ).toBeUndefined();
      expect(requested).toBe(false);
    },
  );

  it.each(["bash", "powershell", "custom-effect"])(
    "asks before the %s tool in auto and auto-accept-edits modes",
    async (toolName) => {
      for (const runtimeMode of ["auto", "auto-accept-edits"] as const) {
        const handler = await loadHandler(runtimeMode);
        let requested = false;
        expect(
          await handler(
            { toolName, input: { command: "git status --short" } },
            {
              hasUI: true,
              ui: {
                select: async () => {
                  requested = true;
                  return "Reject";
                },
              },
            },
          ),
        ).toEqual({ block: true, reason: "Blocked by T3 runtime permissions." });
        expect(requested).toBe(true);
      }
    },
  );

  it("allows all tools without prompting in full-access mode", async () => {
    const handler = await loadHandler("full-access");
    let requested = false;
    expect(
      await handler(
        { toolName: "unknown-custom-tool", input: {} },
        {
          hasUI: true,
          ui: {
            select: async () => {
              requested = true;
              return "Reject";
            },
          },
        },
      ),
    ).toBeUndefined();
    expect(requested).toBe(false);
  });

  it.each(["Allow once", "Allow for this session"])(
    "allows an effectful tool after selecting %s",
    async (selection) => {
      const handler = await loadHandler();
      const requests: Array<{
        readonly title: string;
        readonly options: ReadonlyArray<string>;
      }> = [];
      const result = await handler(
        { toolName: "bash", input: { command: "git status --short" } },
        {
          hasUI: true,
          ui: {
            select: async (title, options) => {
              requests.push({ title, options });
              return selection;
            },
          },
        },
      );

      expect(result).toBeUndefined();
      expect(requests).toEqual([
        {
          title: "Allow Pi to run bash?\ngit status --short",
          options: ["Allow once", "Allow for this session", "Reject"],
        },
      ]);
    },
  );

  it("remembers only the matching normalized operation after allow-for-session", async () => {
    const handler = await loadHandler();
    const requests: string[] = [];
    const context: ExtensionContext = {
      hasUI: true,
      ui: {
        select: async (title) => {
          requests.push(title);
          return "Allow for this session";
        },
      },
    };
    const matching = { toolName: "bash", input: { timeout: 30, command: "git status" } };

    expect(await handler(matching, context)).toBeUndefined();
    expect(
      await handler({ toolName: "bash", input: { command: "git status", timeout: 30 } }, context),
    ).toBeUndefined();
    expect(
      await handler({ toolName: "bash", input: { command: "git diff" } }, context),
    ).toBeUndefined();
    expect(requests).toHaveLength(2);
  });

  it("passes the active turn abort signal to the approval request", async () => {
    const handler = await loadHandler();
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    await handler(
      { toolName: "bash", input: { command: "git status" } },
      {
        hasUI: true,
        signal: controller.signal,
        ui: {
          select: async (_title, _options, settings) => {
            receivedSignal = settings?.signal;
            return "Reject";
          },
        },
      },
    );
    expect(receivedSignal).toBe(controller.signal);
  });

  it.each(["Reject", undefined])("blocks an effectful tool after %s", async (selection) => {
    const handler = await loadHandler();
    expect(
      await handler(
        { toolName: "write", input: { path: "out.txt" } },
        {
          hasUI: true,
          ui: { select: async () => selection },
        },
      ),
    ).toEqual({ block: true, reason: "Blocked by T3 runtime permissions." });
  });

  it("fails closed when Pi has no approval UI", async () => {
    const handler = await loadHandler();
    expect(
      await handler(
        { toolName: "custom-effect", input: {} },
        {
          hasUI: false,
          ui: { select: async () => "Allow once" },
        },
      ),
    ).toEqual({ block: true, reason: "T3 approval is unavailable for this Pi tool call." });
  });
});
