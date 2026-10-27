import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = join(fileURLToPath(new URL(".", import.meta.url)));

export default defineConfig({
  test: {
    environment: "jsdom",
    server: {
      // Process @rjsf through vite (not node-externalized) so the AJV
      // vendor-out alias below applies to core's barrel import graph.
      deps: { inline: [/@rjsf/] },
    },
  },
  resolve: {
    alias: {
      // Vendor AJV out of the test module graph (see tests/stubs/validator-ajv8.ts).
      "@rjsf/validator-ajv8": join(here, "tests/stubs/validator-ajv8.ts"),
    },
  },
});
