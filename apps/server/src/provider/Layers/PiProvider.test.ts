import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { PiSettings } from "@t3tools/contracts";
import {
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  buildInitialPiProviderSnapshot,
  buildPiModelsFromSessionSetup,
  checkPiProviderStatus,
  getPiAcpVersionCompatibilityMessage,
  getPiVersionCompatibilityMessage,
} from "./PiProvider.ts";

const settings = (input: Partial<PiSettings> = {}): PiSettings => ({
  enabled: true,
  binaryPath: "pi-acp",
  piBinaryPath: "pi",
  customModels: [],
  ...input,
});

const setup = {
  sessionId: "pi-session",
  models: {
    currentModelId: "anthropic/claude-sonnet-4-6",
    availableModels: [
      {
        modelId: "anthropic/claude-sonnet-4-6",
        name: "anthropic/Claude Sonnet 4.6",
      },
      { modelId: "openai/gpt-5.4", name: "openai/GPT-5.4" },
    ],
  },
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select" as const,
      currentValue: "anthropic/claude-sonnet-4-6",
      options: [
        { value: "anthropic/claude-sonnet-4-6", name: "anthropic/Claude Sonnet 4.6" },
        { value: "openai/gpt-5.4", name: "openai/GPT-5.4" },
      ],
    },
    {
      id: "thought_level",
      name: "Thinking",
      category: "thought_level",
      type: "select" as const,
      currentValue: "high",
      options: [
        { value: "off", name: "Thinking: off" },
        { value: "low", name: "Thinking: low" },
        { value: "high", name: "Thinking: high" },
        { value: "xhigh", name: "Thinking: xhigh" },
      ],
    },
  ],
};

describe("buildPiModelsFromSessionSetup", () => {
  it("preserves provider-qualified model ids and exposes thinking as a model option", () => {
    const models = buildPiModelsFromSessionSetup(setup);
    expect(models.map(({ slug, name, subProvider }) => ({ slug, name, subProvider }))).toEqual([
      {
        slug: "anthropic/claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        subProvider: "anthropic",
      },
      { slug: "openai/gpt-5.4", name: "GPT-5.4", subProvider: "openai" },
    ]);
    expect(models[0]?.capabilities?.optionDescriptors).toEqual([
      {
        id: "thinkingLevel",
        label: "Thinking",
        type: "select",
        currentValue: "high",
        options: [
          { id: "off", label: "Off" },
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
          { id: "xhigh", label: "Extra High" },
        ],
      },
    ]);
  });
});

describe("Pi compatibility guidance", () => {
  it("accepts supported versions and gives exact update commands for incompatible versions", () => {
    expect(getPiVersionCompatibilityMessage("0.80.4")).toBeUndefined();
    expect(getPiVersionCompatibilityMessage("0.79.9")).toContain(
      "npm install -g @earendil-works/pi-coding-agent",
    );
    expect(getPiAcpVersionCompatibilityMessage("0.0.33")).toBeUndefined();
    expect(getPiAcpVersionCompatibilityMessage("0.0.32")).toContain("npm install -g pi-acp@0.0.33");
  });
});

describe("buildInitialPiProviderSnapshot", () => {
  it.effect("keeps Pi opt-in", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialPiProviderSnapshot(settings({ enabled: false }));
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );
});

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

const makeExecutable = Effect.fn("makePiProviderExecutable")(function* (
  name: string,
  body: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({
    directory: NodeOS.tmpdir(),
    prefix: "pi-provider-probe-",
  });
  const executable = path.join(directory, name);
  yield* fileSystem.writeFileString(executable, body);
  yield* fileSystem.chmod(executable, 0o755);
  return executable;
});

it.layer(NodeServices.layer)("checkPiProviderStatus", (it) => {
  it.effect("reports missing Pi with an install command", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(
        settings({ piBinaryPath: "/definitely/not/installed/pi" }),
      );
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("npm install -g @earendil-works/pi-coding-agent");
    }).pipe(
      Effect.provideService(HostProcessEnvironment, { PATH: process.env.PATH }),
      Effect.provideService(HostProcessExecutablePath, process.execPath),
      Effect.provideService(HostProcessPlatform, "linux"),
    ),
  );

  it.effect("reports an incompatible Pi version before ACP startup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const pi = yield* makeExecutable("pi", '#!/bin/sh\nprintf "0.79.0\\n"\n');
        const snapshot = yield* checkPiProviderStatus(settings({ piBinaryPath: pi }));
        expect(snapshot.installed).toBe(true);
        expect(snapshot.version).toBe("0.79.0");
        expect(snapshot.auth.status).toBe("unknown");
        expect(snapshot.message).toContain("Update Pi to 0.80.4 or newer");
      }),
    ).pipe(
      Effect.provideService(HostProcessEnvironment, { PATH: process.env.PATH }),
      Effect.provideService(HostProcessExecutablePath, process.execPath),
      Effect.provideService(HostProcessPlatform, "linux"),
    ),
  );

  it.effect("reports an incompatible pi-acp version after probing Pi", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const bridge = yield* makeExecutable(
          "pi-acp",
          `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(mockAgentPath)} "$@"\n`,
        );
        const pi = yield* makeExecutable("pi", '#!/bin/sh\nprintf "0.85.1\\n"\n');
        const snapshot = yield* checkPiProviderStatus(
          settings({ binaryPath: bridge, piBinaryPath: pi }),
          {
            ...process.env,
            T3_ACP_PI_DISCOVERY: "1",
            T3_ACP_EMIT_PI_COMMANDS: "1",
            T3_ACP_AGENT_VERSION: "0.0.32",
          },
        );
        expect(snapshot.installed).toBe(true);
        expect(snapshot.version).toBe("0.85.1");
        expect(snapshot.status).toBe("error");
        expect(snapshot.message).toContain("npm install -g pi-acp@0.0.33");
      }),
    ).pipe(
      Effect.provideService(HostProcessEnvironment, { PATH: process.env.PATH }),
      Effect.provideService(HostProcessExecutablePath, process.execPath),
      Effect.provideService(HostProcessPlatform, "linux"),
    ),
  );

  it.effect("discovers authenticated models, thinking levels, commands, and skills", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const bridge = yield* makeExecutable(
          "pi-acp",
          `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(mockAgentPath)} "$@"\n`,
        );
        const pi = yield* makeExecutable("pi", '#!/bin/sh\nprintf "0.85.1\\n"\n');
        const snapshot = yield* checkPiProviderStatus(
          settings({ binaryPath: bridge, piBinaryPath: pi }),
          {
            ...process.env,
            T3_ACP_PI_DISCOVERY: "1",
            T3_ACP_EMIT_PI_COMMANDS: "1",
          },
        );
        expect(snapshot.status).toBe("ready");
        expect(snapshot.auth.status).toBe("authenticated");
        expect(snapshot.showInteractionModeToggle).toBe(false);
        expect(snapshot.models.map((model) => model.slug)).toEqual([
          "anthropic/claude-sonnet-4-6",
          "openai/gpt-5.4",
        ]);
        expect(snapshot.slashCommands).toEqual([
          {
            name: "review",
            description: "Review the current changes",
            input: { hint: "[focus]" },
          },
        ]);
        expect(snapshot.skills).toEqual([
          {
            name: "browser",
            description: "Automate browser tasks",
            shortDescription: "Automate browser tasks",
            path: "/tmp/pi-skills/browser/SKILL.md",
            scope: "user",
            enabled: true,
          },
        ]);
      }),
    ).pipe(
      Effect.provideService(HostProcessEnvironment, { PATH: process.env.PATH }),
      Effect.provideService(HostProcessExecutablePath, process.execPath),
      Effect.provideService(HostProcessPlatform, "linux"),
    ),
  );

  it.effect("reports missing model credentials without discarding configured models", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const bridge = yield* makeExecutable(
          "pi-acp",
          `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(mockAgentPath)} "$@"\n`,
        );
        const pi = yield* makeExecutable("pi", '#!/bin/sh\nprintf "0.85.1\\n"\n');
        const snapshot = yield* checkPiProviderStatus(
          settings({
            binaryPath: bridge,
            piBinaryPath: pi,
            customModels: ["custom/offline-model"],
          }),
          { ...process.env, T3_ACP_PI_DISCOVERY: "1", T3_ACP_PI_AUTH_REQUIRED: "1" },
        );
        expect(snapshot.status).toBe("error");
        expect(snapshot.auth.status).toBe("unauthenticated");
        expect(snapshot.models.map((model) => model.slug)).toEqual(["custom/offline-model"]);
        expect(snapshot.message).toContain("use `/login`");
      }),
    ).pipe(
      Effect.provideService(HostProcessEnvironment, { PATH: process.env.PATH }),
      Effect.provideService(HostProcessExecutablePath, process.execPath),
      Effect.provideService(HostProcessPlatform, "linux"),
    ),
  );
});
