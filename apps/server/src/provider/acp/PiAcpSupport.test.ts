import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  makePiAcpRuntime,
  PiAcpBinaryNotExecutable,
  PiAcpBinaryNotFound,
  resolvePiAcpSpawnInput,
} from "./PiAcpSupport.ts";

const testLayer = NodeServices.layer;
const nodeExecutable = "/usr/bin/node";
const missingBinaryCases = [
  ["binaryPath", "/missing/pi-acp"],
  ["piBinaryPath", "/missing/pi"],
] as const;
const nonExecutableBinaryCases = [
  ["binaryPath", "custom-pi-acp", "custom-pi"],
  ["piBinaryPath", "custom-pi", "custom-pi-acp"],
] as const;

describe("resolvePiAcpSpawnInput", () => {
  it.effect("uses the pinned bridge and passes the resolved Pi command without shell parsing", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pi-acp-test-" });
      const piPath = path.join(binDir, "pi with spaces");
      yield* fileSystem.writeFileString(piPath, "#!/bin/sh\nexit 0\n");
      yield* fileSystem.chmod(piPath, 0o755);

      const permissionExtensionPath = path.join(binDir, "permission.mjs");
      const spawn = yield* resolvePiAcpSpawnInput(
        { binaryPath: "pi-acp", piBinaryPath: piPath },
        "/tmp/project",
        { CUSTOM_ENV: "kept", PI_ACP_PI_COMMAND: "ignored" },
        permissionExtensionPath,
      );

      expect(spawn.command).toBe(nodeExecutable);
      expect(spawn.args).toHaveLength(3);
      expect(spawn.args[0]).toMatch(/pi-acp[/\\]dist[/\\]index\.js$/);
      expect(spawn.args[1]).toBe("--extension");
      expect(spawn.args[2]).toBe(permissionExtensionPath);
      expect(spawn).toMatchObject({
        cwd: "/tmp/project",
        env: {
          CUSTOM_ENV: "kept",
          PI_ACP_PI_COMMAND: piPath,
        },
      });
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcessEnvironment, { PATH: process.env.PATH }),
      Effect.provideService(HostProcessExecutablePath, nodeExecutable),
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provide(testLayer),
    ),
  );

  it.effect("uses a configured executable pi-acp path", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pi-acp-test-" });
      const bridgePath = path.join(binDir, "custom-pi-acp");
      const piPath = path.join(binDir, "custom-pi");
      for (const executable of [bridgePath, piPath]) {
        yield* fileSystem.writeFileString(executable, "#!/bin/sh\nexit 0\n");
        yield* fileSystem.chmod(executable, 0o755);
      }

      const permissionExtensionPath = path.join(binDir, "permission.mjs");
      const spawn = yield* resolvePiAcpSpawnInput(
        { binaryPath: bridgePath, piBinaryPath: piPath },
        "/tmp/project",
        undefined,
        permissionExtensionPath,
      );
      expect(spawn.command).toBe(bridgePath);
      expect(spawn.args).toEqual(["--extension", permissionExtensionPath]);
      expect(spawn).toMatchObject({
        cwd: "/tmp/project",
        env: { PI_ACP_PI_COMMAND: piPath },
      });
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcessEnvironment, { PATH: "" }),
      Effect.provideService(HostProcessExecutablePath, nodeExecutable),
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provide(testLayer),
    ),
  );

  it.effect("reports each missing configured binary", () =>
    Effect.gen(function* () {
      for (const [setting, missingPath] of missingBinaryCases) {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pi-acp-test-" });
        const executablePath = path.join(binDir, "available");
        yield* fileSystem.writeFileString(executablePath, "#!/bin/sh\nexit 0\n");
        yield* fileSystem.chmod(executablePath, 0o755);

        const error = yield* Effect.flip(
          resolvePiAcpSpawnInput(
            {
              binaryPath: setting === "binaryPath" ? missingPath : executablePath,
              piBinaryPath: setting === "piBinaryPath" ? missingPath : executablePath,
            },
            "/tmp/project",
          ),
        );

        assert.instanceOf(error, PiAcpBinaryNotFound);
        expect(error.setting).toBe(setting);
        expect(error.message).toContain(missingPath);
      }
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcessEnvironment, { PATH: "" }),
      Effect.provideService(HostProcessExecutablePath, nodeExecutable),
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provide(testLayer),
    ),
  );

  it.effect("rejects each configured binary without execute permission", () =>
    Effect.gen(function* () {
      for (const [setting, nonExecutableName, executableName] of nonExecutableBinaryCases) {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pi-acp-test-" });
        const nonExecutablePath = path.join(binDir, nonExecutableName);
        const executablePath = path.join(binDir, executableName);
        yield* fileSystem.writeFileString(nonExecutablePath, "#!/bin/sh\nexit 0\n");
        yield* fileSystem.writeFileString(executablePath, "#!/bin/sh\nexit 0\n");
        yield* fileSystem.chmod(nonExecutablePath, 0o644);
        yield* fileSystem.chmod(executablePath, 0o755);

        const error = yield* Effect.flip(
          resolvePiAcpSpawnInput(
            {
              binaryPath: setting === "binaryPath" ? nonExecutablePath : executablePath,
              piBinaryPath: setting === "piBinaryPath" ? nonExecutablePath : executablePath,
            },
            "/tmp/project",
          ),
        );

        assert.instanceOf(error, PiAcpBinaryNotExecutable);
        expect(error.setting).toBe(setting);
        expect(error.message).toContain(nonExecutablePath);
      }
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcessEnvironment, { PATH: "" }),
      Effect.provideService(HostProcessExecutablePath, nodeExecutable),
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provide(testLayer),
    ),
  );
});

const mockAgentPath = new URL("../../../scripts/acp-mock-agent.ts", import.meta.url).pathname;

function makeControlledRuntime(input?: {
  readonly resumeSessionId?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
  readonly processDiagnosticLogger?: (diagnostic: {
    readonly text: string;
    readonly truncated: boolean;
    readonly invalidUtf8: boolean;
  }) => Effect.Effect<void, never>;
}) {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pi-acp-peer-" });
    const wrapperPath = path.join(binDir, "pi-acp-peer");
    // @effect-diagnostics-next-line preferSchemaOverJson:off - shell script quoting for fixed local paths.
    const nodeCommand = JSON.stringify(process.execPath);
    // @effect-diagnostics-next-line preferSchemaOverJson:off - shell script quoting for fixed local paths.
    const peerCommand = JSON.stringify(mockAgentPath);
    yield* fileSystem.writeFileString(
      wrapperPath,
      `#!/bin/sh\nexec ${nodeCommand} ${peerCommand} "$@"\n`,
    );
    yield* fileSystem.chmod(wrapperPath, 0o755);

    return yield* makePiAcpRuntime({
      childProcessSpawner: spawner,
      piSettings: {
        binaryPath: wrapperPath,
        piBinaryPath: process.execPath,
      },
      environment: {
        ...process.env,
        ...input?.environment,
      },
      cwd: process.cwd(),
      ...(input?.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
      ...(input?.processDiagnosticLogger
        ? { processDiagnosticLogger: input.processDiagnosticLogger }
        : {}),
      clientInfo: { name: "t3-pi-test", version: "0.0.0" },
      runtimeDirectory: binDir,
      runtimeMode: input?.runtimeMode ?? "approval-required",
    });
  }).pipe(
    Effect.provideService(HostProcessEnvironment, process.env),
    Effect.provideService(HostProcessExecutablePath, process.execPath),
  );
}

describe("makePiAcpRuntime", () => {
  it.effect("gives concurrent runtimes isolated Pi argument and extension files", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pi-acp-peer-" });
      const wrapperPath = path.join(binDir, "pi-acp-peer");
      // @effect-diagnostics-next-line preferSchemaOverJson:off - shell script quoting for fixed local paths.
      const nodeCommand = JSON.stringify(process.execPath);
      // @effect-diagnostics-next-line preferSchemaOverJson:off - shell script quoting for fixed local paths.
      const peerCommand = JSON.stringify(mockAgentPath);
      yield* fileSystem.writeFileString(
        wrapperPath,
        `#!/bin/sh\nexec ${nodeCommand} ${peerCommand} "$@"\n`,
      );
      yield* fileSystem.chmod(wrapperPath, 0o755);
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const sharedInput = {
        childProcessSpawner: spawner,
        piSettings: { binaryPath: wrapperPath, piBinaryPath: process.execPath },
        environment: process.env,
        cwd: process.cwd(),
        clientInfo: { name: "t3-pi-test", version: "0.0.0" },
        runtimeDirectory: binDir,
        runtimeMode: "approval-required",
      } as const;

      const firstScope = yield* Scope.make("sequential");
      const secondScope = yield* Scope.make("sequential");
      const [first, second] = yield* Effect.all([
        makePiAcpRuntime(sharedInput).pipe(Effect.provideService(Scope.Scope, firstScope)),
        makePiAcpRuntime(sharedInput).pipe(Effect.provideService(Scope.Scope, secondScope)),
      ]);

      const argsFiles = (yield* fileSystem.readDirectory(binDir)).filter((name) =>
        name.startsWith("t3-pi-args-"),
      );
      const extensionFiles = (yield* fileSystem.readDirectory(binDir)).filter((name) =>
        name.startsWith("t3-pi-permission-extension-"),
      );
      expect(argsFiles).toHaveLength(2);
      expect(new Set(argsFiles).size).toBe(2);
      expect(extensionFiles).toHaveLength(2);
      expect(new Set(extensionFiles).size).toBe(2);

      yield* Effect.all([first.start(), second.start()]);
      yield* Scope.close(firstScope, Exit.void);
      yield* Scope.close(secondScope, Exit.void);
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcessEnvironment, process.env),
      Effect.provideService(HostProcessExecutablePath, process.execPath),
      Effect.provide(testLayer),
    ),
  );

  it.effect("passes the active runtime mode only to conversational Pi sessions", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pi-acp-mode-" });
      const requestLogPath = `${tempDir}/requests.ndjson`;
      const runtime = yield* makeControlledRuntime({
        runtimeMode: "auto",
        environment: { T3_ACP_REQUEST_LOG_PATH: requestLogPath },
      });

      yield* runtime.start();
      const requests = (yield* fileSystem.readFileString(requestLogPath))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { method?: string; runtimeMode?: string });
      expect(requests.find((request) => request.method === "initialize")?.runtimeMode).toBe("auto");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("creates, prompts, cancels, resumes, and shuts down the controlled ACP peer", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pi-acp-life-" });
      const exitLogPath = `${tempDir}/exit.log`;
      const scope = yield* Scope.make("sequential");
      const runtime = yield* makeControlledRuntime({
        environment: {
          T3_ACP_HANG_PROMPT_FOREVER: "1",
          T3_ACP_EXIT_LOG_PATH: exitLogPath,
        },
      }).pipe(Effect.provideService(Scope.Scope, scope));

      const started = yield* runtime.start();
      expect(started.sessionId).toBe("mock-session-1");

      const promptFiber = yield* runtime
        .prompt({ prompt: [{ type: "text", text: "wait" }] })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* runtime.cancel;
      expect(yield* Fiber.join(promptFiber)).toMatchObject({ stopReason: "cancelled" });

      yield* Scope.close(scope, Exit.void);
      expect(yield* fileSystem.readFileString(exitLogPath)).toContain("SIGTERM");

      const resumedScope = yield* Scope.make("sequential");
      const resumed = yield* makeControlledRuntime({ resumeSessionId: started.sessionId }).pipe(
        Effect.provideService(Scope.Scope, resumedScope),
      );
      expect((yield* resumed.start()).sessionId).toBe(started.sessionId);
      yield* Scope.close(resumedScope, Exit.void);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("bounds stderr and keeps typed process failures", () => {
    const diagnostics: Array<{
      readonly text: string;
      readonly truncated: boolean;
      readonly invalidUtf8: boolean;
    }> = [];
    return Effect.gen(function* () {
      const runtime = yield* makeControlledRuntime({
        environment: {
          T3_ACP_STDERR_TEXT: "pi-acp diagnostic ",
          T3_ACP_STDERR_REPEAT: "8192",
          T3_ACP_EXIT_AFTER_INITIALIZE_CODE: "17",
        },
        processDiagnosticLogger: (diagnostic) =>
          Effect.sync(() => {
            diagnostics.push(diagnostic);
          }),
      });

      const error = yield* runtime.start().pipe(Effect.flip);
      expect(error._tag).toBe("AcpProcessExitedError");
      if (error._tag === "AcpProcessExitedError") {
        expect(error.code).toBe(17);
        expect(error.diagnostics?.stderr.length).toBeLessThanOrEqual(64 * 1024 + 12);
        expect(error.diagnostics?.stderr).toContain("pi-acp diagnostic");
        expect(error.diagnostics?.stderrTruncated).toBe(true);
      }
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.truncated).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(testLayer));
  });
});
