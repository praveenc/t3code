import * as NodeURL from "node:url";

import {
  type PiSettings,
  type ProviderOptionSelection,
  type RuntimeMode,
} from "@t3tools/contracts";
import { getProviderOptionStringSelectionValue } from "@t3tools/shared/model";
import {
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { T3_PI_PERMISSION_EXTENSION_SOURCE } from "./PiPermissionExtension.ts";

const DEFAULT_PI_ACP_COMMAND = "pi-acp";
const DEFAULT_PI_COMMAND = "pi";
const PI_ACP_PI_COMMAND_ENV = "PI_ACP_PI_COMMAND";
const PI_ACP_PI_ARGS_FILE_ENV = "PI_ACP_PI_ARGS_FILE";
const T3_PI_RUNTIME_MODE_ENV = "T3_PI_RUNTIME_MODE";
const PI_ACP_AUTH_METHOD_ID = "pi_terminal_login";
const T3_PI_CANCEL_METHOD = "t3/pi/cancel";
const encodePiArgs = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

const PiAcpBinarySetting = Schema.Literals(["binaryPath", "piBinaryPath"]);
type PiAcpBinarySetting = typeof PiAcpBinarySetting.Type;

export class PiAcpBinaryNotFound extends Schema.TaggedError<PiAcpBinaryNotFound>()(
  "PiAcpBinaryNotFound",
  {
    setting: PiAcpBinarySetting,
    command: Schema.String,
  },
) {
  override get message(): string {
    return `Pi Agent cannot start because ${this.setting} '${this.command}' was not found. Install the binary or set ${this.setting} to an executable path.`;
  }
}

export class PiAcpBinaryNotExecutable extends Schema.TaggedError<PiAcpBinaryNotExecutable>()(
  "PiAcpBinaryNotExecutable",
  {
    setting: PiAcpBinarySetting,
    command: Schema.String,
  },
) {
  override get message(): string {
    return `Pi Agent cannot start because ${this.setting} '${this.command}' is not executable.`;
  }
}

export type PiAcpBinaryError = PiAcpBinaryNotFound | PiAcpBinaryNotExecutable;

type PiAcpLaunchSettings = Partial<Pick<PiSettings, "binaryPath" | "piBinaryPath">>;

interface PiAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly piSettings: PiAcpLaunchSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly loadPermissionExtension?: boolean;
  readonly runtimeDirectory: string;
  readonly runtimeMode: RuntimeMode;
}

function configuredCommand(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

function hasPathSeparator(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

const failForUnresolvedCommand = Effect.fn("piAcp.failForUnresolvedCommand")(function* (
  setting: PiAcpBinarySetting,
  command: string,
): Effect.fn.Return<never, PiAcpBinaryError, FileSystem.FileSystem | Path.Path> {
  if (hasPathSeparator(command)) {
    const fileSystem = yield* FileSystem.FileSystem;
    const stat = yield* fileSystem.stat(command).pipe(Effect.option);
    if (Option.isSome(stat) && stat.value.type === "File") {
      const platform = yield* HostProcessPlatform;
      if (platform !== "win32" && (stat.value.mode & 0o111) === 0) {
        return yield* new PiAcpBinaryNotExecutable({ setting, command });
      }
    }
  }

  return yield* new PiAcpBinaryNotFound({ setting, command });
});

const resolveExecutable = Effect.fn("piAcp.resolveExecutable")(function* (
  setting: PiAcpBinarySetting,
  command: string,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<string, PiAcpBinaryError, FileSystem.FileSystem | Path.Path> {
  return yield* resolveCommandPath(command, { env: environment }).pipe(
    Effect.catchTag("CommandResolutionError", () => failForUnresolvedCommand(setting, command)),
  );
});

const resolvePinnedPiAcpEntry = Effect.fn("piAcp.resolvePinnedPiAcpEntry")(function* () {
  const entryPath = yield* Effect.try({
    try: () => NodeURL.fileURLToPath(import.meta.resolve("pi-acp")),
    catch: () =>
      new PiAcpBinaryNotFound({
        setting: "binaryPath",
        command: DEFAULT_PI_ACP_COMMAND,
      }),
  });
  const fileSystem = yield* FileSystem.FileSystem;
  const stat = yield* fileSystem.stat(entryPath).pipe(Effect.option);
  if (Option.isNone(stat) || stat.value.type !== "File") {
    return yield* new PiAcpBinaryNotFound({
      setting: "binaryPath",
      command: DEFAULT_PI_ACP_COMMAND,
    });
  }
  return entryPath;
});

/**
 * Resolves both configured executables before a session starts. The pinned
 * pi-acp package runs through the current Node-compatible runtime, while a
 * custom bridge path retains the normal direct-process behavior.
 */
export const resolvePiAcpSpawnInput = Effect.fn("piAcp.resolvePiAcpSpawnInput")(function* (
  piSettings: PiAcpLaunchSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  permissionExtensionPath?: string,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSpawnInput,
  PiAcpBinaryError,
  FileSystem.FileSystem | Path.Path
> {
  const binaryPath = configuredCommand(piSettings?.binaryPath, DEFAULT_PI_ACP_COMMAND);
  const piBinaryPath = configuredCommand(piSettings?.piBinaryPath, DEFAULT_PI_COMMAND);
  const effectiveEnvironment = { ...(yield* HostProcessEnvironment), ...environment };
  const executablePath = yield* HostProcessExecutablePath;
  const resolvedPiBinary = yield* resolveExecutable(
    "piBinaryPath",
    piBinaryPath,
    effectiveEnvironment,
  );

  const bridge =
    binaryPath === DEFAULT_PI_ACP_COMMAND
      ? {
          command: executablePath,
          args: [yield* resolvePinnedPiAcpEntry()],
        }
      : {
          command: yield* resolveExecutable("binaryPath", binaryPath, effectiveEnvironment),
          args: [] as string[],
        };

  return {
    command: bridge.command,
    args: [
      ...bridge.args,
      ...(permissionExtensionPath ? ["--extension", permissionExtensionPath] : []),
    ],
    cwd,
    env: {
      ...environment,
      [PI_ACP_PI_COMMAND_ENV]: resolvedPiBinary,
    },
  };
});

export interface PiAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly step: "set-model" | "set-thinking-level";
}

interface PiAcpModelSelectionRuntime {
  readonly setModel: (model: string) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

export function applyPiAcpModelSelection<E>(input: {
  readonly runtime: PiAcpModelSelectionRuntime;
  readonly model: string | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (context: PiAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    const model = input.model?.trim();
    if (model) {
      yield* input.runtime
        .setModel(model)
        .pipe(Effect.mapError((cause) => input.mapError({ cause, step: "set-model" })));
    }

    const thinkingLevel = getProviderOptionStringSelectionValue(input.selections, "thinkingLevel");
    if (thinkingLevel) {
      yield* input.runtime
        .setConfigOption("thought_level", thinkingLevel)
        .pipe(Effect.mapError((cause) => input.mapError({ cause, step: "set-thinking-level" })));
    }
  });
}

export const makePiAcpRuntime = Effect.fn("makePiAcpRuntime")(function* (
  input: PiAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError | PiAcpBinaryError,
  Crypto.Crypto | FileSystem.FileSystem | Path.Path | Scope.Scope
> {
  const fileSystem = yield* FileSystem.FileSystem;
  let permissionExtensionPath: string | undefined;
  if (input.loadPermissionExtension !== false) {
    yield* fileSystem
      .makeDirectory(input.runtimeDirectory, { recursive: true })
      .pipe(
        Effect.mapError(
          (cause) => new EffectAcpErrors.AcpSpawnError({ command: input.runtimeDirectory, cause }),
        ),
      );
    permissionExtensionPath = yield* fileSystem
      .makeTempFileScoped({
        directory: input.runtimeDirectory,
        prefix: "t3-pi-permission-extension-",
        suffix: ".mjs",
      })
      .pipe(
        Effect.tap((extensionPath) =>
          fileSystem.writeFileString(extensionPath, T3_PI_PERMISSION_EXTENSION_SOURCE),
        ),
        Effect.mapError(
          (cause) => new EffectAcpErrors.AcpSpawnError({ command: input.runtimeDirectory, cause }),
        ),
      );
  }
  const spawn = yield* resolvePiAcpSpawnInput(
    input.piSettings,
    input.cwd,
    input.environment,
    permissionExtensionPath,
  );
  let effectiveSpawn: AcpSessionRuntime.AcpSpawnInput = {
    ...spawn,
    env: {
      ...spawn.env,
      ...(permissionExtensionPath ? { [T3_PI_RUNTIME_MODE_ENV]: input.runtimeMode } : {}),
    },
  };
  if (permissionExtensionPath) {
    const argsFile = yield* fileSystem
      .makeTempFileScoped({
        directory: input.runtimeDirectory,
        prefix: "t3-pi-args-",
        suffix: ".json",
      })
      .pipe(
        Effect.mapError(
          (cause) => new EffectAcpErrors.AcpSpawnError({ command: input.runtimeDirectory, cause }),
        ),
      );
    const extensionArgIndex = spawn.args.lastIndexOf("--extension");
    const encodedArgs = yield* encodePiArgs(spawn.args.slice(extensionArgIndex)).pipe(
      Effect.mapError((cause) => new EffectAcpErrors.AcpSpawnError({ command: argsFile, cause })),
    );
    yield* fileSystem
      .writeFileString(argsFile, encodedArgs)
      .pipe(
        Effect.mapError((cause) => new EffectAcpErrors.AcpSpawnError({ command: argsFile, cause })),
      );
    effectiveSpawn = {
      ...effectiveSpawn,
      args: spawn.args.slice(0, extensionArgIndex),
      env: { ...effectiveSpawn.env, [PI_ACP_PI_ARGS_FILE_ENV]: argsFile },
    };
  }
  const acpContext = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...input,
      spawn: effectiveSpawn,
      authMethodId: PI_ACP_AUTH_METHOD_ID,
      ...(configuredCommand(input.piSettings?.binaryPath, DEFAULT_PI_ACP_COMMAND) ===
      DEFAULT_PI_ACP_COMMAND
        ? { cancelRequestMethod: T3_PI_CANCEL_METHOD }
        : {}),
    }).pipe(
      Layer.provide(
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
      ),
    ),
  );
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
    Effect.provide(acpContext),
  );
});
