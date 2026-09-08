// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  PiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import type { PiAdapterShape } from "../Services/PiAdapter.ts";
import { makePiAdapter } from "./PiAdapter.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const piCancellationMockPath = NodePath.join(
  __dirname,
  "../testFixtures/piRpcCancellationMock.mjs",
);
const PI_PROVIDER = ProviderDriverKind.make("piAgent");
const PI_INSTANCE = ProviderInstanceId.make("piAgent");

function makePiWrapper(dir: string, env: Record<string, string> = {}): string {
  const wrapperPath = NodePath.join(dir, "pi-acp");
  NodeFS.writeFileSync(
    wrapperPath,
    [
      "#!/bin/sh",
      ...Object.entries(env).map(([key, value]) => `export ${key}=${JSON.stringify(value)}`),
      `exec node ${JSON.stringify(mockAgentPath)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  NodeFS.chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}

function processExists(pid: number): boolean {
  if (NodePath.sep !== "\\") {
    try {
      const state = NodeFS.readFileSync(`/proc/${String(pid)}/stat`, "utf8").match(
        /^\d+ \(.*\) ([A-Z]) /,
      )?.[1];
      return state !== undefined && state !== "Z";
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-pi-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(testLayer)("PiAdapter", (it) => {
  const makeTestAdapter = Effect.fn("PiAdapterTest.makeTestAdapter")(function* (
    environment: Record<string, string> | ((tempDir: string) => Record<string, string>) = {},
  ) {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-adapter-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
    );
    const piBinaryPath = NodePath.join(tempDir, "pi");
    NodeFS.writeFileSync(piBinaryPath, "#!/bin/sh\nexit 0\n", "utf8");
    NodeFS.chmodSync(piBinaryPath, 0o755);
    const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
    const adapter = yield* makePiAdapter(
      decodePiSettings({
        enabled: true,
        binaryPath: makePiWrapper(tempDir, {
          T3_ACP_PI_DISCOVERY: "1",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          ...(typeof environment === "function" ? environment(tempDir) : environment),
        }),
        piBinaryPath,
      }),
    );
    return { adapter, piBinaryPath, requestLogPath, tempDir };
  });

  const makePinnedBridgeAdapter = Effect.fn("PiAdapterTest.makePinnedBridgeAdapter")(
    function* (input?: { readonly cancelTimeout?: Duration.Input; readonly hangAbort?: boolean }) {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-cancel-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
      );
      const piBinaryPath = NodePath.join(tempDir, "pi");
      NodeFS.writeFileSync(
        piBinaryPath,
        // @effect-diagnostics-next-line preferSchemaOverJson:off - shell script quoting for fixed local paths.
        `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(piCancellationMockPath)} "$@"\n`,
        "utf8",
      );
      NodeFS.chmodSync(piBinaryPath, 0o755);
      const markerPath = NodePath.join(tempDir, "cancelled-marker.txt");
      const descendantPidPath = NodePath.join(tempDir, "descendant.pid");
      const adapter = yield* makePiAdapter(
        decodePiSettings({
          enabled: true,
          piBinaryPath,
        }),
        {
          environment: {
            T3_PI_RPC_CANCEL_MARKER_PATH: markerPath,
            T3_PI_RPC_CANCEL_PID_PATH: descendantPidPath,
            ...(input?.hangAbort ? { T3_PI_RPC_HANG_ABORT: "1" } : {}),
            PI_ACP_QUIET_STARTUP: "true",
          },
          ...(input?.cancelTimeout ? { cancelTimeout: input.cancelTimeout } : {}),
        },
      );
      return { adapter, descendantPidPath, markerPath, tempDir };
    },
  );

  const startSession = (
    adapter: PiAdapterShape,
    threadId: ThreadId,
    input?: {
      readonly cwd?: string;
      readonly resumeCursor?: unknown;
      readonly runtimeMode?: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
      readonly model?: string;
    },
  ) =>
    adapter.startSession({
      threadId,
      provider: PI_PROVIDER,
      cwd: input?.cwd ?? process.cwd(),
      runtimeMode: input?.runtimeMode ?? "approval-required",
      modelSelection: {
        instanceId: PI_INSTANCE,
        model: input?.model ?? "openai/gpt-5.4",
        options: [{ id: "thinkingLevel", value: "xhigh" }],
      },
      ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
    });

  const collectEvents = Effect.fn("PiAdapterTest.collectEvents")(function* (
    adapter: PiAdapterShape,
  ) {
    const events: ProviderRuntimeEvent[] = [];
    const fiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    ).pipe(Effect.forkChild);
    return { events, fiber };
  });

  it.effect("orders Pi reasoning and tool activity before one terminal outcome", () =>
    Effect.gen(function* () {
      const { adapter } = yield* makeTestAdapter({
        T3_ACP_EMIT_PI_THOUGHT: "1",
        T3_ACP_EMIT_PI_TOOL_EVENTS: "1",
        T3_ACP_EMIT_PI_RETRY: "1",
        T3_ACP_EMIT_PI_CONFIG_UPDATE: "1",
        T3_ACP_EMIT_LATE_PI_UPDATE: "1",
      });
      const threadId = ThreadId.make("pi-adapter-event-order");
      const { events, fiber } = yield* collectEvents(adapter);

      yield* startSession(adapter, threadId);
      const turn = yield* adapter.sendTurn({ threadId, input: "map events", attachments: [] });

      const turnEvents = events.filter((event) => event.turnId === turn.turnId);
      const terminalEvents = turnEvents.filter((event) => event.type === "turn.completed");
      expect(terminalEvents).toHaveLength(1);
      const terminalIndex = turnEvents.findIndex((event) => event.type === "turn.completed");
      expect(terminalIndex).toBeGreaterThan(0);
      expect(turnEvents.slice(terminalIndex + 1)).toEqual([]);
      const commandEvents = turnEvents.filter((event) => event.itemId === "pi-command-1");
      expect(commandEvents.map((event) => event.type)).toEqual([
        "item.started",
        "item.updated",
        "content.delta",
        "item.completed",
      ]);
      expect(turnEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "item.started",
            itemId: expect.stringMatching(/^reasoning:/),
            payload: expect.objectContaining({ itemType: "reasoning" }),
          }),
          expect.objectContaining({
            type: "content.delta",
            payload: expect.objectContaining({ streamKind: "reasoning_text" }),
          }),
          expect.objectContaining({
            type: "item.started",
            itemId: "pi-command-1",
            payload: expect.objectContaining({ itemType: "command_execution" }),
          }),
          expect.objectContaining({
            type: "item.updated",
            itemId: "pi-command-1",
            payload: expect.objectContaining({ status: "inProgress" }),
          }),
          expect.objectContaining({
            type: "content.delta",
            itemId: "pi-command-1",
            payload: { streamKind: "command_output", delta: "hello" },
          }),
          expect.objectContaining({
            type: "content.delta",
            payload: { streamKind: "assistant_text", delta: "late Pi update" },
          }),
          expect.objectContaining({
            type: "item.completed",
            itemId: "pi-command-1",
            payload: expect.objectContaining({ status: "completed" }),
          }),
          expect.objectContaining({
            type: "turn.diff.updated",
            itemId: "pi-edit-1",
            payload: expect.objectContaining({
              unifiedDiff: expect.stringContaining("+++ b/src/example.ts"),
            }),
          }),
          expect.objectContaining({
            type: "session.configured",
            payload: expect.objectContaining({
              config: expect.objectContaining({ options: expect.any(Array) }),
            }),
          }),
          expect.objectContaining({
            type: "runtime.warning",
            payload: { message: "Retrying (attempt 2/3, waiting 1s)..." },
          }),
        ]),
      );
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped),
  );

  it.effect("terminates a running Pi tool process and isolates the resumed turn", () =>
    Effect.gen(function* () {
      const { adapter, descendantPidPath, markerPath, tempDir } = yield* makePinnedBridgeAdapter();
      const threadId = ThreadId.make("pi-adapter-running-tool-cancellation");
      const { events, fiber } = yield* collectEvents(adapter);

      yield* startSession(adapter, threadId, { cwd: tempDir, model: "mock/model" });
      const cancelledPrompt = yield* adapter
        .sendTurn({ threadId, input: "run delayed marker", attachments: [] })
        .pipe(Effect.forkChild);
      while (!NodeFS.existsSync(descendantPidPath)) yield* Effect.yieldNow;
      const descendantPids = NodeFS.readFileSync(descendantPidPath, "utf8")
        .trim()
        .split("\n")
        .map(Number);

      const firstInterrupt = yield* adapter.interruptTurn(threadId).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const secondInterrupt = yield* adapter.interruptTurn(threadId).pipe(Effect.forkChild);
      const resumedPrompt = yield* adapter
        .sendTurn({ threadId, input: "resume after cancellation", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Effect.all([Fiber.join(firstInterrupt), Fiber.join(secondInterrupt)]);
      expect(yield* Fiber.join(cancelledPrompt)).toMatchObject({ threadId });
      for (const descendantPid of descendantPids) expect(processExists(descendantPid)).toBe(false);

      const resumed = yield* Fiber.join(resumedPrompt);
      yield* Effect.yieldNow;
      expect(resumed.threadId).toBe(threadId);

      expect(NodeFS.existsSync(markerPath)).toBe(false);
      const completed = events.filter((event) => event.type === "turn.completed");
      expect(completed).toHaveLength(2);
      expect(completed[0]).toMatchObject({ payload: { state: "cancelled" } });
      expect(completed[1]).toMatchObject({ payload: { state: "completed" } });
      const content = events.flatMap((event) =>
        event.type === "content.delta" ? [event.payload.delta] : [],
      );
      expect(content).toContain("RESUME_OK");
      expect(content.join("\n")).not.toContain("CANCELLED_LATE");
      const cancelledToolEvents = events.filter(
        (event) =>
          (event.type === "item.updated" || event.type === "item.completed") &&
          event.itemId === "cancelled-bash",
      );
      expect(cancelledToolEvents).toHaveLength(1);
      expect(cancelledToolEvents[0]).toMatchObject({
        type: "item.completed",
        payload: { status: "failed" },
      });
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped),
  );

  it.effect("times out Pi cancellation, kills the bridge, and removes the session", () =>
    Effect.gen(function* () {
      const { adapter, descendantPidPath, markerPath, tempDir } = yield* makePinnedBridgeAdapter({
        cancelTimeout: "100 millis",
        hangAbort: true,
      });
      const threadId = ThreadId.make("pi-adapter-cancellation-timeout");
      const { events, fiber } = yield* collectEvents(adapter);

      yield* startSession(adapter, threadId, { cwd: tempDir, model: "mock/model" });
      yield* adapter
        .sendTurn({ threadId, input: "run delayed marker", attachments: [] })
        .pipe(Effect.forkChild);
      while (!NodeFS.existsSync(descendantPidPath)) yield* Effect.yieldNow;

      const interrupt = yield* adapter.interruptTurn(threadId).pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("100 millis");
      const error = yield* Fiber.join(interrupt);
      expect(error._tag).toMatch(/ProviderAdapter/);
      expect(NodeFS.existsSync(markerPath)).toBe(false);
      expect(yield* adapter.hasSession(threadId)).toBe(false);
      expect(events.find((event) => event.type === "runtime.error")).toMatchObject({
        payload: { class: "transport_error" },
      });
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped),
  );

  it.effect("passes image attachments to Pi ACP prompts", () =>
    Effect.gen(function* () {
      const { adapter, requestLogPath } = yield* makeTestAdapter();
      const threadId = ThreadId.make("pi-adapter-image");
      const { attachmentsDir } = yield* ServerConfig;
      const attachment = {
        type: "image" as const,
        id: "pi-adapter-image-12345678-1234-1234-1234-123456789abc",
        name: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 4,
      };
      const attachmentPath = NodePath.join(attachmentsDir, `${attachment.id}.png`);
      NodeFS.mkdirSync(NodePath.dirname(attachmentPath), { recursive: true });
      NodeFS.writeFileSync(attachmentPath, Uint8Array.from([1, 2, 3, 4]));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(attachmentPath, { force: true })),
      );

      yield* startSession(adapter, threadId);
      yield* adapter.sendTurn({ threadId, attachments: [attachment] });

      const requests = NodeFS.readFileSync(requestLogPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { method?: string; params?: { prompt?: unknown } });
      expect(
        requests.find((request) => request.method === "session/prompt")?.params?.prompt,
      ).toEqual([{ type: "image", data: "AQIDBA==", mimeType: "image/png" }]);
    }).pipe(Effect.scoped),
  );

  it.effect("starts a Pi session and maps model, reasoning, and text events", () =>
    Effect.gen(function* () {
      const { adapter, requestLogPath } = yield* makeTestAdapter({
        T3_ACP_EMIT_PI_THOUGHT: "1",
      });
      const threadId = ThreadId.make("pi-adapter-thread");
      const { events, fiber } = yield* collectEvents(adapter);

      const session = yield* startSession(adapter, threadId);
      expect(session.provider).toBe("piAgent");
      expect(session.resumeCursor).toEqual({ schemaVersion: 1, sessionId: "mock-session-1" });

      yield* adapter.sendTurn({ threadId, input: "hello Pi", attachments: [] });
      expect(
        events.find(
          (event) =>
            event.type === "content.delta" && event.payload.streamKind === "reasoning_text",
        ),
      ).toMatchObject({ payload: { delta: "checking the Pi implementation" } });
      expect(
        events.find(
          (event) =>
            event.type === "content.delta" && event.payload.streamKind === "assistant_text",
        ),
      ).toMatchObject({ payload: { delta: "hello from mock" } });

      const requests = NodeFS.readFileSync(requestLogPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
      expect(
        requests.some(
          (request) =>
            request.method === "session/set_config_option" &&
            request.params?.configId === "model" &&
            request.params?.value === "openai/gpt-5.4",
        ),
      ).toBe(true);
      expect(
        requests.some(
          (request) =>
            request.method === "session/set_config_option" &&
            request.params?.configId === "thought_level" &&
            request.params?.value === "xhigh",
        ),
      ).toBe(true);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped),
  );

  it.effect("preserves cwd and Pi command while exposing presence and lifecycle events", () =>
    Effect.gen(function* () {
      const { adapter, piBinaryPath, requestLogPath, tempDir } = yield* makeTestAdapter();
      const threadId = ThreadId.make("pi-adapter-lifecycle");
      const { events, fiber } = yield* collectEvents(adapter);

      expect(yield* adapter.hasSession(threadId)).toBe(false);
      const session = yield* startSession(adapter, threadId, { cwd: tempDir });
      expect(session.cwd).toBe(tempDir);
      expect(yield* adapter.hasSession(threadId)).toBe(true);
      expect(yield* adapter.listSessions()).toEqual([session]);

      yield* adapter.sendTurn({ threadId, input: "verify cwd", attachments: [] });
      const requests = NodeFS.readFileSync(requestLogPath, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              method?: string;
              params?: { cwd?: string; prompt?: unknown };
              cwd?: string;
              piCommand?: string;
            },
        );
      expect(requests.find((request) => request.method === "session/new")).toMatchObject({
        cwd: tempDir,
        piCommand: piBinaryPath,
        params: { cwd: tempDir },
      });
      expect(requests.find((request) => request.method === "session/prompt")).toMatchObject({
        cwd: tempDir,
        piCommand: piBinaryPath,
      });

      yield* adapter.stopSession(threadId);
      expect(yield* adapter.hasSession(threadId)).toBe(false);
      expect(yield* adapter.listSessions()).toEqual([]);
      expect(events.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "session.started",
          "session.state.changed",
          "thread.started",
          "turn.started",
          "turn.completed",
          "session.exited",
        ]),
      );
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped),
  );

  it.effect("loads the durable resume id without replaying historical updates", () =>
    Effect.gen(function* () {
      const { adapter, requestLogPath } = yield* makeTestAdapter({
        T3_ACP_EMIT_LOAD_REPLAY: "1",
      });
      const threadId = ThreadId.make("pi-adapter-resume");
      const { events, fiber } = yield* collectEvents(adapter);
      const resumeCursor = { schemaVersion: 1, sessionId: "durable-pi-session" };

      const session = yield* startSession(adapter, threadId, { resumeCursor });
      expect(session.resumeCursor).toEqual(resumeCursor);
      yield* adapter.sendTurn({ threadId, input: "continue", attachments: [] });

      const requests = NodeFS.readFileSync(requestLogPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
      expect(requests.find((request) => request.method === "session/load")?.params).toMatchObject({
        sessionId: "durable-pi-session",
        cwd: process.cwd(),
      });
      expect(requests.some((request) => request.method === "session/new")).toBe(false);
      const content = events
        .filter((event) => event.type === "content.delta")
        .map((event) => (event.type === "content.delta" ? event.payload.delta : ""));
      expect(content).toContain("hello from mock");
      expect(content).not.toContain("replayed assistant text");
      expect(
        events.some(
          (event) =>
            (event.type === "item.updated" || event.type === "item.completed") &&
            event.itemId === "replay-tool-1",
        ),
      ).toBe(false);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped),
  );

  it.effect("returns accepted and declined Pi approvals to the requesting tool call", () =>
    Effect.gen(function* () {
      for (const decision of ["accept", "decline"] as const) {
        const { adapter } = yield* makeTestAdapter({
          T3_ACP_EMIT_TOOL_CALLS: "1",
          T3_ACP_EXTENSION_PERMISSION_REQUEST: "1",
        });
        const threadId = ThreadId.make(`pi-adapter-permission-${decision}`);
        const { events, fiber } = yield* collectEvents(adapter);
        yield* startSession(adapter, threadId);
        const promptFiber = yield* adapter
          .sendTurn({ threadId, input: "run command", attachments: [] })
          .pipe(Effect.forkChild);
        let opened: Extract<ProviderRuntimeEvent, { type: "request.opened" }> | undefined;
        while (!opened) {
          yield* Effect.yieldNow;
          opened = events.find(
            (event): event is Extract<ProviderRuntimeEvent, { type: "request.opened" }> =>
              event.type === "request.opened",
          );
        }

        yield* adapter.respondToRequest(
          threadId,
          ApprovalRequestId.make(String(opened.requestId)),
          decision,
        );
        const result = yield* Fiber.join(promptFiber);
        expect(result.threadId).toBe(threadId);
        expect(events.find((event) => event.type === "request.resolved")).toMatchObject({
          requestId: opened.requestId,
          payload: { decision },
        });
        expect(events.find((event) => event.type === "turn.completed")).toMatchObject({
          payload: { state: "completed" },
        });
        yield* Fiber.interrupt(fiber);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("maps the T3 Pi extension choices and remembers allow-for-session", () =>
    Effect.gen(function* () {
      const { adapter } = yield* makeTestAdapter({
        T3_ACP_EMIT_TOOL_CALLS: "1",
        T3_ACP_EXTENSION_PERMISSION_REQUEST: "1",
        T3_ACP_PERMISSION_REQUEST_COUNT: "2",
      });
      const threadId = ThreadId.make("pi-adapter-extension-permission");
      const { events, fiber } = yield* collectEvents(adapter);
      yield* startSession(adapter, threadId);

      const promptFiber = yield* adapter
        .sendTurn({ threadId, input: "run command", attachments: [] })
        .pipe(Effect.forkChild);
      let opened: Extract<ProviderRuntimeEvent, { type: "request.opened" }> | undefined;
      while (!opened) {
        yield* Effect.yieldNow;
        opened = events.find(
          (event): event is Extract<ProviderRuntimeEvent, { type: "request.opened" }> =>
            event.type === "request.opened",
        );
      }
      expect(opened.payload).toMatchObject({
        requestType: "dynamic_tool_call",
        detail: "Allow Pi to run bash?\ncat server/package.json",
      });
      expect(opened.raw?.payload).toMatchObject({
        options: [
          { optionId: "choice-0", kind: "allow_once" },
          { optionId: "choice-1", kind: "allow_always" },
          { optionId: "choice-2", kind: "reject_once" },
        ],
      });

      yield* adapter.respondToRequest(
        threadId,
        // The runtime request ID is the provider approval ID for adapter responses.
        ApprovalRequestId.make(String(opened.requestId)),
        "acceptForSession",
      );
      yield* Fiber.join(promptFiber);
      expect(events.filter((event) => event.type === "request.opened")).toHaveLength(1);
      expect(events.find((event) => event.type === "request.resolved")).toMatchObject({
        payload: { decision: "acceptForSession" },
      });
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped),
  );

  it.effect("auto-approves Pi writes but still asks for commands in auto-accept-edits mode", () =>
    Effect.gen(function* () {
      const { adapter } = yield* makeTestAdapter({
        T3_ACP_EMIT_TOOL_CALLS: "1",
        T3_ACP_EXTENSION_PERMISSION_REQUEST: "1",
        T3_ACP_PERMISSION_TOOL_NAME: "write",
        T3_ACP_PERMISSION_TITLE: "Allow Pi to run write?\nout.txt",
      });
      const threadId = ThreadId.make("pi-adapter-extension-auto-edits");
      const { events, fiber } = yield* collectEvents(adapter);
      yield* startSession(adapter, threadId, { runtimeMode: "auto-accept-edits" });
      yield* adapter.sendTurn({ threadId, input: "write file", attachments: [] });
      expect(events.some((event) => event.type === "request.opened")).toBe(false);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps Pi commands supervised in auto-accept-edits mode", () =>
    Effect.gen(function* () {
      const { adapter } = yield* makeTestAdapter({
        T3_ACP_EMIT_TOOL_CALLS: "1",
        T3_ACP_EXTENSION_PERMISSION_REQUEST: "1",
      });
      const threadId = ThreadId.make("pi-adapter-extension-auto-command");
      const { events, fiber } = yield* collectEvents(adapter);
      yield* startSession(adapter, threadId, { runtimeMode: "auto-accept-edits" });
      const promptFiber = yield* adapter
        .sendTurn({ threadId, input: "run command", attachments: [] })
        .pipe(Effect.forkChild);
      let opened: Extract<ProviderRuntimeEvent, { type: "request.opened" }> | undefined;
      while (!opened) {
        yield* Effect.yieldNow;
        opened = events.find(
          (event): event is Extract<ProviderRuntimeEvent, { type: "request.opened" }> =>
            event.type === "request.opened",
        );
      }
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(opened.requestId)),
        "accept",
      );
      yield* Fiber.join(promptFiber);
      expect(events.filter((event) => event.type === "request.opened")).toHaveLength(1);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped),
  );

  it.effect("asks before unknown Pi tools in auto mode", () =>
    Effect.gen(function* () {
      const { adapter } = yield* makeTestAdapter({
        T3_ACP_EMIT_TOOL_CALLS: "1",
        T3_ACP_EXTENSION_PERMISSION_REQUEST: "1",
        T3_ACP_PERMISSION_TOOL_NAME: "custom-effect",
      });
      const threadId = ThreadId.make("pi-adapter-auto-unknown");
      const { events, fiber } = yield* collectEvents(adapter);
      yield* startSession(adapter, threadId, { runtimeMode: "auto" });
      const promptFiber = yield* adapter
        .sendTurn({ threadId, input: "custom tool", attachments: [] })
        .pipe(Effect.forkChild);
      let opened: Extract<ProviderRuntimeEvent, { type: "request.opened" }> | undefined;
      while (!opened) {
        yield* Effect.yieldNow;
        opened = events.find(
          (event): event is Extract<ProviderRuntimeEvent, { type: "request.opened" }> =>
            event.type === "request.opened",
        );
      }
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(opened.requestId)),
        "decline",
      );
      yield* Fiber.join(promptFiber);
      expect(opened.payload.detail).toContain("custom-effect");
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped),
  );

  it.effect("auto-approves T3 Pi extension requests in full-access mode", () =>
    Effect.gen(function* () {
      const { adapter } = yield* makeTestAdapter({
        T3_ACP_EMIT_TOOL_CALLS: "1",
        T3_ACP_EXTENSION_PERMISSION_REQUEST: "1",
      });
      const threadId = ThreadId.make("pi-adapter-extension-full-access");
      const { events, fiber } = yield* collectEvents(adapter);
      yield* startSession(adapter, threadId, { runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "run command", attachments: [] });
      expect(events.some((event) => event.type === "request.opened")).toBe(false);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped),
  );

  it.effect("routes Pi user input to the matching request and returns the answer", () =>
    Effect.gen(function* () {
      const { adapter } = yield* makeTestAdapter({ T3_ACP_EMIT_PI_USER_INPUT: "1" });
      const threadId = ThreadId.make("pi-adapter-user-input");
      const { events, fiber } = yield* collectEvents(adapter);
      yield* startSession(adapter, threadId);

      const promptFiber = yield* adapter
        .sendTurn({ threadId, input: "ask me", attachments: [] })
        .pipe(Effect.forkChild);
      let requested: Extract<ProviderRuntimeEvent, { type: "user-input.requested" }> | undefined;
      while (!requested) {
        yield* Effect.yieldNow;
        requested = events.find(
          (event): event is Extract<ProviderRuntimeEvent, { type: "user-input.requested" }> =>
            event.type === "user-input.requested",
        );
      }
      expect(requested.payload.questions).toEqual([
        expect.objectContaining({
          id: "value",
          header: "Your response",
          question: "What should Pi do next?",
          options: [],
        }),
      ]);

      yield* adapter.respondToUserInput(
        threadId,
        ApprovalRequestId.make(String(requested.requestId)),
        { value: "continue with tests" },
      );
      yield* Fiber.join(promptFiber);
      expect(events.find((event) => event.type === "user-input.resolved")).toMatchObject({
        requestId: requested.requestId,
        payload: { answers: { value: "continue with tests" } },
      });
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "content.delta",
            payload: { streamKind: "assistant_text", delta: "Pi input: continue with tests" },
          }),
        ]),
      );
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped),
  );

  it.effect.each(["interrupt", "stop"] as const)(
    "%s settles pending Pi approval and input requests",
    (action) =>
      Effect.gen(function* () {
        const approvalSetup = yield* makeTestAdapter({
          T3_ACP_EMIT_TOOL_CALLS: "1",
          T3_ACP_EXTENSION_PERMISSION_REQUEST: "1",
        });
        const approvalThreadId = ThreadId.make(`pi-adapter-${action}-approval`);
        const approvalEvents = yield* collectEvents(approvalSetup.adapter);
        yield* startSession(approvalSetup.adapter, approvalThreadId);
        const approvalPrompt = yield* approvalSetup.adapter
          .sendTurn({ threadId: approvalThreadId, input: "run command", attachments: [] })
          .pipe(Effect.forkChild);
        while (!approvalEvents.events.some((event) => event.type === "request.opened")) {
          yield* Effect.yieldNow;
        }
        if (action === "interrupt") yield* approvalSetup.adapter.interruptTurn(approvalThreadId);
        else yield* approvalSetup.adapter.stopSession(approvalThreadId);
        yield* Fiber.join(approvalPrompt);
        expect(
          approvalEvents.events.find((event) => event.type === "request.resolved"),
        ).toMatchObject({ payload: { decision: "cancel" } });
        yield* Fiber.interrupt(approvalEvents.fiber);

        const inputSetup = yield* makeTestAdapter({ T3_ACP_EMIT_PI_USER_INPUT: "1" });
        const inputThreadId = ThreadId.make(`pi-adapter-${action}-input`);
        const inputEvents = yield* collectEvents(inputSetup.adapter);
        yield* startSession(inputSetup.adapter, inputThreadId);
        const inputPrompt = yield* inputSetup.adapter
          .sendTurn({ threadId: inputThreadId, input: "ask me", attachments: [] })
          .pipe(Effect.forkChild);
        while (!inputEvents.events.some((event) => event.type === "user-input.requested")) {
          yield* Effect.yieldNow;
        }
        if (action === "interrupt") yield* inputSetup.adapter.interruptTurn(inputThreadId);
        else yield* inputSetup.adapter.stopSession(inputThreadId);
        yield* Fiber.join(inputPrompt);
        expect(
          inputEvents.events.find((event) => event.type === "user-input.resolved"),
        ).toMatchObject({ payload: { answers: {} } });
        yield* Fiber.interrupt(inputEvents.fiber);
      }).pipe(Effect.scoped),
  );

  it.effect("settles and cancels an active turn before stopping the child process", () =>
    Effect.gen(function* () {
      const { adapter, tempDir } = yield* makeTestAdapter((dir) => ({
        T3_ACP_HANG_PROMPT_FOREVER: "1",
        T3_ACP_EXIT_LOG_PATH: NodePath.join(dir, "exit.log"),
      }));
      const exitLogPath = NodePath.join(tempDir, "exit.log");
      const threadId = ThreadId.make("pi-adapter-stop");
      const turnStarted = yield* Deferred.make<void>();
      const events: ProviderRuntimeEvent[] = [];
      const fiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "turn.started") yield* Deferred.succeed(turnStarted, undefined);
        }),
      ).pipe(Effect.forkChild);

      yield* startSession(adapter, threadId);
      const promptFiber = yield* adapter
        .sendTurn({ threadId, input: "wait", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(turnStarted);
      yield* adapter.stopSession(threadId);
      yield* Fiber.join(promptFiber);

      const completions = events.filter((event) => event.type === "turn.completed");
      expect(completions).toHaveLength(1);
      const completed = completions[0];
      expect(completed?.type).toBe("turn.completed");
      if (completed?.type === "turn.completed") expect(completed.payload.state).toBe("cancelled");
      expect(events.find((event) => event.type === "session.exited")).toMatchObject({
        payload: { exitKind: "graceful" },
      });
      expect(NodeFS.readFileSync(exitLogPath, "utf8")).toContain("SIGTERM");
      expect(yield* adapter.hasSession(threadId)).toBe(false);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped),
  );

  it.effect("removes the session and emits process failure lifecycle events", () =>
    Effect.gen(function* () {
      const { adapter, tempDir } = yield* makeTestAdapter((dir) => ({
        T3_ACP_EXIT_ON_PROMPT: "1",
        T3_ACP_EXIT_LOG_PATH: NodePath.join(dir, "exit.log"),
      }));
      const threadId = ThreadId.make("pi-adapter-process-failure");
      const { events, fiber } = yield* collectEvents(adapter);
      yield* startSession(adapter, threadId);

      const error = yield* adapter
        .sendTurn({ threadId, input: "exit", attachments: [] })
        .pipe(Effect.flip);
      expect(error._tag).toBe("ProviderAdapterSessionClosedError");
      expect(yield* adapter.hasSession(threadId)).toBe(false);
      expect(yield* adapter.listSessions()).toEqual([]);
      const completions = events.filter((event) => event.type === "turn.completed");
      expect(completions).toHaveLength(1);
      expect(completions[0]).toMatchObject({ payload: { state: "failed" } });
      expect(events.find((event) => event.type === "runtime.error")).toMatchObject({
        payload: { class: "transport_error" },
      });
      expect(events.find((event) => event.type === "session.exited")).toMatchObject({
        payload: { recoverable: false, exitKind: "error" },
      });
      expect(NodeFS.readFileSync(NodePath.join(tempDir, "exit.log"), "utf8")).toContain("exit:19");
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped),
  );

  it.effect("surfaces malformed ACP output as one failed turn", () =>
    Effect.gen(function* () {
      const { adapter } = yield* makeTestAdapter({
        T3_ACP_EMIT_MALFORMED_PROMPT_OUTPUT: "1",
      });
      const threadId = ThreadId.make("pi-adapter-malformed-output");
      const { events, fiber } = yield* collectEvents(adapter);
      yield* startSession(adapter, threadId);

      const error = yield* adapter
        .sendTurn({ threadId, input: "malformed", attachments: [] })
        .pipe(Effect.flip);
      expect(error._tag).toBe("ProviderAdapterRequestError");
      const completions = events.filter((event) => event.type === "turn.completed");
      expect(completions).toHaveLength(1);
      expect(completions[0]).toMatchObject({ payload: { state: "failed" } });
      const sessions = yield* adapter.listSessions();
      expect(sessions).toMatchObject([{ threadId, status: "ready" }]);
      expect(sessions[0]?.activeTurnId).toBeUndefined();
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped),
  );

  it.effect("restores the session and emits a failed turn when prompt fails", () =>
    Effect.gen(function* () {
      const { adapter } = yield* makeTestAdapter({ T3_ACP_FAIL_PROMPT: "1" });
      const threadId = ThreadId.make("pi-adapter-prompt-failure");
      const { events, fiber } = yield* collectEvents(adapter);
      yield* startSession(adapter, threadId);

      const error = yield* adapter
        .sendTurn({ threadId, input: "fail", attachments: [] })
        .pipe(Effect.flip);
      expect(error._tag).toBe("ProviderAdapterRequestError");
      const sessions = yield* adapter.listSessions();
      expect(sessions).toMatchObject([{ threadId, status: "ready" }]);
      expect(sessions[0]?.activeTurnId).toBeUndefined();
      const completions = events.filter((event) => event.type === "turn.completed");
      expect(completions).toHaveLength(1);
      const completed = completions[0];
      expect(completed?.type).toBe("turn.completed");
      if (completed?.type === "turn.completed") {
        expect(completed.payload.state).toBe("failed");
        expect(completed.payload.errorMessage).toContain("Mock prompt failure");
      }
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped),
  );
});
