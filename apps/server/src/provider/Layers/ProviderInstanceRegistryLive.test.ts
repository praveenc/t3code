// @effect-diagnostics nodeBuiltinImport:off
/**
 * Multi-instance validation slices for `ProviderInstanceRegistryLive`.
 *
 * Two axes of the driver/registry refactor are exercised here:
 *
 *  1. **Same driver, many instances** — the "multi-instance codex slice"
 *     describe block below configures two independent `codex` instances and
 *     asserts each gets its own closures and identity. This is the
 *     multi-codex capability the refactor exists to unlock.
 *
 *  2. **Many drivers, one registry** — the "all drivers slice" describe
 *     block below configures one instance of every shipped driver
 *     (`codex`, `claudeAgent`, `cursor`, `grok`, `opencode`) in a single
 *     `ProviderInstanceConfigMap` and asserts the registry boots them all
 *     without cross-contamination. This proves the driver SPI is uniform
 *     across every provider — any driver plugs into the registry through
 *     the same `ProviderDriver` value contract.
 *
 * Every existing-provider instance in these tests is configured with `enabled: false` so
 * status checks short-circuit without spawning its real binary. The Pi compatibility
 * test is the exception: it uses the controlled ACP peer and temporary executable
 * shims to exercise the registered driver without relying on external installations.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ClaudeSettings,
  type CodexSettings,
  type CursorSettings,
  type GrokSettings,
  type OpenCodeSettings,
  type PiSettings,
  type ProviderRuntimeEvent,
  ProviderDriverKind,
  type ProviderInstanceConfigMap,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { isHostWindows } from "@t3tools/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import type { BuiltInDriversEnv } from "../builtInDrivers.ts";
import { AntigravityInstallation } from "../AntigravityInstallation.ts";
import { ServerConfig } from "../../config.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ClaudeDriver } from "../Drivers/ClaudeDriver.ts";
import { CodexDriver } from "../Drivers/CodexDriver.ts";
import { CursorDriver } from "../Drivers/CursorDriver.ts";
import { GrokDriver } from "../Drivers/GrokDriver.ts";
import { OpenCodeDriver } from "../Drivers/OpenCodeDriver.ts";
import { PiDriver } from "../Drivers/PiDriver.ts";
import * as ModelManifest from "../ModelManifest.ts";
import { OpenCodeRuntimeLive } from "../opencodeRuntime.ts";
import * as CodexResetCredit from "./codexResetCredit.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "./ProviderEventLoggers.ts";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistryLive.ts";
import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";

const TestHttpClientLive = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
);

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

function makePiWrapper(dir: string, environment: Record<string, string>): string {
  const wrapperPath = NodePath.join(dir, "pi-acp");
  NodeFS.writeFileSync(
    wrapperPath,
    [
      "#!/bin/sh",
      ...Object.entries(environment).map(
        ([key, value]) => `export ${key}=${JSON.stringify(value)}`,
      ),
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  NodeFS.chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}

const BackgroundPolicyAlwaysRunLayer = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
  reportClientActivity: () => Effect.void,
  removeRpcClient: () => Effect.void,
  reportHostPowerState: () => Effect.void,
  snapshot: Effect.succeed({
    hostPower: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: true,
      updatedAt: TEST_EPOCH,
    },
    leases: [],
    activeForegroundLeaseCount: 0,
    activeScopeKeys: [],
    shouldRunOpportunisticWork: true,
    updatedAt: TEST_EPOCH,
  }),
  streamChanges: Stream.empty,
  hasDemand: () => Effect.succeed(true),
  shouldRunScopeWork: () => Effect.succeed(true),
  shouldRunOpportunisticWork: Effect.succeed(true),
});

const makeCodexConfig = (overrides: Partial<CodexSettings>): CodexSettings => ({
  enabled: false,
  binaryPath: "codex",
  homePath: "",
  shadowHomePath: "",
  launchArgs: "",
  customModels: [],
  ...overrides,
});

const makeClaudeConfig = (overrides: Partial<ClaudeSettings>): ClaudeSettings => ({
  enabled: false,
  binaryPath: "claude",
  homePath: "",
  customModels: [],
  launchArgs: "",
  autoCompactWindow: "",
  ...overrides,
});

const makeCursorConfig = (overrides: Partial<CursorSettings>): CursorSettings => ({
  enabled: false,
  binaryPath: "cursor-agent",
  apiEndpoint: "",
  customModels: [],
  ...overrides,
});

const makeGrokConfig = (overrides: Partial<GrokSettings>): GrokSettings => ({
  enabled: false,
  binaryPath: "grok",
  customModels: [],
  ...overrides,
});

const makeOpenCodeConfig = (overrides: Partial<OpenCodeSettings>): OpenCodeSettings => ({
  enabled: false,
  binaryPath: "opencode",
  serverUrl: "",
  serverPassword: "",
  customModels: [],
  ...overrides,
});

const makeTildeProviderFixtures = Effect.fn(
  "ProviderInstanceRegistryLive.test.makeTildeProviderFixtures",
)(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homePath = expandHomePath("~");
  const fixtureDir = yield* fileSystem.makeTempDirectoryScoped({
    directory: homePath,
    prefix: ".t3-provider-path-test-",
  });
  const codexPath = path.join(fixtureDir, "codex");
  const claudePath = path.join(fixtureDir, "claude");
  const claudeHomePath = path.join(fixtureDir, "claude-home");
  const codexScriptPath = path.join(fixtureDir, "codex-script.json");
  const codexFixtureDir = path.join(import.meta.dirname, "../testFixtures");

  yield* fileSystem.copyFile(path.join(codexFixtureDir, "codexCollabMockPeer.sh"), codexPath);
  yield* fileSystem.copyFile(
    path.join(codexFixtureDir, "codexCollabMockPeer.mjs"),
    path.join(fixtureDir, "codexCollabMockPeer.mjs"),
  );
  yield* fileSystem.copyFile(
    path.join(codexFixtureDir, "codexMultiAgentWire.json"),
    path.join(fixtureDir, "codexMultiAgentWire.json"),
  );
  yield* fileSystem.writeFileString(
    codexScriptPath,
    // @effect-diagnostics-next-line preferSchemaOverJson:off - fixed script document read by the external Codex mock peer.
    JSON.stringify({ rootThreadId: "probe-thread", notifications: [] }),
  );
  yield* fileSystem.chmod(codexPath, 0o755);

  yield* fileSystem.writeFileString(
    claudePath,
    [
      "#!/usr/bin/env node",
      'import * as NodeReadline from "node:readline";',
      'if (process.argv.includes("--version")) {',
      '  process.stdout.write("claude 2.1.219\\n");',
      "  process.exit(0);",
      "}",
      "const lines = NodeReadline.createInterface({ input: process.stdin });",
      'lines.on("line", (line) => {',
      "  const message = JSON.parse(line);",
      '  if (message.type !== "control_request" || message.request?.subtype !== "initialize") return;',
      "  process.stdout.write(JSON.stringify({",
      '    type: "control_response",',
      "    response: {",
      '      subtype: "success",',
      "      request_id: message.request_id,",
      "      response: {",
      "        commands: [], agents: [], models: [],",
      '        output_style: "default", available_output_styles: ["default"],',
      '        account: { email: "test@example.com", subscriptionType: "pro", tokenSource: "oauth" },',
      "      },",
      "    },",
      '  }) + "\\n");',
      "});",
      "setInterval(() => {}, 1_000);",
      "",
    ].join("\n"),
  );
  yield* fileSystem.chmod(claudePath, 0o755);
  yield* fileSystem.makeDirectory(claudeHomePath);

  const asTildePath = (filePath: string) => `~/${path.relative(homePath, filePath)}`;
  return {
    codexBinaryPath: asTildePath(codexPath),
    claudeBinaryPath: asTildePath(claudePath),
    claudeHomePath,
    codexScriptPath,
  };
});

const makePiConfig = (overrides: Partial<PiSettings>): PiSettings => ({
  enabled: false,
  binaryPath: "pi-acp",
  piBinaryPath: "pi",
  customModels: [],
  ...overrides,
});

describe("ProviderInstanceRegistryLive — multi-instance codex slice", () => {
  // `ServerConfig.layerTest` needs `FileSystem` to materialize its scratch
  // directory. `Layer.merge` just unions requirements, so we have to push
  // `NodeServices.layer` through `Layer.provideMerge` to satisfy that
  // dependency while still surfacing NodeServices to the test body (the
  // codex driver's `create` yields `ChildProcessSpawner` directly).
  const testLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "provider-instance-registry-test",
  }).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(TestHttpClientLive),
    Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
    Layer.provideMerge(ModelManifest.layerTest),
    Layer.provideMerge(CodexResetCredit.layerTest),
  );

  it.live("boots two independent codex instances from a ProviderInstanceConfigMap", () =>
    Effect.gen(function* () {
      const personalId = ProviderInstanceId.make("codex_personal");
      const workId = ProviderInstanceId.make("codex_work");
      const codexDriverKind = ProviderDriverKind.make("codex");

      const configMap: ProviderInstanceConfigMap = {
        [personalId]: {
          driver: codexDriverKind,
          displayName: "Codex (personal)",
          enabled: false,
          config: makeCodexConfig({
            binaryPath: "/opt/codex-personal/bin/codex",
            homePath: "/home/julius/.codex_personal",
            customModels: ["personal-preview"],
          }),
        },
        [workId]: {
          driver: codexDriverKind,
          displayName: "Codex (work)",
          enabled: false,
          config: makeCodexConfig({
            binaryPath: "/opt/codex-work/bin/codex",
            homePath: "/home/julius/.codex",
            customModels: ["work-preview"],
          }),
        },
      };

      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [CodexDriver],
        configMap,
      });

      const instances = yield* registry.listInstances;
      expect(instances.map((instance) => instance.instanceId).toSorted()).toEqual(
        [personalId, workId].toSorted(),
      );
      expect(instances.every((instance) => instance.driverKind === codexDriverKind)).toBe(true);
      expect(instances.map((instance) => instance.displayName).toSorted()).toEqual(
        ["Codex (personal)", "Codex (work)"].toSorted(),
      );

      // Each instance must be retrievable by id and carry its *own* closures.
      const personal = yield* registry.getInstance(personalId);
      const work = yield* registry.getInstance(workId);
      expect(personal).toBeDefined();
      expect(work).toBeDefined();
      expect(personal!.adapter).not.toBe(work!.adapter);
      expect(personal!.textGeneration).not.toBe(work!.textGeneration);
      expect(personal!.snapshot).not.toBe(work!.snapshot);

      // Snapshots identify themselves by instanceId + driver — this is
      // what makes per-instance routing distinguishable downstream.
      const personalSnapshot = yield* personal!.snapshot.getSnapshot;
      expect(personalSnapshot.instanceId).toBe(personalId);
      expect(personalSnapshot.driver).toBe(codexDriverKind);
      expect(personalSnapshot.enabled).toBe(false);
      // The layout resolves the configured home through the host Path.
      const path = yield* Path.Path;
      expect(personalSnapshot.continuation?.groupKey).toBe(
        `codex:home:${path.resolve("/home/julius/.codex_personal")}`,
      );

      const workSnapshot = yield* work!.snapshot.getSnapshot;
      expect(workSnapshot.instanceId).toBe(workId);
      expect(workSnapshot.driver).toBe(codexDriverKind);
      expect(workSnapshot.enabled).toBe(false);
      expect(workSnapshot.continuation?.groupKey).toBe(
        `codex:home:${path.resolve("/home/julius/.codex")}`,
      );

      // Nothing goes to the unavailable bucket — both drivers are registered.
      const unavailable = yield* registry.listUnavailable;
      expect(unavailable).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("treats an explicit in-config enabled:false as disabling despite the envelope", () =>
    Effect.gen(function* () {
      // Old settings files can carry both flags with conflicting values.
      // The explicit false must win so a user's disable is never undone.
      const staleId = ProviderInstanceId.make("codex_stale");
      const configMap: ProviderInstanceConfigMap = {
        [staleId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          config: makeCodexConfig({ enabled: false }),
        },
      };

      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [CodexDriver],
        configMap,
      });

      const instance = yield* registry.getInstance(staleId);
      expect(instance).toBeDefined();
      expect(instance!.enabled).toBe(false);
      const snapshot = yield* instance!.snapshot.getSnapshot;
      expect(snapshot.enabled).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("runs Codex and Claude readiness probes from configured tilde paths", () =>
    Effect.gen(function* () {
      if (yield* isHostWindows) return;

      const fixtures = yield* makeTildeProviderFixtures();

      const codexId = ProviderInstanceId.make("codex_tilde");
      const claudeId = ProviderInstanceId.make("claude_tilde");
      const configMap: ProviderInstanceConfigMap = {
        [codexId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          environment: [
            {
              name: "T3_CODEX_COLLAB_SCRIPT",
              value: fixtures.codexScriptPath,
              sensitive: false,
            },
          ],
          config: makeCodexConfig({ enabled: true, binaryPath: fixtures.codexBinaryPath }),
        },
        [claudeId]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: true,
          config: makeClaudeConfig({
            enabled: true,
            binaryPath: fixtures.claudeBinaryPath,
            homePath: fixtures.claudeHomePath,
          }),
        },
      };

      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [CodexDriver, ClaudeDriver],
        configMap,
      });
      const codex = yield* registry.getInstance(codexId);
      const claude = yield* registry.getInstance(claudeId);
      expect(codex).toBeDefined();
      expect(claude).toBeDefined();

      const [codexSnapshot, claudeSnapshot] = yield* Effect.all(
        [codex!.snapshot.refresh, claude!.snapshot.refresh],
        { concurrency: "unbounded" },
      );
      expect(codexSnapshot).toMatchObject({ status: "ready", installed: true, version: "0.0.0" });
      expect(claudeSnapshot).toMatchObject({
        status: "ready",
        installed: true,
        version: "2.1.219",
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.live(
    "shadows instances whose driver is not registered in this build without failing boot",
    () =>
      Effect.gen(function* () {
        const codexId = ProviderInstanceId.make("codex_main");
        const ghostId = ProviderInstanceId.make("ghost_main");

        const configMap: ProviderInstanceConfigMap = {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: false,
            config: makeCodexConfig({}),
          },
          [ghostId]: {
            driver: ProviderDriverKind.make("ghostDriver"),
            displayName: "A fork-only driver we don't ship",
            enabled: false,
            config: { arbitrary: "payload", preserved: true },
          },
        };

        const { registry } = yield* makeProviderInstanceRegistry({
          drivers: [CodexDriver],
          configMap,
        });

        const instances = yield* registry.listInstances;
        expect(instances).toHaveLength(1);
        expect(instances[0]!.instanceId).toBe(codexId);

        const unavailable = yield* registry.listUnavailable;
        expect(unavailable).toHaveLength(1);
        const ghost = unavailable[0]!;
        expect(ghost.instanceId).toBe(ghostId);
        expect(ghost.driver).toBe("ghostDriver");
        expect(ghost.availability).toBe("unavailable");
        expect(ghost.unavailableReason).toMatch(/ghostDriver/);
      }).pipe(Effect.provide(testLayer)),
  );
});

describe("ProviderInstanceRegistryLive — all drivers slice", () => {
  // All drivers need `NodeServices` (ChildProcessSpawner + FileSystem +
  // Path). `OpenCodeDriver.create` additionally yields `OpenCodeRuntime`
  // at construction time, so we wire `OpenCodeRuntimeLive` into the stack.
  // `OpenCodeRuntimeLive` bundles its own `NetService.layer` via
  // `Layer.provide`, so the only external requirement it still exposes is
  // `ChildProcessSpawner` — resolved here by piping it through
  // `provideMerge(NodeServices.layer)`.
  //
  // The nested `provideMerge`s read bottom-up: `NodeServices.layer`
  // provides `OpenCodeRuntimeLive`'s deps while keeping its own outputs
  // surfaced; that merged layer then provides `ServerConfig.layerTest`'s
  // `FileSystem` dep while keeping everything else surfaced to the test.
  const infraLayer = OpenCodeRuntimeLive.pipe(Layer.provideMerge(NodeServices.layer));
  const testLayer = AntigravityInstallation.layer.pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "provider-instance-registry-all-drivers-test",
      }),
    ),
    Layer.provideMerge(infraLayer),
    Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(TestHttpClientLive),
    Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
    Layer.provideMerge(ModelManifest.layerTest),
    Layer.provideMerge(CodexResetCredit.layerTest),
  );

  it.live("runs Pi discovery and streaming through the registered driver", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-driver-e2e-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
      );
      const exitLogPath = NodePath.join(tempDir, "exit.log");
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const piBinaryPath = NodePath.join(tempDir, "pi");
      NodeFS.writeFileSync(piBinaryPath, '#!/bin/sh\nprintf "0.85.1\\n"\n', "utf8");
      NodeFS.chmodSync(piBinaryPath, 0o755);
      const bridgePath = makePiWrapper(tempDir, {
        T3_ACP_EXIT_LOG_PATH: exitLogPath,
        T3_ACP_PI_DISCOVERY: "1",
        T3_ACP_EMIT_PI_COMMANDS: "1",
        T3_ACP_EMIT_PI_CONFIG_UPDATE: "1",
        T3_ACP_EMIT_PI_THOUGHT: "1",
        T3_ACP_EMIT_PI_TOOL_EVENTS: "1",
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
      });
      const piId = ProviderInstanceId.make("pi_e2e");
      const piDriverKind = ProviderDriverKind.make("piAgent");
      const { registry } = yield* makeProviderInstanceRegistry<BuiltInDriversEnv>({
        drivers: BUILT_IN_DRIVERS,
        configMap: {
          [piId]: {
            driver: piDriverKind,
            displayName: "Pi compatibility test",
            enabled: true,
            config: makePiConfig({
              enabled: true,
              binaryPath: bridgePath,
              piBinaryPath,
            }),
          },
        },
      });

      const pi = yield* registry.getInstance(piId);
      expect(pi).toBeDefined();
      const snapshot = yield* pi!.snapshot.refresh;
      expect(snapshot).toMatchObject({
        instanceId: piId,
        driver: piDriverKind,
        displayName: "Pi compatibility test",
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        showInteractionModeToggle: false,
      });
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "anthropic/claude-sonnet-4-6",
        "openai/gpt-5.4",
      ]);
      expect(snapshot.slashCommands.map((command) => command.name)).toEqual(["review"]);
      expect(snapshot.skills.map((skill) => skill.name)).toEqual(["browser"]);

      const threadId = ThreadId.make("pi-driver-e2e");
      const events: ProviderRuntimeEvent[] = [];
      const eventFiber = yield* pi!.adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      const session = yield* pi!.adapter.startSession({
        threadId,
        provider: piDriverKind,
        cwd: tempDir,
        runtimeMode: "approval-required",
        modelSelection: {
          instanceId: piId,
          model: "openai/gpt-5.4",
          options: [{ id: "thinkingLevel", value: "xhigh" }],
        },
      });
      expect(session.resumeCursor).toEqual({ schemaVersion: 1, sessionId: "mock-session-1" });
      const turn = yield* pi!.adapter.sendTurn({
        threadId,
        input: "exercise the registered Pi provider",
        attachments: [],
      });
      yield* Effect.yieldNow;

      const turnEvents = events.filter((event) => event.turnId === turn.turnId);
      expect(turnEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "content.delta",
            payload: expect.objectContaining({ streamKind: "reasoning_text" }),
          }),
          expect.objectContaining({
            type: "content.delta",
            itemId: "pi-command-1",
            payload: { streamKind: "command_output", delta: "hello" },
          }),
          expect.objectContaining({ type: "turn.diff.updated", itemId: "pi-edit-1" }),
          expect.objectContaining({ type: "session.configured" }),
          expect.objectContaining({
            type: "turn.completed",
            payload: expect.objectContaining({ state: "completed" }),
          }),
        ]),
      );
      expect(turnEvents.filter((event) => event.type === "turn.completed")).toHaveLength(1);

      const requests = NodeFS.readFileSync(requestLogPath, "utf8");
      expect(requests).toMatch(
        /"value":"openai\/gpt-5\.4","configId":"model"|"configId":"model","value":"openai\/gpt-5\.4"/,
      );
      expect(requests).toMatch(
        /"value":"xhigh","configId":"thought_level"|"configId":"thought_level","value":"xhigh"/,
      );

      yield* pi!.adapter.stopSession(threadId);
      expect(yield* pi!.adapter.hasSession(threadId)).toBe(false);
      expect(NodeFS.readFileSync(exitLogPath, "utf8")).toContain("SIGTERM");
      yield* Fiber.interrupt(eventFiber);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.live("registers the Pi driver and keeps its default instance disabled", () =>
    Effect.gen(function* () {
      const piDriverKind = ProviderDriverKind.make("piAgent");
      const piId = ProviderInstanceId.make("piAgent");
      expect(BUILT_IN_DRIVERS.map((driver) => driver.driverKind)).toContain(piDriverKind);

      const { registry } = yield* makeProviderInstanceRegistry<BuiltInDriversEnv>({
        drivers: BUILT_IN_DRIVERS,
        configMap: {
          [piId]: {
            driver: piDriverKind,
            config: makePiConfig({}),
          },
        },
      });

      expect(yield* registry.listUnavailable).toEqual([]);
      const pi = yield* registry.getInstance(piId);
      expect(pi?.driverKind).toBe(piDriverKind);
      expect(pi?.enabled).toBe(false);
      expect(pi?.adapter.provider).toBe(piDriverKind);
      expect(pi?.textGeneration).toBeDefined();
      const snapshot = yield* pi!.snapshot.getSnapshot;
      expect(snapshot).toMatchObject({
        instanceId: piId,
        driver: piDriverKind,
        enabled: false,
        status: "disabled",
        installed: false,
        message: "Pi Agent is disabled in T3 Code settings.",
      });
      expect(snapshot.continuation?.groupKey).toBe(`${piDriverKind}:instance:${piId}`);
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("boots one instance of every shipped driver from a single config map", () =>
    Effect.gen(function* () {
      const codexId = ProviderInstanceId.make("codex_default");
      const claudeId = ProviderInstanceId.make("claude_default");
      const cursorId = ProviderInstanceId.make("cursor_default");
      const grokId = ProviderInstanceId.make("grok_default");
      const openCodeId = ProviderInstanceId.make("opencode_default");
      const piId = ProviderInstanceId.make("pi_default");

      const codexDriverKind = ProviderDriverKind.make("codex");
      const claudeDriverKind = ProviderDriverKind.make("claudeAgent");
      const cursorDriverKind = ProviderDriverKind.make("cursor");
      const grokDriverKind = ProviderDriverKind.make("grok");
      const openCodeDriverKind = ProviderDriverKind.make("opencode");
      const piDriverKind = ProviderDriverKind.make("piAgent");

      const configMap: ProviderInstanceConfigMap = {
        [codexId]: {
          driver: codexDriverKind,
          displayName: "Codex",
          enabled: false,
          config: makeCodexConfig({ homePath: "/home/julius/.codex" }),
        },
        [claudeId]: {
          driver: claudeDriverKind,
          displayName: "Claude",
          enabled: false,
          config: makeClaudeConfig({
            homePath: "/home/julius/.claude-work",
            launchArgs: "--verbose",
          }),
        },
        [cursorId]: {
          driver: cursorDriverKind,
          displayName: "Cursor",
          enabled: false,
          config: makeCursorConfig({}),
        },
        [grokId]: {
          driver: grokDriverKind,
          displayName: "Grok",
          enabled: false,
          config: makeGrokConfig({}),
        },
        [openCodeId]: {
          driver: openCodeDriverKind,
          displayName: "OpenCode",
          enabled: false,
          config: makeOpenCodeConfig({}),
        },
        [piId]: {
          driver: piDriverKind,
          displayName: "Pi Agent",
          enabled: false,
          config: makePiConfig({}),
        },
      };

      const { registry } = yield* makeProviderInstanceRegistry<BuiltInDriversEnv>({
        drivers: [CodexDriver, ClaudeDriver, PiDriver, CursorDriver, GrokDriver, OpenCodeDriver],
        configMap,
      });

      // Every configured instance must materialize — none downgraded to a
      // shadow snapshot, because every driver in the map is registered.
      const unavailable = yield* registry.listUnavailable;
      expect(unavailable).toEqual([]);

      const instances = yield* registry.listInstances;
      expect(instances).toHaveLength(6);
      expect(instances.map((instance) => instance.instanceId).toSorted()).toEqual(
        [codexId, claudeId, cursorId, grokId, openCodeId, piId].toSorted(),
      );

      // Instance lookup by id resolves each instance to its own bundle —
      // this is how rest-of-server routes turn/session calls in the new
      // model. Each driver's bundle carries its advertised `driverKind`.
      const codex = yield* registry.getInstance(codexId);
      const claude = yield* registry.getInstance(claudeId);
      const cursor = yield* registry.getInstance(cursorId);
      const grok = yield* registry.getInstance(grokId);
      const openCode = yield* registry.getInstance(openCodeId);
      const pi = yield* registry.getInstance(piId);
      expect(codex?.driverKind).toBe(codexDriverKind);
      expect(claude?.driverKind).toBe(claudeDriverKind);
      expect(cursor?.driverKind).toBe(cursorDriverKind);
      expect(grok?.driverKind).toBe(grokDriverKind);
      expect(openCode?.driverKind).toBe(openCodeDriverKind);
      expect(pi?.driverKind).toBe(piDriverKind);
      expect(codex?.displayName).toBe("Codex");
      expect(claude?.displayName).toBe("Claude");
      expect(cursor?.displayName).toBe("Cursor");
      expect(grok?.displayName).toBe("Grok");
      expect(openCode?.displayName).toBe("OpenCode");
      expect(pi?.displayName).toBe("Pi Agent");

      // Every instance owns its own set of closures — no sharing across
      // drivers. `adapter` / `textGeneration` / `snapshot` are all
      // distinct references even when two instances happen to share a
      // trait (e.g. Cursor + others all use a stub-or-real
      // `textGeneration`; they must still be different object values).
      const adapters = [
        codex!.adapter,
        claude!.adapter,
        cursor!.adapter,
        grok!.adapter,
        openCode!.adapter,
        pi!.adapter,
      ];
      expect(new Set(adapters).size).toBe(adapters.length);
      const textGenerations = [
        codex!.textGeneration,
        claude!.textGeneration,
        cursor!.textGeneration,
        grok!.textGeneration,
        openCode!.textGeneration,
        pi!.textGeneration,
      ];
      expect(new Set(textGenerations).size).toBe(textGenerations.length);
      const snapshots = [
        codex!.snapshot,
        claude!.snapshot,
        cursor!.snapshot,
        grok!.snapshot,
        openCode!.snapshot,
        pi!.snapshot,
      ];
      expect(new Set(snapshots).size).toBe(snapshots.length);

      // Snapshots identify themselves by `instanceId` + `driver` so
      // downstream aggregation in `ProviderRegistry` can tell instances
      // apart even when two share a driver. With `enabled: false`, the
      // check short-circuits and we get a disabled/pending snapshot back
      // — that's enough signal to validate the stamping wrapper without
      // spawning real binaries.
      const codexSnapshot = yield* codex!.snapshot.getSnapshot;
      expect(codexSnapshot.instanceId).toBe(codexId);
      expect(codexSnapshot.driver).toBe(codexDriverKind);
      expect(codexSnapshot.enabled).toBe(false);
      expect(codexSnapshot.continuation?.groupKey).toBe(
        `codex:home:${(yield* Path.Path).resolve("/home/julius/.codex")}`,
      );

      const claudeSnapshot = yield* claude!.snapshot.getSnapshot;
      expect(claudeSnapshot.instanceId).toBe(claudeId);
      expect(claudeSnapshot.driver).toBe(claudeDriverKind);
      expect(claudeSnapshot.enabled).toBe(false);
      expect(claudeSnapshot.continuation?.groupKey).toBe(
        `claude:home:${(yield* Path.Path).resolve("/home/julius/.claude-work")}`,
      );

      const cursorSnapshot = yield* cursor!.snapshot.getSnapshot;
      expect(cursorSnapshot.instanceId).toBe(cursorId);
      expect(cursorSnapshot.driver).toBe(cursorDriverKind);
      expect(cursorSnapshot.enabled).toBe(false);
      expect(cursorSnapshot.continuation?.groupKey).toBe(
        `${cursorDriverKind}:instance:${cursorId}`,
      );

      const grokSnapshot = yield* grok!.snapshot.getSnapshot;
      expect(grokSnapshot.instanceId).toBe(grokId);
      expect(grokSnapshot.driver).toBe(grokDriverKind);
      expect(grokSnapshot.enabled).toBe(false);
      expect(grokSnapshot.continuation?.groupKey).toBe(`${grokDriverKind}:instance:${grokId}`);

      const openCodeSnapshot = yield* openCode!.snapshot.getSnapshot;
      expect(openCodeSnapshot.instanceId).toBe(openCodeId);
      expect(openCodeSnapshot.driver).toBe(openCodeDriverKind);
      expect(openCodeSnapshot.enabled).toBe(false);
      expect(openCodeSnapshot.continuation?.groupKey).toBe(
        `${openCodeDriverKind}:instance:${openCodeId}`,
      );

      const piSnapshot = yield* pi!.snapshot.getSnapshot;
      expect(piSnapshot.instanceId).toBe(piId);
      expect(piSnapshot.driver).toBe(piDriverKind);
      expect(piSnapshot.enabled).toBe(false);
      expect(piSnapshot.continuation?.groupKey).toBe(`${piDriverKind}:instance:${piId}`);
    }).pipe(Effect.provide(testLayer)),
  );
});
