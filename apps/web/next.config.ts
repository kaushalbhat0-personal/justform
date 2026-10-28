import type { NextConfig } from "next";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// SPIKES.md S1 fallback path, production half: @rjsf/core's barrel statically
// imports @rjsf/validator-ajv8 solely for its getTestRegistry helper (never
// used by FORMOS; Zod is the validation authority). Turbopack/webpack resolve
// every static barrel import, so the specifier must resolve even though the
// code path is dead. Map it to the poisoned stub in @formos/renderer: any
// actual use throws loudly, and no AJV code can ship.
// NOTE: turbopack does not accept absolute Windows paths here, so its alias
// is project-root-relative; webpack gets the absolute equivalent.
const ajvVendorOutRelative = "../../packages/renderer/src/validator-ajv8-stub.ts";
const ajvVendorOutAbsolute = join(here, "..", "..", "packages", "renderer", "src", "validator-ajv8-stub.ts");

const nextConfig: NextConfig = {
  transpilePackages: ["@formos/domain", "@formos/config", "@formos/auth"],
  turbopack: {
    resolveAlias: {
      "@rjsf/validator-ajv8": ajvVendorOutRelative,
    },
  },
  webpack: (config) => {
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      "@rjsf/validator-ajv8": ajvVendorOutAbsolute,
    };
    return config;
  },
  // Security headers baseline (CSP tightened per surface in later phases).
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
