// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { PiSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import { makePiTextGeneration } from "./PiTextGeneration.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-pi-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makePiWrapper(dir: string, requestLogPath: string): string {
  const wrapperPath = NodePath.join(dir, "pi-acp");
  NodeFS.writeFileSync(
    wrapperPath,
    [
      "#!/bin/sh",
      'export T3_ACP_PI_DISCOVERY="1"',
      `export T3_ACP_REQUEST_LOG_PATH=${JSON.stringify(requestLogPath)}`,
      `export T3_ACP_PROMPT_RESPONSE_TEXT=${JSON.stringify(
        JSON.stringify({ title: '"Name Pi-backed thread."' }),
      )}`,
      `exec node ${JSON.stringify(mockAgentPath)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  NodeFS.chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}

it.layer(testLayer)("PiTextGeneration", (it) => {
  it.effect("generates text through Pi and applies model options", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-text-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const piBinaryPath = NodePath.join(tempDir, "pi");
      NodeFS.writeFileSync(piBinaryPath, "#!/bin/sh\nexit 0\n", "utf8");
      NodeFS.chmodSync(piBinaryPath, 0o755);
      const textGeneration = yield* makePiTextGeneration(
        decodePiSettings({
          enabled: true,
          binaryPath: makePiWrapper(tempDir, requestLogPath),
          piBinaryPath,
        }),
      );

      const generated = yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "Implement Pi provider support.",
        modelSelection: {
          instanceId: ProviderInstanceId.make("piAgent"),
          model: "openai/gpt-5.4",
          options: [{ id: "thinkingLevel", value: "low" }],
        },
      });
      expect(generated.title).toBe("Name Pi-backed thread.");

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
            request.params?.value === "low",
        ),
      ).toBe(true);
    }).pipe(Effect.scoped),
  );
});
