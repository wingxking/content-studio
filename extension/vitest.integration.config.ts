import { mergeConfig } from "vitest/config";
import config from "./vitest.config";

const integration = mergeConfig(config, {
  test: {
    include: ["../tests/studio-extension.integration.mts"],
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
integration.test!.include = ["../tests/studio-extension.integration.mts"];
export default integration;
