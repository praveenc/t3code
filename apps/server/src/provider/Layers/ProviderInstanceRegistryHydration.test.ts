import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

it("hydrates the opt-in Pi default settings for later driver registration", () => {
  const configMap = deriveProviderInstanceConfigMap(DEFAULT_SERVER_SETTINGS);
  const piInstance = configMap[ProviderInstanceId.make("piAgent")];

  expect(piInstance).toEqual({
    driver: ProviderDriverKind.make("piAgent"),
    config: DEFAULT_SERVER_SETTINGS.providers.piAgent,
  });
  expect(piInstance?.config).toMatchObject({
    enabled: false,
    binaryPath: "pi-acp",
    piBinaryPath: "pi",
  });
});

it("keeps an explicit Pi instance instead of its legacy settings mirror", () => {
  const piInstanceId = ProviderInstanceId.make("piAgent");
  const explicitPiInstance = {
    driver: ProviderDriverKind.make("piAgent"),
    enabled: true,
    config: { binaryPath: "/opt/bin/pi-acp", piBinaryPath: "/opt/bin/pi" },
  } as const;
  const configMap = deriveProviderInstanceConfigMap({
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      [piInstanceId]: explicitPiInstance,
    },
  });

  expect(configMap[piInstanceId]).toEqual(explicitPiInstance);
});
