import type {
  ModelCapabilities,
  PiSettings,
  ServerProviderModel,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/schema";
import * as EffectAcpErrors from "effect-acp/errors";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { makePiAcpRuntime, resolvePiAcpSpawnInput } from "../acp/PiAcpSupport.ts";

const PI_PRESENTATION = {
  displayName: "Pi Agent",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;

const PI_INSTALL_COMMAND = "npm install -g @earendil-works/pi-coding-agent";
const PI_ACP_INSTALL_COMMAND = "npm install -g pi-acp@0.0.33";
const PI_MINIMUM_VERSION = "0.80.4";
const PINNED_PI_ACP_VERSION = "0.0.33";
const VERSION_PROBE_TIMEOUT_MS = 4_000;
const ACP_DISCOVERY_TIMEOUT_MS = 15_000;
const COMMAND_DISCOVERY_GRACE_MS = 2_000;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

export interface PiAcpDiscovery {
  readonly bridgeVersion: string | null;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

export function buildInitialPiProviderSnapshot(
  piSettings: PiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = piModelsFromSettings(piSettings.customModels);

    if (!piSettings.enabled) {
      return buildServerProvider({
        presentation: PI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Pi Agent is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Pi and pi-acp availability...",
      },
    });
  });
}

function piModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  discoveredModels: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(discoveredModels, customModels ?? [], EMPTY_CAPABILITIES);
}

function flattenSelectOptions(
  option: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<{ readonly value: string; readonly name: string; readonly description?: string }> {
  if (!option || option.type !== "select") return [];
  return option.options.flatMap((entry) =>
    "value" in entry
      ? [
          {
            value: entry.value.trim(),
            name: entry.name.trim(),
            ...(entry.description?.trim() ? { description: entry.description.trim() } : {}),
          },
        ]
      : entry.options.map((child) => ({
          value: child.value.trim(),
          name: child.name.trim(),
          ...(child.description?.trim() ? { description: child.description.trim() } : {}),
        })),
  );
}

function isThinkingConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  return option.category === "thought_level" || id === "thought_level" || id === "thinking";
}

function piThinkingLabel(value: string, name: string): string {
  const label = name.replace(/^thinking:\s*/i, "").trim();
  switch (label.toLowerCase() || value.toLowerCase()) {
    case "off":
      return "Off";
    case "minimal":
      return "Minimal";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "Extra High";
    case "max":
      return "Max";
    default:
      return label || value;
  }
}

function thinkingOptionsFromSetup(response: PiAcpDiscoverySessionSetup): ReadonlyArray<{
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly isDefault?: boolean;
}> {
  const thinkingOption = response.configOptions?.find(isThinkingConfigOption);
  if (!thinkingOption || thinkingOption.type !== "select") return [];
  const seen = new Set<string>();
  return flattenSelectOptions(thinkingOption).flatMap((entry) => {
    if (!entry.value || seen.has(entry.value)) return [];
    seen.add(entry.value);
    return [
      {
        value: entry.value,
        label: piThinkingLabel(entry.value, entry.name),
        ...(entry.description ? { description: entry.description } : {}),
        ...(thinkingOption.currentValue.trim() === entry.value ? { isDefault: true } : {}),
      },
    ];
  });
}

export function buildPiModelsFromSessionSetup(
  response: PiAcpDiscoverySessionSetup,
): ReadonlyArray<ServerProviderModel> {
  if (!response.models) return [];
  const thinkingOptions = thinkingOptionsFromSetup(response);
  const capabilities =
    thinkingOptions.length === 0
      ? EMPTY_CAPABILITIES
      : createModelCapabilities({
          optionDescriptors: [
            buildSelectOptionDescriptor({
              id: "thinkingLevel",
              label: "Thinking",
              options: thinkingOptions,
            }),
          ],
        });
  const seen = new Set<string>();
  return response.models.availableModels.flatMap((model) => {
    const slug = model.modelId.trim();
    if (!slug || seen.has(slug)) return [];
    seen.add(slug);
    const separator = slug.indexOf("/");
    const provider = separator > 0 ? slug.slice(0, separator) : undefined;
    const rawName = model.name.trim() || slug;
    const name =
      provider && rawName.startsWith(`${provider}/`) ? rawName.slice(separator + 1) : rawName;
    return [
      {
        slug,
        name: name || slug,
        ...(provider ? { subProvider: provider } : {}),
        isCustom: false,
        capabilities,
      } satisfies ServerProviderModel,
    ];
  });
}

type PiAcpDiscoverySessionSetup =
  | EffectAcpSchema.LoadSessionResponse
  | EffectAcpSchema.NewSessionResponse
  | EffectAcpSchema.ResumeSessionResponse;

function mapAcpCommands(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const seen = new Set<string>();
  return commands.flatMap((command) => {
    const name = command.name.trim();
    if (!name || name.startsWith("skill:") || seen.has(name)) return [];
    seen.add(name);
    const description = command.description.trim();
    const hint = command.input?.hint.trim();
    return [
      {
        name,
        ...(description ? { description } : {}),
        ...(hint ? { input: { hint } } : {}),
      } satisfies ServerProviderSlashCommand,
    ];
  });
}

function mapAcpSkills(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
): ReadonlyArray<ServerProviderSkill> {
  const seen = new Set<string>();
  return commands.flatMap((command) => {
    const commandName = command.name.trim();
    if (!commandName.startsWith("skill:")) return [];
    const name = commandName.slice("skill:".length).trim();
    if (!name || seen.has(name)) return [];
    seen.add(name);
    const meta = command._meta;
    const path =
      Predicate.isObject(meta) && typeof meta.path === "string" && meta.path.trim()
        ? meta.path.trim()
        : `pi-acp://skill/${encodeURIComponent(name)}`;
    const scope =
      Predicate.isObject(meta) && typeof meta.scope === "string" && meta.scope.trim()
        ? meta.scope.trim()
        : undefined;
    const description = command.description.trim();
    return [
      {
        name,
        path,
        enabled: true,
        ...(scope ? { scope } : {}),
        ...(description ? { description, shortDescription: description } : {}),
      } satisfies ServerProviderSkill,
    ];
  });
}

export function parsePiVersion(output: string): string | null {
  return parseGenericCliVersion(output);
}

export function getPiVersionCompatibilityMessage(version: string | null): string | undefined {
  if (!version || parseSemver(version) === null) {
    return "T3 Code could not determine the installed Pi version. Run `pi --version`, then update Pi if it is older than 0.80.4.";
  }
  if (compareSemverVersions(version, PI_MINIMUM_VERSION) < 0) {
    return `Pi ${version} is incompatible with pi-acp ${PINNED_PI_ACP_VERSION}. Update Pi to ${PI_MINIMUM_VERSION} or newer with \`${PI_INSTALL_COMMAND}\`.`;
  }
  return undefined;
}

export function getPiAcpVersionCompatibilityMessage(version: string | null): string | undefined {
  if (!version) {
    return `T3 Code could not verify the pi-acp version. Reinstall the supported bridge with \`${PI_ACP_INSTALL_COMMAND}\`.`;
  }
  if (version !== PINNED_PI_ACP_VERSION) {
    return `pi-acp ${version} is incompatible with this T3 Code build. Install ${PINNED_PI_ACP_VERSION} with \`${PI_ACP_INSTALL_COMMAND}\`.`;
  }
  return undefined;
}

const runVersionCommand = Effect.fn("runPiVersionCommand")(function* (
  command: string,
  environment: NodeJS.ProcessEnv,
) {
  const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], { env: environment });
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
    }),
  );
});

const runPiAcpDiscovery = Effect.fn("runPiAcpDiscovery")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runtime = yield* makePiAcpRuntime({
    piSettings,
    environment,
    childProcessSpawner: spawner,
    cwd,
    clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    loadPermissionExtension: false,
    runtimeDirectory: cwd,
    runtimeMode: "full-access",
  });
  const started = yield* runtime.start();
  const commands = yield* runtime.awaitAvailableCommands.pipe(
    Effect.timeoutOption(COMMAND_DISCOVERY_GRACE_MS),
    Effect.flatMap(
      Option.match({
        onNone: () => runtime.getAvailableCommands,
        onSome: Effect.succeed,
      }),
    ),
  );
  return {
    bridgeVersion: started.initializeResult.agentInfo?.version?.trim() || null,
    models: buildPiModelsFromSessionSetup(started.sessionSetupResult),
    slashCommands: mapAcpCommands(commands),
    skills: mapAcpSkills(commands),
  };
}, Effect.scoped);

function buildUnavailablePiSnapshot(input: {
  readonly piSettings: PiSettings;
  readonly checkedAt: string;
  readonly setting: "binaryPath" | "piBinaryPath";
  readonly command: string;
  readonly executable: boolean;
}): ServerProviderDraft {
  const missingPi = input.setting === "piBinaryPath";
  const unavailable = input.executable ? "is not executable" : "was not found";
  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: input.piSettings.enabled,
    checkedAt: input.checkedAt,
    models: piModelsFromSettings(input.piSettings.customModels),
    probe: {
      installed: false,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: missingPi
        ? `Pi command \`${input.command}\` ${unavailable}. Install Pi with \`${PI_INSTALL_COMMAND}\`, or set the Pi binary path in provider settings.`
        : `pi-acp command \`${input.command}\` ${unavailable}. Reinstall the supported bridge with \`${PI_ACP_INSTALL_COMMAND}\`, or set the pi-acp binary path in provider settings.`,
    },
  });
}

function isPiAuthRequired(error: EffectAcpErrors.AcpError): boolean {
  return isAcpRequestError(error) && error.code === -32000;
}

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = piModelsFromSettings(piSettings.customModels);

  if (!piSettings.enabled) {
    return yield* buildInitialPiProviderSnapshot(piSettings);
  }

  const spawnExit = yield* resolvePiAcpSpawnInput(piSettings, cwd, environment).pipe(Effect.exit);
  if (Exit.isFailure(spawnExit)) {
    const failure = Exit.findErrorOption(spawnExit);
    if (
      Option.isSome(failure) &&
      (failure.value._tag === "PiAcpBinaryNotFound" ||
        failure.value._tag === "PiAcpBinaryNotExecutable")
    ) {
      return buildUnavailablePiSnapshot({
        piSettings,
        checkedAt,
        setting: failure.value.setting,
        command: failure.value.command,
        executable: failure.value._tag === "PiAcpBinaryNotExecutable",
      });
    }
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message:
          "T3 Code could not resolve the Pi or pi-acp executable. Check provider binary paths and try again.",
      },
    });
  }

  const resolvedPiCommand = spawnExit.value.env?.PI_ACP_PI_COMMAND ?? piSettings.piBinaryPath;
  const versionResult = yield* runVersionCommand(resolvedPiCommand, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionResult) || Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message:
          "Pi is installed but `pi --version` failed. Run `pi --version`, then update or reinstall Pi.",
      },
    });
  }
  const versionCommand = versionResult.success.value;
  const piVersion = parsePiVersion(`${versionCommand.stdout}\n${versionCommand.stderr}`);
  if (versionCommand.code !== 0) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: piVersion,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi is installed but `pi --version` exited with an error. Update or reinstall Pi.",
      },
    });
  }
  const piCompatibilityMessage = getPiVersionCompatibilityMessage(piVersion);
  if (piCompatibilityMessage) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: piVersion,
        status: "error",
        auth: { status: "unknown" },
        message: piCompatibilityMessage,
      },
    });
  }

  const discoveryExit = yield* runPiAcpDiscovery(piSettings, environment, cwd).pipe(
    Effect.timeoutOption(ACP_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(discoveryExit)) {
    const error = Exit.findErrorOption(discoveryExit);
    if (Option.isSome(error) && isAcpRequestError(error.value) && isPiAuthRequired(error.value)) {
      return buildServerProvider({
        presentation: PI_PRESENTATION,
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version: piVersion,
          status: "error",
          auth: { status: "unauthenticated" },
          message:
            "Pi has no authenticated models. Run `pi`, use `/login` to configure a provider, then refresh Pi Agent status.",
        },
      });
    }
    yield* Effect.logWarning("Pi ACP capability discovery failed", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: piVersion,
        status: "error",
        auth: { status: "unknown" },
        message:
          "Pi and pi-acp are installed, but ACP discovery failed. Run `pi` once to finish setup, then check server logs and refresh provider status.",
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: piVersion,
        status: "error",
        auth: { status: "unknown" },
        message: `Pi ACP discovery timed out after ${ACP_DISCOVERY_TIMEOUT_MS}ms. Run \`pi\` once to finish setup, then refresh provider status.`,
      },
    });
  }

  const discovery = discoveryExit.value.value;
  const bridgeCompatibilityMessage = getPiAcpVersionCompatibilityMessage(discovery.bridgeVersion);
  const models =
    discovery.models.length > 0
      ? piModelsFromSettings(piSettings.customModels, discovery.models)
      : fallbackModels;
  if (bridgeCompatibilityMessage) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      slashCommands: discovery.slashCommands,
      skills: discovery.skills,
      probe: {
        installed: true,
        version: piVersion,
        status: "error",
        auth: { status: discovery.models.length > 0 ? "authenticated" : "unknown" },
        message: bridgeCompatibilityMessage,
      },
    });
  }
  if (discovery.models.length === 0) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      slashCommands: discovery.slashCommands,
      skills: discovery.skills,
      probe: {
        installed: true,
        version: piVersion,
        status: "error",
        auth: { status: "unauthenticated" },
        message:
          "Pi did not advertise any authenticated models. Run `pi`, use `/login` to configure a provider, then refresh Pi Agent status.",
      },
    });
  }

  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    slashCommands: discovery.slashCommands,
    skills: discovery.skills,
    probe: {
      installed: true,
      version: piVersion,
      status: "ready",
      auth: { status: "authenticated" },
    },
  });
});
